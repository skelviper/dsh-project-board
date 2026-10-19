// Board service: workspace validation, revision CAS, command application,
// Agent Teams dispatch, and board digests for agent prompts.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pbShortSummary } from './board-model.js';
import {
  BoardError,
  LIMITS,
  asString,
  createEmptyBoard,
  newId,
  normalizeBoard,
  boardDigest,
} from './schema.mjs';
import { BoardStore } from './store.mjs';

const ACTIONS = new Set([
  'create_board', 'rename_board',
  'upsert_node', 'delete_node',
  'upsert_edge', 'delete_edge',
  'upsert_task', 'delete_task',
  'upsert_todo', 'delete_todo', 'move_todo',
  'save_positions',
  'add_note', 'delete_note',
  'upsert_decision', 'delete_decision',
  'bind_thread', 'unbind_thread', 'bind_assistant', 'unbind_assistant',
  'undo_change',
]);

function isoNow() {
  return new Date().toISOString();
}

function requireObject(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BoardError('INVALID_INPUT', `${name} 必须是对象`);
  }
  return value;
}

function findNode(board, id) {
  const node = board.nodes.find((row) => row.id === id);
  if (!node) throw new BoardError('NODE_NOT_FOUND', `节点不存在：${id}`, 404);
  return node;
}

function findTask(board, id) {
  const task = board.tasks.find((row) => row.id === id);
  if (!task) throw new BoardError('TASK_NOT_FOUND', `任务不存在：${id}`, 404);
  return task;
}

function findTodo(board, id) {
  const todo = board.todos.find((row) => row.id === id);
  if (!todo) throw new BoardError('TODO_NOT_FOUND', `待办不存在：${id}`, 404);
  return todo;
}

// 删除任务时同步清理其待办、备注和存活任务的依赖，节点删除复用同一规则。
function removeTasks(board, taskIds) {
  const todoIds = new Set(board.todos.filter((row) => taskIds.has(row.taskId)).map((row) => row.id));
  board.tasks = board.tasks.filter((row) => !taskIds.has(row.id));
  for (const task of board.tasks) task.blockedBy = task.blockedBy.filter((id) => !taskIds.has(id));
  board.todos = board.todos.filter((row) => !todoIds.has(row.id));
  board.notes = board.notes.filter((row) =>
    !(row.targetType === 'task' && taskIds.has(row.targetId)) &&
    !(row.targetType === 'todo' && todoIds.has(row.targetId)));
}

// 绑定命令必须明确选择一种条目，避免两个 ID 同时出现时误改目标。
function findThreadTarget(board, body) {
  const isTask = Object.hasOwn(body, 'taskId');
  const isTodo = Object.hasOwn(body, 'todoId');
  if (isTask === isTodo) throw new BoardError('INVALID_INPUT', 'taskId 和 todoId 必须且只能提供一个');
  const key = isTask ? 'taskId' : 'todoId';
  const id = asString(body[key], LIMITS.id);
  if (!id) throw new BoardError('INVALID_INPUT', `${key} 不能为空`);
  return { target: isTask ? findTask(board, id) : findTodo(board, id), isTask };
}

function nextOrder(rows, taskId) {
  const scoped = rows.filter((row) => row.taskId === taskId);
  return scoped.length ? Math.max(...scoped.map((row) => row.order || 0)) + 1 : 0;
}

const HISTORY_COLLECTIONS = ['nodes', 'edges', 'tasks', 'todos', 'notes', 'decisions'];
const HISTORY_TYPES = { nodes: 'node', edges: 'edge', tasks: 'task', todos: 'todo', notes: 'note', decisions: 'decision' };
const UNDO_ACTIONS = new Set(['save_positions', 'upsert_node', 'delete_node', 'upsert_edge', 'delete_edge', 'upsert_task', 'delete_task', 'upsert_todo', 'delete_todo', 'move_todo', 'add_note', 'delete_note', 'upsert_decision', 'delete_decision']);
const ACTION_LABELS = { save_positions: '调整节点位置', upsert_node: '编辑节点', delete_node: '删除节点', upsert_edge: '编辑连线', delete_edge: '删除连线', upsert_task: '编辑任务', delete_task: '删除任务', upsert_todo: '编辑待办', delete_todo: '删除待办', move_todo: '调整待办顺序', add_note: '添加备注', delete_note: '删除备注', upsert_decision: '编辑决策', delete_decision: '删除决策', bind_thread: '绑定会话', unbind_thread: '解绑会话', bind_assistant: '绑定看板助手', unbind_assistant: '解绑看板助手', rename_board: '重命名看板', dispatch: '派发团队任务', undo_change: '撤销变更' };
const plain = value => JSON.parse(JSON.stringify(value));

