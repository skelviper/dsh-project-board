// Board service: workspace validation, revision CAS, command application,
// Agent Teams dispatch, and board digests for agent prompts.
import path from 'node:path';
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
      if (commandId && board.applied.some((row) => row.id === commandId)) {
        return { board, workspace, replayed: true };
      }
      if (expected !== null && expected !== board.revision) {
        throw new BoardError('STALE_REVISION', `看板已被更新（当前 revision ${board.revision}，提交 ${expected}），请重载后再试`, 409, { revision: board.revision });
      }
      this.applyCommand(board, action, body, actor);
      board.revision += 1;
      board.updatedAt = isoNow();
      board.updatedBy = actor;
      if (commandId) {
        board.applied.unshift({ id: commandId, revision: board.revision, at: board.updatedAt });
        board.applied = board.applied.slice(0, LIMITS.applied);
      }
      const normalized = normalizeBoard(board, { workspacePath: workspace.path, title: workspace.title });
      await this.store.write(workspace.path, normalized);
      this.cache.set(workspace.path, { mtimeMs: Date.now(), board: normalized });
      this.store.notify({ workspacePath: workspace.path, board: normalized, actor });
      return { board: normalized, workspace };
    });
  }

  applyCommand(board, action, body, actor) {
    const now = isoNow();
    switch (action) {
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
          Object.assign(existing, task, { updatedAt: now });
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
          Object.assign(existing, todo, { updatedAt: now });
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
      if (commandId) {
        board.applied.unshift({ id: commandId, revision: board.revision, at: board.updatedAt });
        board.applied = board.applied.slice(0, LIMITS.applied);
      }
      const normalized = normalizeBoard(board, { workspacePath: workspace.path, title: workspace.title });
      await this.store.write(workspace.path, normalized);
      this.store.notify({ workspacePath: workspace.path, board: normalized, actor });
      return { board: normalized, workspace, created };
    });
  }
}

function nowIso() {
  return new Date().toISOString();
}
