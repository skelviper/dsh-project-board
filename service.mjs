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
import { maintenancePath, boardFileReferences, discoverBoardContent, archiveBoardContent } from './maintenance-files.mjs';
import { maintenanceState, maintenanceScanRoots, mergeBoardContent, recordBoardDeletion, assertNotDeleted, addMaintenanceConflict, resolveMaintenanceChoice, maintenancePrompt } from './maintenance.mjs';

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
  const external = patches.some(patch => ['team', 'threads'].includes(patch.path[0]) || (patch.path.length === 0 && ((!patch.beforeExists && (patch.after?.team || patch.after?.threads?.length)) || (!patch.afterExists && (patch.before?.team || patch.before?.threads?.length)))));
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
  constructor({ ctx, store = new BoardStore(), logger = console, wakeAssistant }) {
    this.ctx = ctx;
    this.store = store;
    this.logger = logger;
    this.cache = new Map(); // workspacePath -> {mtimeMs, board}
    this.maintenanceRuns = new Map();
    this.wakeAssistant = wakeAssistant;
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
    const result = await this.store.mutate(workspace.path, async () => {
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
      assertNotDeleted(board, action, body);
      this.checkFieldBase(board, action, body);
      this.applyCommand(board, action, body, actor);
      const deletion = recordBoardDeletion(board, before, action, body);
      if (action === 'undo_change' && board.maintenance) {
        const restored = before.changes.find(row => row.id === body.changeId)?.targets || [];
        const collections = { node: 'nodes', task: 'tasks', todo: 'todos' };
        for (const d of board.maintenance.deletions) if (!d.paths.length && board[collections[d.targetType]].some(row => row.id === d.targetId) && restored.some(t => t.type === d.targetType && t.id === d.targetId)) d.status = 'restored';
      }
      board.revision += 1;
      board.updatedAt = isoNow();
      board.updatedBy = actor;
      const normalized = normalizeBoard(board, { workspacePath: workspace.path, title: workspace.title });
      const change = makeHistory(before, plain(normalized), action, actor);
      if (action === 'undo_change') change.summary = `撤销：${before.changes.find(row => row.id === body.changeId)?.summary || body.changeId}`;
      if (deletion?.paths.length) {
        change.summary = `删除并登记归档：${deletion.title}`;
        change.undo = { status: 'unavailable', reason: '此删除含实体归档；不能只撤销看板JSON。文件与删除决定保存在维护记录中。', undoneAt: '', undoneBy: '' };
        change.patches = []; change.guards = [];
      }
      normalized.changes.unshift(change);
      if (commandId) normalized.applied.unshift({ id: commandId, revision: normalized.revision, at: normalized.updatedAt, changeId: change.id });
      const committed = normalizeBoard(normalized, { workspacePath: workspace.path, title: workspace.title });
      await this.store.write(workspace.path, committed);
      this.cache.set(workspace.path, { mtimeMs: Date.now(), board: committed });
      this.store.notify({ workspacePath: workspace.path, board: committed, actor });
      return { board: committed, workspace, changeId: change.id, lastChange: committed.changes[0], archiveQueued: Boolean(deletion?.paths.length) };
    });
    if ((['delete_node', 'delete_task', 'delete_todo'].includes(action) || result.archiveQueued) && !result.replayed) {
      await this.processArchives(workspace.path);
      result.board = (await this.store.read(workspace.path)).board;
    }
    return result;
  }

  // 编辑器传入草稿起点，避免SSE刷新后的旧草稿用新revision覆盖他人的同字段修改。
  checkFieldBase(board, action, body) {
    if (!body.base || !action.startsWith('upsert_')) return;
    const type = action.slice(7), collections = { node: 'nodes', task: 'tasks', todo: 'todos' };
    if (!collections[type]) return;
    const proposal = body[type], row = board[collections[type]].find(r => r.id === proposal?.id);
    if (!row) throw new BoardError('FIELD_CONFLICT', '编辑中的条目已删除，请保留草稿并刷新查看', 409);
    const visit = (base, current, patch, keys = []) => {
      for (const key of Object.keys(base)) {
        if (['__proto__', 'constructor', 'prototype', 'id'].includes(key) || !Object.hasOwn(patch || {}, key)) continue;
        if (key === 'delivery' && typeof base[key] === 'object' && base[key] && typeof patch[key] === 'object') { visit(base[key], current?.[key], patch[key], [...keys, key]); continue; }
        if (isDeepStrictEqual(current?.[key], base[key]) || isDeepStrictEqual(current?.[key], patch[key])) continue;
        if (isDeepStrictEqual(patch[key], base[key])) { delete patch[key]; continue; }
        throw new BoardError('FIELD_CONFLICT', '这个字段已在别处更新；你的草稿已保留，请对照最新内容后决定', 409, { field: [...keys, key].join('.'), base: base[key], current: current?.[key], proposed: patch[key] });
      }
    };
    visit(body.base, row, proposal);
  }

  async commitMaintenance(workspace, mutate, { commandId, operation = 'maintenance' } = {}) {
    return this.store.mutate(workspace.path, async () => {
      const loaded = await this.store.read(workspace.path);
      if (!loaded.exists) throw new BoardError('BOARD_NOT_FOUND', '该 workspace 还没有看板', 404);
      const board = loaded.board, before = plain(board);
      const extra = await mutate(board) || {};
      board.revision += 1; board.updatedAt = isoNow(); board.updatedBy = 'maintenance';
      const normalized = normalizeBoard(board, { workspacePath: workspace.path, title: workspace.title });
      const change = makeHistory(before, plain(normalized), operation, 'maintenance');
      change.summary = extra.summary || '看板维护';
      normalized.changes.unshift(change);
      if (commandId) normalized.applied.unshift({ id: commandId, revision: normalized.revision, at: normalized.updatedAt, changeId: change.id });
      const committed = normalizeBoard(normalized, { workspacePath: workspace.path, title: workspace.title });
      await this.store.write(workspace.path, committed);
      this.store.notify({ workspacePath: workspace.path, board: committed, actor: 'maintenance' });
      return { ...extra, board: committed };
    });
  }

  async maintain({ workspacePath, operation = 'scan', commandId, roots, paths, message, conflictId, choice, actor = 'user' } = {}) {
    const workspace = this.findWorkspace(workspacePath);
    if (!['state', 'scan', 'notify', 'resolve', 'configure', 'dismiss'].includes(operation)) throw new BoardError('INVALID_OPERATION', '未知维护操作');
    if (commandId != null && (typeof commandId !== 'string' || !commandId || commandId.length > 120)) throw new BoardError('INVALID_COMMAND_ID', 'commandId 无效');
    const loaded = await this.store.read(workspace.path);
    if (!loaded.exists) throw new BoardError('BOARD_NOT_FOUND', '该 workspace 还没有看板', 404);
    if (operation === 'state') return { board: loaded.board, summary: loaded.board.maintenance?.lastSummary || '尚未扫描' };
    if (commandId && loaded.board.applied.some(r => r.id === commandId)) return { board: loaded.board, summary: loaded.board.maintenance?.lastSummary || '', replayed: true };
    if (operation === 'configure') {
      if (!Array.isArray(roots) || roots.length > 30 || roots.some(p => typeof p !== 'string' || (p !== '.' && !maintenancePath(workspace.path, p)))) throw new BoardError('INVALID_ROOTS', '请提供项目内检查目录列表，留空使用已关联活动范围');
      return this.commitMaintenance(workspace, board => { const m = maintenanceState(board); m.scope = roots.length ? 'custom' : 'linked'; m.roots = [...new Set(roots)]; return { summary: roots.length ? '已保存额外检查范围' : '已恢复已关联活动范围' }; }, { commandId });
    }
    if (operation === 'dismiss') {
      if (!Array.isArray(paths) || !paths.length || paths.length > 200) throw new BoardError('INVALID_CANDIDATES', '请明确列出要忽略的候选路径');
      return this.commitMaintenance(workspace, board => {
        const m = maintenanceState(board);
        const selected = paths.map(p => m.candidates.find(c => c.path === p && c.status !== 'linked'));
        if (selected.some(c => !c)) throw new BoardError('CANDIDATE_CHANGED', '候选线索已改变，请重读维护状态', 409);
        for (const candidate of selected) { candidate.status = 'dismissed'; candidate.reason = asString(message, LIMITS.short, '与当前项目任务无关，仅保留盘上资料。'); }
        return { summary: `已将 ${selected.length} 条无关资料线索标记为忽略；盘上文件未改动。` };
      }, { commandId });
    }
    if (operation === 'resolve') {
      const conflict = loaded.board.maintenance?.conflicts.find(c => c.id === conflictId && c.status === 'open');
      if (conflict?.kind === 'field') {
        const check = await discoverBoardContent(workspace.path, { roots: [conflict.sourcePath] });
        if (!check.candidates.some(c => c.path === conflict.sourcePath && c.fingerprint === conflict.fingerprint)) throw new BoardError('CONFLICT_CHANGED', '盘上来源已变化，请先更新看板后再决定', 409);
      }
      const result = await this.commitMaintenance(workspace, board => { resolveMaintenanceChoice(board, conflictId, choice); return { summary: '已保存维护决定' }; }, { commandId });
      await this.processArchives(workspace.path);
      return { ...result, board: (await this.store.read(workspace.path)).board };
    }
    if (operation === 'notify' && actor === `agent:${loaded.board.assistant?.sessionId}`) throw new BoardError('SELF_NOTIFY', '维护助手不能通知自己再次唤醒；请直接完成当前维护', 409);
    const running = this.maintenanceRuns.get(workspace.path);
    if (running) {
      // prompt一旦封口，后到通知必须排下一波；不能把未投递的附言标记为已处理。
      if (running.phase !== 'scanning') {
        await running.promise;
        return this.maintain({ workspacePath, operation, commandId, roots, paths, message, conflictId, choice, actor });
      }
      if (commandId) running.requestIds.add(commandId);
      running.dirty = true;
      if (operation === 'notify') { running.notify = true; running.message = [...new Set([running.message, asString(message, 4000)].filter(Boolean))].join('\n').slice(0, 8000); }
      return { ...(await running.promise), coalesced: true };
    }
    const run = { phase: 'scanning', notify: operation === 'notify', message: asString(message, 4000), requestIds: new Set(commandId ? [commandId] : []), promise: null };
    this.maintenanceRuns.set(workspace.path, run);
    run.promise = (async () => {
      const discovery = await discoverBoardContent(workspace.path, { roots: maintenanceScanRoots(loaded.board) });
      let result = await this.commitMaintenance(workspace, board => mergeBoardContent(board, discovery), { commandId: operation === 'scan' ? commandId : undefined, operation: 'maintenance_scan' });
      if (run.dirty) {
        run.phase = 'finishing';
        run.dirty = false;
        const latest = (await this.store.read(workspace.path)).board;
        const supplement = await discoverBoardContent(workspace.path, { roots: maintenanceScanRoots(latest) });
        result = await this.commitMaintenance(workspace, board => mergeBoardContent(board, supplement), { operation: 'maintenance_scan' });
      }
      await this.processArchives(workspace.path);
      result.board = (await this.store.read(workspace.path)).board;
      run.phase = 'notifying';
      if (run.notify) {
        if (!this.wakeAssistant) throw new BoardError('WAKE_UNAVAILABLE', '磁盘同步已保存；当前宿主未提供维护会话唤醒能力', 503);
        const sessionId = result.board.assistant?.sessionId;
        if (!sessionId) throw new BoardError('ASSISTANT_NOT_READY', '磁盘同步已保存；请先打开看板 Lead 会话，再通知维护', 409);
        await this.wakeAssistant({ sessionId, workspacePath: workspace.path, prompt: maintenancePrompt(result.board, run.message), requestIds: run.requestIds.size ? [...run.requestIds] : [newId('notification')] });
        result = await this.commitMaintenance(workspace, board => {
          for (const id of run.requestIds) board.applied.unshift({ id, revision: board.revision + 1, at: isoNow() });
          return { summary: result.summary + ' 已通知看板 Lead。', sessionId };
        });
      }
      return result;
    })();
    try { return await run.promise; }
    finally { if (this.maintenanceRuns.get(workspace.path) === run) this.maintenanceRuns.delete(workspace.path); }
  }

  async processArchives(workspacePath) {
    const workspace = this.findWorkspace(workspacePath);
    const loaded = await this.store.read(workspacePath);
    if (!loaded.board?.maintenance?.deletions.some(d => d.status === 'pending')) return;
    await this.commitMaintenance(workspace, async board => {
      const m = maintenanceState(board);
      for (const deletion of m.deletions.filter(d => d.status === 'pending')) {
        try {
          if (!deletion.ownershipConfirmed) throw new BoardError('ARCHIVE_CONFLICT', '尚未确认这些链接和产物属于本条目的独占归档范围。请核对路径后选择重试归档，或保留文件。', 409);
          if (deletion.wasActive) throw new BoardError('ARCHIVE_CONFLICT', '条目删除前仍在进行中，或作业终态未核实；文件已保留。确认作业结束后再重试归档。', 409);
          const agents = this.ctx.agents?.list?.() || [];
          const live = agents.filter(a => a.status === 'running' && (deletion.sessionIds.includes(a.id) || (a.id !== board.assistant?.sessionId && a.session?.header?.cwd && (a.session.header.cwd === workspacePath || a.session.header.cwd.startsWith(workspacePath + path.sep)))));
          if (live.length) throw new BoardError('ARCHIVE_CONFLICT', '项目仍有运行中的会话，暂缓移动对应文件；会话结束后可重试归档。', 409);
          // idle会话仍可有后台作业；读取真实registry而不消费输出或激活会话。
          const sessionIds = new Set([...deletion.sessionIds, ...agents.filter(a => a.session?.header?.cwd && (a.session.header.cwd === workspacePath || a.session.header.cwd.startsWith(workspacePath + path.sep))).map(a => a.id), ...board.tasks.flatMap(t => (t.threads || []).map(s => s.sessionId)), ...board.todos.flatMap(t => (t.threads || []).map(s => s.sessionId))]);
          if (!this.ctx.jobs?.list) throw new BoardError('ARCHIVE_CONFLICT', '当前无法核实关联会话的后台作业终态，文件已保留。', 409);
          if (this.ctx.jobs.list().some(j => ['running', 'stopping'].includes(j.status))) throw new BoardError('ARCHIVE_CONFLICT', '存在未归属会话的运行中后台作业，无法排除文件占用，暂缓归档。', 409);
          for (const id of sessionIds) {
            const jobs = this.ctx.jobs.list(id);
            if (jobs.some(j => ['running', 'stopping'].includes(j.status))) throw new BoardError('ARCHIVE_CONFLICT', '项目仍有运行中或正在停止的后台作业，文件已保留；终态后可重试归档。', 409);
          }
          const references = boardFileReferences(board).filter(ref => {
            // 顶层主题的目录导航不把其每个子项目都声明为共享输入；来源/产物/所有权仍受保护。
            const node = ref.targetType === 'node' && board.nodes.find(n => n.id === ref.targetId);
            const navigation = node?.kind === 'theme' && ref.role === 'link' && !(node.ownedPaths || []).some(p => maintenancePath(workspacePath, p) === ref.path) && (node.links || []).some(link => link.kind === 'dir' && maintenancePath(workspacePath, link.path) === ref.path);
            return !(navigation && deletion.paths.some(p => p.startsWith(ref.path + '/')) && !deletion.paths.includes(ref.path));
          });
          deletion.receipt = await archiveBoardContent(workspacePath, { operationId: deletion.id, paths: deletion.paths, references });
          deletion.status = 'archived'; deletion.reason = '独占内容已归档，原路径和SHA清单保存在归档回执中。';
        } catch (error) {
          deletion.status = 'needs_decision'; deletion.reason = String(error?.message || error).slice(0, 4000);
          addMaintenanceConflict(board, { id: 'archive-' + deletion.id, kind: 'archive', targetType: deletion.targetType, targetId: deletion.targetId, title: deletion.title, deletionId: deletion.id, sourcePath: deletion.paths[0] || '', current: deletion.reason, proposed: '', fingerprint: '' },
            `归档需要决定：「${deletion.title}」。${deletion.reason} 路径：${deletion.paths.slice(0, 8).join('、')}。可保留文件，或在消除占用/共享引用后重试归档。`);
        }
      }
      return { summary: '已处理删除归档队列；不确定项已保留原件并登记需决定。' };
    }, { operation: 'maintenance_archive' });
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
        if (decision.status === 'answered' && board.maintenance?.conflicts.some(c => c.decisionId === decision.id && c.status === 'open')) throw new BoardError('MAINTENANCE_DECISION', '此问题会应用维护变更，请在维护记录中选择对应选项，或让看板Lead用project_board_maintain resolve处理', 409);
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