// 仅记录变动的字段；时间戳是副作用，不阻挡同条目其他字段的独立编辑。
function historyPatches(before, after) {
  const patches = [];
  for (const collection of HISTORY_COLLECTIONS) {
    const oldRows = new Map(before[collection].map(row => [row.id, row]));
    const newRows = new Map(after[collection].map(row => [row.id, row]));
    for (const id of new Set([...oldRows.keys(), ...newRows.keys()])) {
      const previous = oldRows.get(id), current = newRows.get(id);
      const add = (path, oldValue, newValue, beforeExists, afterExists) => patches.push({ collection, id, path, beforeExists, afterExists, ...(path.length ? { rowCreatedAt: current.createdAt } : {}), ...(beforeExists ? { before: oldValue } : {}), ...(afterExists ? { after: newValue } : {}) });
      if (!previous || !current) {
        add([], previous, current, Boolean(previous), Boolean(current));
        patches[patches.length - 1].index = (previous ? before : after)[collection].findIndex(row => row.id === id);
        continue;
      }
      for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
        if (key === 'updatedAt' || isDeepStrictEqual(previous[key], current[key])) continue;
        if (key === 'delivery' && previous.delivery && current.delivery) {
          for (const field of new Set([...Object.keys(previous.delivery), ...Object.keys(current.delivery)])) {
            if (!isDeepStrictEqual(previous.delivery[field], current.delivery[field])) add([key, field], previous.delivery[field], current.delivery[field], Object.hasOwn(previous.delivery, field), Object.hasOwn(current.delivery, field));
          }
        } else add([key], previous[key], current[key], Object.hasOwn(previous, key), Object.hasOwn(current, key));
      }
    }
  }
  return patches;
}

// 新建/删除整个条目时还需锁定关联成员，防止撤销连带丢失后来新增的工作。
function historyRelations(board, collection, id) {
  const relations = [];
  const add = (name, row, field) => relations.push(`${name}:${row.id}:${field}`);
  if (collection === 'nodes') {
    for (const row of board.edges) if (row.from === id || row.to === id) add('edges', row, row.from === id ? 'from' : 'to');
    for (const row of board.tasks) if (row.nodeId === id) add('tasks', row, 'nodeId');
    for (const row of board.decisions) if (row.nodeId === id) add('decisions', row, 'nodeId');
  }
  if (collection === 'tasks') {
    for (const row of board.todos) if (row.taskId === id) add('todos', row, 'taskId');
    for (const row of board.tasks) if (row.blockedBy.includes(id)) add('tasks', row, 'blockedBy');
  }
  const type = HISTORY_TYPES[collection];
  for (const row of board.notes) if (row.targetType === type && row.targetId === id) add('notes', row, 'targetId');
  return relations.sort();
}

function historyTargets(before, after, patches) {
  const targets = new Map();
  const oldRows = Object.fromEntries(HISTORY_COLLECTIONS.map(name => [name, new Map(before[name].map(row => [row.id, row]))]));
  const rows = Object.fromEntries(HISTORY_COLLECTIONS.map(name => [name, new Map([...before[name], ...after[name]].map(row => [row.id, row]))]));
  const parents = new Map();
  for (const edge of [...before.edges, ...after.edges]) if (edge.kind === 'contains') {
    if (!parents.has(edge.to)) parents.set(edge.to, new Set());
    parents.get(edge.to).add(edge.from);
  }
  const add = (collection, id) => {
    const type = HISTORY_TYPES[collection], key = `${type}:${id}`;
    if (!type || !id || targets.has(key)) return;
    const row = rows[collection].get(id);
    targets.set(key, { type, id, title: pbShortSummary(row?.title || row?.label || row?.question || row?.text || id, 120) });
    if (collection === 'nodes') for (const parent of parents.get(id) || []) add('nodes', parent);
    for (const version of [oldRows[collection].get(id), row].filter(Boolean)) {
      if (version.nodeId) add('nodes', version.nodeId);
      if (version.taskId && collection === 'todos') add('tasks', version.taskId);
      if (collection === 'edges') { add('nodes', version.from); add('nodes', version.to); }
      if (collection === 'notes') add(Object.keys(HISTORY_TYPES).find(name => HISTORY_TYPES[name] === version.targetType), version.targetId);
    }
  };
  for (const patch of patches) add(patch.collection, patch.id);
  return [...targets.values()];
}

function historyGuard(before, after, patch) {
  const parents = new Map();
  const remember = (collection, id) => {
    const row = after[collection]?.find(item => item.id === id);
    if (row) parents.set(`${collection}:${id}`, { collection, id, createdAt: row.createdAt });
  };
  for (const board of [before, after]) {
    const row = board[patch.collection].find(item => item.id === patch.id);
    if (!row) continue;
    if (row.nodeId) remember('nodes', row.nodeId);
    if (patch.collection === 'todos') remember('tasks', row.taskId);
    if (patch.collection === 'edges') { remember('nodes', row.from); remember('nodes', row.to); }
    if (patch.collection === 'tasks') for (const id of row.blockedBy) remember('tasks', id);
    if (patch.collection === 'notes') remember(Object.keys(HISTORY_TYPES).find(name => HISTORY_TYPES[name] === row.targetType), row.targetId);
  }
  return { collection: patch.collection, id: patch.id, checkRelations: patch.path.length === 0, relations: patch.path.length === 0 ? historyRelations(after, patch.collection, patch.id) : [], parents: [...parents.values()] };
}

function makeHistory(before, after, action, actor, patches = historyPatches(before, after)) {
  const targets = historyTargets(before, after, patches);
  const external = patches.some(patch => ['team', 'threads'].includes(patch.path[0]) || (patch.path.length === 0 && !patch.beforeExists && (patch.after?.team || patch.after?.threads?.length)));
  const available = UNDO_ACTIONS.has(action) && patches.length > 0 && !external;
  return {
    id: newId('change'), at: isoNow(), actor, action,
    summary: `${ACTION_LABELS[action] || action}${targets.length ? `：${targets[0].title}` : ''}${new Set(patches.map(patch => `${patch.collection}:${patch.id}`)).size > 1 ? '（含关联条目）' : ''}`,
    targets,
    undo: { status: available ? 'available' : 'unavailable', reason: available ? '' : external ? '会话或团队关联变更不支持撤销' : patches.length ? '此操作不支持撤销' : '没有可撤销的字段变动', undoneAt: '', undoneBy: '' },
    patches: available ? patches : [],
    guards: available ? [...new Map(patches.map(patch => [`${patch.collection}:${patch.id}`, historyGuard(before, after, patch)])).values()] : [],
  };
}

function invalidRelations(board) {
  const invalid = new Set(), nodes = new Set(board.nodes.map(row => row.id)), tasks = new Set(board.tasks.map(row => row.id)), todos = new Set(board.todos.map(row => row.id));
  for (const row of board.edges) for (const field of ['from', 'to']) if (!nodes.has(row[field])) invalid.add(`edge:${row.id}:${field}:${row[field]}`);
  for (const row of board.tasks) {
    if (!nodes.has(row.nodeId)) invalid.add(`task:${row.id}:nodeId:${row.nodeId}`);
    for (const id of row.blockedBy) if (!tasks.has(id)) invalid.add(`task:${row.id}:blockedBy:${id}`);
  }
  for (const row of board.todos) if (!tasks.has(row.taskId)) invalid.add(`todo:${row.id}:taskId:${row.taskId}`);
  for (const row of board.decisions) if (row.nodeId && !nodes.has(row.nodeId)) invalid.add(`decision:${row.id}:${row.nodeId}`);
  for (const row of board.notes) {
    const known = { node: nodes, task: tasks, todo: todos }[row.targetType];
    if (known && !known.has(row.targetId)) invalid.add(`note:${row.id}:${row.targetType}:${row.targetId}`);
  }
  return invalid;
}

function undoHistory(board, changeId, actor) {
  const change = board.changes.find(row => row.id === changeId);
  if (!change) throw new BoardError('CHANGE_NOT_FOUND', '变更记录不存在或已超出保留范围', 404);
  if (change.undo.status !== 'available') throw new BoardError('UNDO_UNAVAILABLE', change.undo.status === 'undone' ? '这条变更已撤销' : change.undo.reason || '这条变更不可撤销', 409);
  const conflict = () => { throw new BoardError('UNDO_CONFLICT', '受影响字段或关联已被更新，无法安全撤销；请刷新后查看当前内容', 409, { changeId }); };
  for (const patch of change.patches) {
    const row = board[patch.collection].find(item => item.id === patch.id);
    if (patch.path.length && row?.createdAt !== patch.rowCreatedAt) conflict();
    let parent = row;
    for (const key of patch.path.slice(0, -1)) parent = parent?.[key];
    const key = patch.path.at(-1), exists = patch.path.length ? Boolean(parent && Object.hasOwn(parent, key)) : Boolean(row);
    const value = patch.path.length ? parent?.[key] : row;
    if (exists !== patch.afterExists || (exists && !isDeepStrictEqual(plain(value), patch.after))) conflict();
  }
  for (const guard of change.guards) {
    if (guard.checkRelations !== false && !isDeepStrictEqual(historyRelations(board, guard.collection, guard.id), guard.relations)) conflict();
    for (const parent of guard.parents || []) if (board[parent.collection].find(row => row.id === parent.id)?.createdAt !== parent.createdAt) conflict();
  }
  const candidate = plain(board), now = isoNow();
  for (const patch of [...change.patches].reverse()) {
    const rows = candidate[patch.collection], index = rows.findIndex(row => row.id === patch.id);
    if (patch.path.length === 0) {
      if (patch.beforeExists) {
        if (index >= 0) rows[index] = plain(patch.before);
        else rows.splice(Math.max(0, Math.min(rows.length, patch.index || 0)), 0, plain(patch.before));
      } else if (index >= 0) rows.splice(index, 1);
    } else {
      if (index < 0) conflict();
      let parent = rows[index];
      for (const key of patch.path.slice(0, -1)) parent = parent[key];
      const key = patch.path.at(-1);
      if (patch.beforeExists) parent[key] = plain(patch.before); else delete parent[key];
      if (Object.hasOwn(rows[index], 'updatedAt')) rows[index].updatedAt = now;
    }
  }
  // 只拒绝本次撤销新产生的悬空关系；既有无关历史数据不成为全局锁。
  const previousInvalid = invalidRelations(board);
  for (const issue of invalidRelations(candidate)) if (!previousInvalid.has(issue)) conflict();
  const normalized = normalizeBoard(candidate);
  for (const collection of HISTORY_COLLECTIONS) if (normalized[collection].length !== candidate[collection].length) conflict();
  for (const collection of HISTORY_COLLECTIONS) board[collection] = candidate[collection];
  change.undo = { status: 'undone', reason: '', undoneAt: now, undoneBy: actor };
  return change;
}

export class BoardService {
  constructor({ ctx, store = new BoardStore(), logger = console }) {
    this.ctx = ctx;
    this.store = store;
    this.logger = logger;
    this.cache = new Map(); // workspacePath -> {mtimeMs, board}
  }

  // ---- workspace resolution -------------------------------------------------

  registryWorkspaces() {
    const list = this.ctx.workspaceRegistry?.list?.() ?? [];
    return list.map((workspace) => ({ workspaceId: String(workspace.id), path: workspace.path, title: workspace.title }));
  }

  findWorkspace(workspacePath) {
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
      throw new BoardError('INVALID_WORKSPACE', 'workspacePath 必须是绝对路径');
    }
    const normalized = path.resolve(workspacePath);
    const workspaces = this.registryWorkspaces();
    const exact = workspaces.find((row) => row.path === normalized);
    if (exact) return exact;
    throw new BoardError('WORKSPACE_NOT_REGISTERED', `不是已注册的 workspace：${normalized}`, 404);
  }

  /** Resolve the workspace root for an agent from its session cwd. */
  workspaceForAgent(agent) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new BoardError('NO_SESSION_CWD', '当前会话没有可用的工作目录');
    }
    const normalized = path.resolve(cwd);
    const workspaces = this.registryWorkspaces();
    const matches = workspaces.filter((row) => normalized === row.path || normalized.startsWith(row.path + path.sep));
    if (matches.length) return matches.sort((a, b) => b.path.length - a.path.length)[0];
    // Unregistered directories remain usable for the tool; the board simply
    // lives in that directory. The HTTP surface stays strict.
    return { workspaceId: '', path: normalized, title: path.basename(normalized), unregistered: true };
  }

  // ---- read/write -----------------------------------------------------------

  async read(workspacePath) {
    return this.store.read(workspacePath);
  }

  async state(workspacePath) {
    const workspace = this.findWorkspace(workspacePath);
    const { exists, board } = await this.store.read(workspace.path);
    if (!exists) return { workspace, exists: false, board: null };
    this.cache.set(workspace.path, { mtimeMs: Date.now(), board });
    return { workspace, exists: true, board };
  }

  async loadForDigest(workspacePath) {
    if (!workspacePath) return null;
    const { exists, board } = await this.store.read(workspacePath).catch(() => ({ exists: false }));
    return exists ? board : null;
  }

  async create({ workspacePath, title, actor = 'user' }) {
    const workspace = this.findWorkspace(workspacePath);
    return this.store.mutate(workspace.path, async () => {
      const current = await this.store.read(workspace.path);
      if (current.exists) return { board: current.board, created: false, workspace };
      const board = createEmptyBoard({ workspacePath: workspace.path, title: title || workspace.title });
      board.revision = 1;
      board.updatedBy = actor;
      await this.store.write(workspace.path, board);
      this.store.notify({ workspacePath: workspace.path, board, actor, created: true });
      return { board, created: true, workspace };
    });
  }

  /**
   * Apply one command with optimistic concurrency. `actor` is a free-form
   * attribution such as `user`, `agent:<sessionId>`, or `lead:<sessionId>`.
   */
  async command({ workspacePath, expectedRevision, commandId, action, input, actor = 'user', allowCreate = false }) {
    if (!ACTIONS.has(action)) throw new BoardError('UNKNOWN_ACTION', `未知操作：${action}`);
    const workspace = this.findWorkspace(workspacePath);
    const body = input === undefined ? {} : requireObject(input, 'input');
    const expected = Number.isFinite(expectedRevision) ? Math.trunc(expectedRevision) : null;
    if (commandId !== undefined && commandId !== null && (typeof commandId !== 'string' || !commandId || commandId.length > 120)) {
      throw new BoardError('INVALID_COMMAND_ID', 'commandId 无效');
    }
    return this.store.mutate(workspace.path, async () => {
      const current = await this.store.read(workspace.path);
      if (!current.exists) {
        if (action !== 'create_board' && !allowCreate) {
          throw new BoardError('BOARD_NOT_FOUND', '该 workspace 还没有看板，请先创建', 404);
        }
        const board = createEmptyBoard({ workspacePath: workspace.path, title: body.title || workspace.title });
        board.updatedBy = actor;
        await this.store.write(workspace.path, board);
        this.store.notify({ workspacePath: workspace.path, board, actor });
        return { board, workspace, created: true };
      }
      const board = current.board;
      const applied = commandId && board.applied.find((row) => row.id === commandId);
      if (applied) {
        const lastChange = board.changes.find(row => row.id === applied.changeId);
        return { board, workspace, replayed: true, changeId: applied.changeId, lastChange };
      }
      if (expected !== null && expected !== board.revision) {
        throw new BoardError('STALE_REVISION', `看板已被更新（当前 revision ${board.revision}，提交 ${expected}），请重载后再试`, 409, { revision: board.revision });
      }
      const before = plain(board);
      this.applyCommand(board, action, body, actor);
      board.revision += 1;
      board.updatedAt = isoNow();
      board.updatedBy = actor;
      const normalized = normalizeBoard(board, { workspacePath: workspace.path, title: workspace.title });
      const change = makeHistory(before, plain(normalized), action, actor);
      if (action === 'undo_change') change.summary = `撤销：${before.changes.find(row => row.id === body.changeId)?.summary || body.changeId}`;
      normalized.changes.unshift(change);
      if (commandId) normalized.applied.unshift({ id: commandId, revision: normalized.revision, at: normalized.updatedAt, changeId: change.id });
      const committed = normalizeBoard(normalized, { workspacePath: workspace.path, title: workspace.title });
      await this.store.write(workspace.path, committed);
      this.cache.set(workspace.path, { mtimeMs: Date.now(), board: committed });
      this.store.notify({ workspacePath: workspace.path, board: committed, actor });
      return { board: committed, workspace, changeId: change.id, lastChange: committed.changes[0] };
    });
  }

  applyCommand(board, action, body, actor) {
    const now = isoNow();
    switch (action) {
      case 'undo_change': {
        undoHistory(board, asString(body.changeId, LIMITS.id), actor);
        return;
      }
      case 'create_board':
      case 'rename_board': {
        if (action === 'rename_board') board.title = asString(body.title, LIMITS.title, board.title);
        return;
      }
      case 'upsert_node': {
        const node = requireObject(body.node, 'node');
        if (!node.id) {
          const created = normalizeBoard({ ...board, nodes: [...board.nodes, { ...node, createdAt: now, updatedAt: now }] });
          board.nodes = created.nodes;
          return;
        }
        const existing = board.nodes.find((row) => row.id === node.id);
        if (existing) Object.assign(existing, node, { updatedAt: now });
        else {
          const created = normalizeBoard({ ...board, nodes: [...board.nodes, { ...node, createdAt: now, updatedAt: now }] });
          board.nodes = created.nodes;
        }
        return;
      }
      case 'delete_node': {
        const id = asString(body.id, LIMITS.id);
        findNode(board, id);
        board.nodes = board.nodes.filter((row) => row.id !== id);
        board.edges = board.edges.filter((row) => row.from !== id && row.to !== id);
        const taskIds = new Set(board.tasks.filter((row) => row.nodeId === id).map((row) => row.id));
        removeTasks(board, taskIds);
        board.decisions = board.decisions.filter((row) => row.nodeId !== id);
        board.notes = board.notes.filter((row) => row.targetType !== 'node' || row.targetId !== id);
        return;
      }
      case 'upsert_edge': {
        const edge = requireObject(body.edge, 'edge');
        const existing = edge.id && board.edges.find((row) => row.id === edge.id);
        const merged = { ...existing, ...edge };
        const from = asString(merged.from, LIMITS.id);
        const to = asString(merged.to, LIMITS.id);
        findNode(board, from);
        findNode(board, to);
        if (from === to) throw new BoardError('INVALID_INPUT', '连线不能指向自身');
        if (existing) {
          Object.assign(existing, edge);
        } else {
          const created = normalizeBoard({ ...board, edges: [...board.edges, { ...edge, createdAt: now }] });
          board.edges = created.edges;
        }
        return;
      }
      case 'delete_edge': {
        const id = asString(body.id, LIMITS.id);
        if (!board.edges.some((row) => row.id === id)) throw new BoardError('EDGE_NOT_FOUND', `连线不存在：${id}`, 404);
        board.edges = board.edges.filter((row) => row.id !== id);
        return;
      }
      case 'upsert_task': {
        const task = requireObject(body.task, 'task');
        const existing = task.id && board.tasks.find((row) => row.id === task.id);
        const merged = { ...existing, ...task };
        findNode(board, asString(merged.nodeId, LIMITS.id));
        if (existing) {
          const delivery = Object.hasOwn(task, 'delivery') ? { ...existing.delivery, ...requireObject(task.delivery, 'delivery') } : existing.delivery;
          Object.assign(existing, task, { delivery, updatedAt: now });
        } else {
          const created = normalizeBoard({ ...board, tasks: [...board.tasks, { ...task, createdAt: now, updatedAt: now }] });
          board.tasks = created.tasks;
        }
        return;
      }
      case 'delete_task': {
        const id = asString(body.id, LIMITS.id);
        findTask(board, id);
        removeTasks(board, new Set([id]));
        return;
      }
      case 'upsert_todo': {
        const todo = requireObject(body.todo, 'todo');
        const existing = todo.id && board.todos.find((row) => row.id === todo.id);
        const merged = { ...existing, ...todo };
        const normalizedTaskId = asString(merged.taskId, LIMITS.id);
        findTask(board, normalizedTaskId);
        if (existing) {
          const delivery = Object.hasOwn(todo, 'delivery') ? { ...existing.delivery, ...requireObject(todo.delivery, 'delivery') } : existing.delivery;
          Object.assign(existing, todo, { delivery, updatedAt: now });
        } else {
          const created = normalizeBoard({
            ...board,
            todos: [...board.todos, { ...todo, order: todo.order ?? nextOrder(board.todos, normalizedTaskId), createdAt: now, updatedAt: now }],
          });
          board.todos = created.todos;
        }
        return;
      }
      case 'delete_todo': {
        const id = asString(body.id, LIMITS.id);
        findTodo(board, id);
        board.todos = board.todos.filter((row) => row.id !== id);
        board.notes = board.notes.filter((row) => row.targetType !== 'todo' || row.targetId !== id);
        return;
      }
      case 'move_todo': {
        const id = asString(body.id, LIMITS.id);
        const todo = findTodo(board, id);
        const targetId = asString(body.beforeId, LIMITS.id);
        const siblings = board.todos.filter((row) => row.taskId === todo.taskId && row.id !== todo.id).sort((a, b) => a.order - b.order);
        const index = targetId ? siblings.findIndex((row) => row.id === targetId) : siblings.length;
        siblings.splice(index < 0 ? siblings.length : index, 0, todo);
        siblings.forEach((row, order) => { row.order = order; });
        return;
      }
      case 'save_positions': {
        const positions = Array.isArray(body.positions) ? body.positions.slice(0, LIMITS.positionsPerCommand) : [];
        if (!positions.length) throw new BoardError('INVALID_INPUT', 'positions 不能为空');
        const byId = new Map(board.nodes.map((node) => [node.id, node]));
        for (const row of positions) {
          if (!row || typeof row.id !== 'string') continue;
          const node = byId.get(row.id);
          if (!node || !Number.isFinite(row.x) || !Number.isFinite(row.y)) continue;
          node.x = Math.max(-1e6, Math.min(1e6, row.x));
          node.y = Math.max(-1e6, Math.min(1e6, row.y));
          node.updatedAt = now;
        }
        return;
      }
      case 'add_note': {
        const text = asString(body.text, LIMITS.description);
        if (!text) throw new BoardError('INVALID_INPUT', '备注内容不能为空');
        const targetType = ['board', 'node', 'task', 'todo'].includes(body.targetType) ? body.targetType : 'board';
        const targetId = asString(body.targetId, LIMITS.id);
        board.notes.push({
          id: newId('m'),
          targetType,
          targetId,
          text,
          author: asString(body.author, LIMITS.short, actor),
          createdAt: now,
        });
        board.notes = board.notes.slice(-LIMITS.notes);
        return;
      }
      case 'delete_note': {
        const id = asString(body.id, LIMITS.id);
        if (!board.notes.some((row) => row.id === id)) throw new BoardError('NOTE_NOT_FOUND', `备注不存在：${id}`, 404);
        board.notes = board.notes.filter((row) => row.id !== id);
        return;
      }
      case 'upsert_decision': {
        const decision = requireObject(body.decision, 'decision');
        if (decision.id && board.decisions.some((row) => row.id === decision.id)) {
          const existing = board.decisions.find((row) => row.id === decision.id);
          Object.assign(existing, decision, { updatedAt: now });
        } else {
          const created = normalizeBoard({ ...board, decisions: [...board.decisions, { ...decision, createdAt: now, updatedAt: now }] });
          board.decisions = created.decisions;
        }
        return;
      }
      case 'delete_decision': {
        const id = asString(body.id, LIMITS.id);
        if (!board.decisions.some((row) => row.id === id)) throw new BoardError('DECISION_NOT_FOUND', `决策项不存在：${id}`, 404);
        board.decisions = board.decisions.filter((row) => row.id !== id);
        return;
      }
      case 'bind_thread': {
        const { target } = findThreadTarget(board, body);
        const sessionId = asString(body.sessionId, 200);
        if (!sessionId) throw new BoardError('INVALID_INPUT', 'sessionId 不能为空');
        const threads = target.threads || [];
        // 重复绑定不改写已有会话元数据；新增绑定也不推进任务或待办状态。
        if (threads.some((row) => row.sessionId === sessionId)) return;
        if (threads.length >= LIMITS.threads) throw new BoardError('THREAD_LIMIT_REACHED', `每个条目最多绑定 ${LIMITS.threads} 个会话`, 409);
        target.threads = [...threads, { sessionId, title: asString(body.title, LIMITS.short), createdAt: now, updatedAt: now }];
        target.updatedAt = now;
        return;
      }
      case 'unbind_thread': {
        const { target, isTask } = findThreadTarget(board, body);
        const sessionId = asString(body.sessionId, 200);
        // 仅旧 todoId 且省略 sessionId 的调用保留清空语义。
        if (!sessionId && (isTask || Object.hasOwn(body, 'sessionId'))) throw new BoardError('INVALID_INPUT', 'sessionId 不能为空');
        target.threads = sessionId ? (target.threads || []).filter((row) => row.sessionId !== sessionId) : [];
        target.updatedAt = now;
        return;
      }
      case 'bind_assistant': {
        const sessionId = asString(body.sessionId, 200);
        if (!sessionId) throw new BoardError('INVALID_INPUT', 'sessionId 不能为空');
        board.assistant = { sessionId, createdAt: board.assistant?.createdAt || now, updatedAt: now };
        return;
      }
      case 'unbind_assistant': {
        board.assistant = undefined;
        return;
      }
      default:
        throw new BoardError('UNKNOWN_ACTION', `未知操作：${action}`);
    }
  }

  // ---- Agent Teams ----------------------------------------------------------

  teamTasksFor(agent) {
    if (!agent || !this.ctx.agentTeams) return [];
    const membership = this.ctx.agentTeams.tryMembership(agent);
    if (!membership) return [];
    try {
      return this.ctx.agentTeams.listTasks(agent);
    } catch {
      return [];
    }
  }

  async digestFor(agent, workspace = this.workspaceForAgent(agent)) {
    const board = await this.loadForDigest(workspace.path);
    if (!board) return { workspace, board: null, digest: '' };
    const teamTasks = this.teamTasksFor(agent);
    return { workspace, board, digest: boardDigest(board, { workspacePath: workspace.path, teamTasks, sessionId: agent?.id }) };
  }

  /** Create one team task per board task/todo item and link it back. */
  async dispatch({ workspacePath, expectedRevision, commandId, leadSessionId, items, actor = 'user' }) {
    const workspace = this.findWorkspace(workspacePath);
    let agent = this.ctx.agents?.get?.(leadSessionId);
    if (!agent) {
      // A bound Lead session that has no live agent yet: resume it on demand so the
      // dispatch button works right after a board is opened.
      try {
        await this.ctx.agents.resume({ resumeSessionId: leadSessionId });
        agent = this.ctx.agents.get(leadSessionId);
      } catch {
        agent = undefined;
      }
    }
    if (!agent) throw new BoardError('LEAD_NOT_LIVE', '指定的 Lead 会话当前不在线，无法派发；先在看板对话里发一条消息激活它', 409);
    const membership = this.ctx.agentTeams?.tryMembership?.(agent);
    if (!membership || membership.role !== 'lead') throw new BoardError('NOT_TEAM_LEAD', '该会话不是 Agent Team 的 Lead', 409);
    const requested = Array.isArray(items) ? items.slice(0, 50) : [];
    if (!requested.length) throw new BoardError('INVALID_INPUT', 'items 不能为空');
    return this.store.mutate(workspace.path, async () => {
      const current = await this.store.read(workspace.path);
      if (!current.exists) throw new BoardError('BOARD_NOT_FOUND', '该 workspace 还没有看板', 404);
      const board = current.board;
      if (Number.isFinite(expectedRevision) && Math.trunc(expectedRevision) !== board.revision) {
        throw new BoardError('STALE_REVISION', `看板已被更新（当前 revision ${board.revision}）`, 409, { revision: board.revision });
      }
      if (commandId && board.applied.some((row) => row.id === commandId)) return { board, workspace, replayed: true, created: [] };
      const before = plain(board);
      const created = [];
      for (const item of requested) {
        if (!item || typeof item !== 'object') continue;
        let subject;
        let description;
        let writeScopes = [];
        let task = null;
        let todo = null;
        if (item.todoId) {
          todo = findTodo(board, asString(item.todoId, LIMITS.id));
          task = findTask(board, todo.taskId);
          const node = findNode(board, task.nodeId);
          subject = `[看板] ${todo.title}`;
          description = [
            `项目看板 · ${workspace.title}`,
            `节点：${node.title}（${node.id}）`,
            `任务：${task.title}（${task.id}）`,
            `待办：${todo.title}（${todo.id}）`,
            todo.acceptance ? `验收：${todo.acceptance}` : '',
            `看板文件：${workspace.path}/board/project-board.json`,
            '完成后用 team_task_update 标记 complete，并在看板上把该待办标为 done。',
          ].filter(Boolean).join('\n');
        } else if (item.taskId) {
          task = findTask(board, asString(item.taskId, LIMITS.id));
          const node = findNode(board, task.nodeId);
          subject = `[看板] ${node.title} / ${task.title}`;
          description = [
            `项目看板 · ${workspace.title}`,
            `节点：${node.title}（${node.id}）`,
            `任务：${task.title}（${task.id}）`,
            task.acceptance ? `验收：${task.acceptance}` : '',
            task.artifacts?.length ? `产物：${task.artifacts.map((row) => row.path).join('、')}` : '',
            `看板文件：${workspace.path}/board/project-board.json`,
            '完成后用 team_task_update 标记 complete，并在看板上把该任务标为 done。',
          ].filter(Boolean).join('\n');
          writeScopes = task.writeScopes || [];
        } else {
          continue;
        }
        const target = todo ?? task;
        if (target.team && target.team.leadSessionId === leadSessionId) continue; // already dispatched
        const view = await this.ctx.agentTeams.createTask(agent, {
          subject: subject.slice(0, 200),
          description: description.slice(0, 16384),
          blockedBy: [],
          writeScopes,
        });
        target.team = {
          leadSessionId,
          taskId: String(view.id),
          ownerName: view.ownerName,
          status: view.status,
          revision: view.revision,
          linkedAt: nowIso(),
        };
        if (todo) {
          todo.status = todo.status === 'todo' ? 'doing' : todo.status;
        }
        created.push({ taskId: task.id, todoId: todo?.id, teamTaskId: String(view.id) });
      }
      board.revision += 1;
      board.updatedAt = isoNow();
      board.updatedBy = actor;
      const normalized = normalizeBoard(board, { workspacePath: workspace.path, title: workspace.title });
      const change = makeHistory(before, plain(normalized), 'dispatch', actor);
      change.undo.reason = '团队派发会创建外部任务，不支持撤销';
      normalized.changes.unshift(change);
      if (commandId) normalized.applied.unshift({ id: commandId, revision: normalized.revision, at: normalized.updatedAt, changeId: change.id });
      const committed = normalizeBoard(normalized, { workspacePath: workspace.path, title: workspace.title });
      await this.store.write(workspace.path, committed);
      this.store.notify({ workspacePath: workspace.path, board: committed, actor });
      return { board: committed, workspace, created, changeId: change.id, lastChange: committed.changes[0] };
    });
  }
}

function nowIso() {
  return new Date().toISOString();
}
