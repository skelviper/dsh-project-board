// Board schema, normalisation, and command validation for dsh-project-board.
// The board file lives at <workspace>/board/project-board.json and is owned by
// this plugin; workspace project files are never mutated.

export const BOARD_VERSION = 1;
export const BOARD_RELATIVE_PATH = 'board/project-board.json';

export const NODE_KINDS = new Set(['theme', 'milestone', 'component', 'document', 'experiment', 'figure', 'manuscript', 'infra', 'historical']);
export const NODE_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'active', 'deferred', 'historical']);
export const EDGE_KINDS = new Set(['contains', 'depends', 'produces']);
export const TASK_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'dropped']);
export const TODO_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'dropped']);
export const DECISION_STATUSES = new Set(['open', 'answered']);

export const LIMITS = {
  nodes: 400,
  edges: 900,
  tasks: 1500,
  todos: 5000,
  decisions: 120,
  notes: 400,
  applied: 40,
  threads: 20,
  id: 120,
  title: 300,
  summary: 2000,
  description: 16000,
  short: 500,
  path: 2000,
  positionsPerCommand: 800,
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export class BoardError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value, max = LIMITS.title, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text.length > max ? text.slice(0, max) : text;
}

export function asBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

export function asNumber(value, fallback = 0, min = -1e6, max = 1e6) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function asIso(value, fallback) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

export function asId(value, fallback, prefix = 'x') {
  if (typeof value === 'string' && ID_RE.test(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const safe = value.trim().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, LIMITS.id);
    if (ID_RE.test(safe)) return safe;
  }
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLinks(input) {
  if (!Array.isArray(input)) return [];
  const links = [];
  for (const row of input.slice(0, 40)) {
    if (!isObject(row)) continue;
    const path = asString(row.path, LIMITS.path);
    if (!path) continue;
    links.push({
      kind: ['file', 'dir'].includes(row.kind) ? row.kind : 'file',
      path,
      label: asString(row.label, LIMITS.short),
    });
  }
  return links;
}

function normalizeArtifacts(input) {
  if (!Array.isArray(input)) return [];
  const rows = [];
  for (const row of input.slice(0, 40)) {
    if (!isObject(row)) continue;
    const path = asString(row.path, LIMITS.path);
    if (!path) continue;
    rows.push({
      kind: ['file', 'dir', 'link'].includes(row.kind) ? row.kind : 'file',
      path,
      label: asString(row.label, LIMITS.short),
    });
  }
  return rows;
}

function normalizeTeam(input, now) {
  if (!isObject(input)) return undefined;
  const leadSessionId = asString(input.leadSessionId, LIMITS.id);
  const taskId = asString(input.taskId, LIMITS.id);
  if (!leadSessionId || !taskId) return undefined;
  return {
    leadSessionId,
    taskId,
    ownerName: asString(input.ownerName, LIMITS.short),
    status: ['pending', 'in_progress', 'completed', 'deleted'].includes(input.status) ? input.status : undefined,
    revision: Number.isFinite(input.revision) ? Math.max(1, Math.trunc(input.revision)) : undefined,
    linkedAt: asIso(input.linkedAt, now),
  };
}

function normalizeNode(raw, now) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId('n');
  return {
    id,
    kind: NODE_KINDS.has(raw.kind) ? raw.kind : 'experiment',
    title: asString(raw.title, LIMITS.title, '未命名节点'),
    summary: asString(raw.summary, LIMITS.summary),
    status: NODE_STATUSES.has(raw.status) ? raw.status : 'todo',
    x: asNumber(raw.x, 0),
    y: asNumber(raw.y, 0),
    w: asNumber(raw.w, 240, 140, 520),
    links: normalizeLinks(raw.links),
    derivedFrom: Array.isArray(raw.derivedFrom) ? raw.derivedFrom.map((v) => asString(v, LIMITS.path)).filter(Boolean).slice(0, 30) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.map((v) => asString(v, 60)).filter(Boolean).slice(0, 20) : [],
    collapsed: asBool(raw.collapsed),
    createdAt: asIso(raw.createdAt, now),
    updatedAt: asIso(raw.updatedAt, now),
  };
}

function normalizeEdge(raw, now) {
  if (!isObject(raw)) return null;
  const from = asString(raw.from, LIMITS.id);
  const to = asString(raw.to, LIMITS.id);
  if (!from || !to || from === to) return null;
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId('e'),
    from,
    to,
    kind: EDGE_KINDS.has(raw.kind) ? raw.kind : 'depends',
    label: asString(raw.label, LIMITS.short),
    createdAt: asIso(raw.createdAt, now),
  };
}

function normalizeTask(raw, now) {
  if (!isObject(raw)) return null;
  const nodeId = asString(raw.nodeId, LIMITS.id);
  if (!nodeId) return null;
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId('t'),
    nodeId,
    title: asString(raw.title, LIMITS.title, '未命名任务'),
    status: TASK_STATUSES.has(raw.status) ? raw.status : 'todo',
    owner: asString(raw.owner, LIMITS.short),
    acceptance: asString(raw.acceptance, LIMITS.description),
    blockedBy: Array.isArray(raw.blockedBy) ? [...new Set(raw.blockedBy.map((v) => asString(v, LIMITS.id)).filter(Boolean))].slice(0, 40) : [],
    writeScopes: Array.isArray(raw.writeScopes) ? [...new Set(raw.writeScopes.map((v) => asString(v, LIMITS.path)).filter(Boolean))].slice(0, 20) : [],
    artifacts: normalizeArtifacts(raw.artifacts),
    threads: normalizeThreads(raw, now),
    team: normalizeTeam(raw.team, now),
    order: Number.isFinite(raw.order) ? Math.trunc(raw.order) : 0,
    createdAt: asIso(raw.createdAt, now),
    updatedAt: asIso(raw.updatedAt, now),
  };
}

function normalizeThread(raw, now) {
  if (!isObject(raw) || typeof raw.sessionId !== 'string' || !raw.sessionId.trim()) return null;
  return {
    sessionId: raw.sessionId.trim(),
    title: asString(raw.title, LIMITS.short),
    createdAt: asIso(raw.createdAt, now),
    updatedAt: asIso(raw.updatedAt, raw.createdAt || now),
  };
}

/** 任务和待办共用多会话结构，并迁移旧的单会话 thread。 */
function normalizeThreads(raw, now) {
  const rows = [];
  if (Array.isArray(raw.threads)) for (const item of raw.threads) rows.push(normalizeThread(item, now));
  if (isObject(raw.thread)) rows.push(normalizeThread(raw.thread, now));
  const seen = new Set();
  return rows.filter((row) => {
    if (!row || seen.has(row.sessionId)) return false;
    seen.add(row.sessionId);
    return true;
  }).slice(0, LIMITS.threads);
}

function normalizeTodo(raw, now) {
  if (!isObject(raw)) return null;
  const taskId = asString(raw.taskId, LIMITS.id);
  if (!taskId) return null;
  const threads = normalizeThreads(raw, now);
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId('d'),
    taskId,
    title: asString(raw.title, LIMITS.title, '未命名待办'),
    status: TODO_STATUSES.has(raw.status) ? raw.status : 'todo',
    owner: asString(raw.owner, LIMITS.short),
    acceptance: asString(raw.acceptance, LIMITS.description),
    order: Number.isFinite(raw.order) ? Math.trunc(raw.order) : 0,
    threads,
    team: normalizeTeam(raw.team, now),
    artifacts: normalizeArtifacts(raw.artifacts),
    createdAt: asIso(raw.createdAt, now),
    updatedAt: asIso(raw.updatedAt, now),
  };
}

function normalizeDecision(raw, now) {
  if (!isObject(raw)) return null;
  const question = asString(raw.question, LIMITS.description);
  if (!question) return null;
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId('q'),
    nodeId: asString(raw.nodeId, LIMITS.id),
    question,
    status: DECISION_STATUSES.has(raw.status) ? raw.status : 'open',
    answer: asString(raw.answer, LIMITS.description),
    createdAt: asIso(raw.createdAt, now),
    updatedAt: asIso(raw.updatedAt, now),
  };
}

function normalizeNote(raw, now) {
  if (!isObject(raw)) return null;
  const text = asString(raw.text, LIMITS.description);
  if (!text) return null;
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId('m'),
    targetType: ['board', 'node', 'task', 'todo'].includes(raw.targetType) ? raw.targetType : 'board',
    targetId: asString(raw.targetId, LIMITS.id),
    text,
    author: asString(raw.author, LIMITS.short, 'user'),
    createdAt: asIso(raw.createdAt, now),
  };
}

/** Coerce any loaded value into a valid board; never throws on untrusted input. */
export function normalizeBoard(raw, options = {}) {
  const source = isObject(raw) ? raw : {};
  const {
    workspacePath = typeof source.workspacePath === 'string' ? source.workspacePath : '',
    title = typeof source.title === 'string' ? source.title : '',
    now = new Date().toISOString(),
  } = options || {};
  const nodes = [];
  for (const row of Array.isArray(source.nodes) ? source.nodes : []) {
    const node = normalizeNode(row, now);
    if (node && !nodes.some((n) => n.id === node.id)) nodes.push(node);
    if (nodes.length >= LIMITS.nodes) break;
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const row of Array.isArray(source.edges) ? source.edges : []) {
    const edge = normalizeEdge(row, now);
    if (!edge || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    if (!edges.some((e) => e.id === edge.id)) edges.push(edge);
    if (edges.length >= LIMITS.edges) break;
  }
  const tasks = [];
  for (const row of Array.isArray(source.tasks) ? source.tasks : []) {
    const task = normalizeTask(row, now);
    if (!task || !nodeIds.has(task.nodeId)) continue;
    if (!tasks.some((t) => t.id === task.id)) tasks.push(task);
    if (tasks.length >= LIMITS.tasks) break;
  }
  const taskIds = new Set(tasks.map((t) => t.id));
  const todos = [];
  for (const row of Array.isArray(source.todos) ? source.todos : []) {
    const todo = normalizeTodo(row, now);
    if (!todo || !taskIds.has(todo.taskId)) continue;
    if (!todos.some((t) => t.id === todo.id)) todos.push(todo);
    if (todos.length >= LIMITS.todos) break;
  }
  const decisions = [];
  for (const row of Array.isArray(source.decisions) ? source.decisions : []) {
    const decision = normalizeDecision(row, now);
    if (!decision || (decision.nodeId && !nodeIds.has(decision.nodeId))) continue;
    if (!decisions.some((d) => d.id === decision.id)) decisions.push(decision);
    if (decisions.length >= LIMITS.decisions) break;
  }
  const notes = [];
  for (const row of Array.isArray(source.notes) ? source.notes : []) {
    const note = normalizeNote(row, now);
    if (!note) continue;
    notes.push(note);
    if (notes.length >= LIMITS.notes) break;
  }
  const applied = [];
  for (const row of Array.isArray(source.applied) ? source.applied : []) {
    if (!isObject(row) || typeof row.id !== 'string' || !row.id) continue;
    applied.push({ id: row.id.slice(0, 120), revision: Math.max(1, Math.trunc(Number(row.revision) || 1)), at: asIso(row.at, now) });
    if (applied.length >= LIMITS.applied) break;
  }
  const assistant = isObject(source.assistant) && typeof source.assistant.sessionId === 'string' && source.assistant.sessionId
    ? {
      sessionId: source.assistant.sessionId,
      createdAt: asIso(source.assistant.createdAt, now),
      updatedAt: asIso(source.assistant.updatedAt, now),
    }
    : undefined;
  return {
    version: BOARD_VERSION,
    revision: Math.max(1, Math.trunc(Number(source.revision) || 1)),
    workspacePath,
    title: asString(source.title, LIMITS.title, title || '项目看板'),
    createdAt: asIso(source.createdAt, now),
    updatedAt: asIso(source.updatedAt, now),
    updatedBy: asString(source.updatedBy, 200, 'system'),
    nodes,
    edges,
    tasks,
    todos,
    decisions,
    notes,
    applied,
    ...(assistant ? { assistant } : {}),
  };
}

/** New empty board for one workspace. */
export function createEmptyBoard({ workspacePath, title, actor = 'user', now = new Date().toISOString() }) {
  return normalizeBoard({}, { workspacePath, title, now });
}

/** Bounded digest text for an agent's system-prompt context. */
export function boardDigest(board, { workspacePath, teamTasks, sessionId } = {}) {
  if (!board) return '';
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const tasksById = new Map(board.tasks.map((task) => [task.id, task]));
  const tasksByNode = new Map();
  for (const task of board.tasks) {
    if (!tasksByNode.has(task.nodeId)) tasksByNode.set(task.nodeId, []);
    tasksByNode.get(task.nodeId).push(task);
  }
  const statusCount = (rows) => {
    const count = { todo: 0, doing: 0, blocked: 0, done: 0 };
    for (const row of rows) {
      if (row.status === 'doing' || row.status === 'active') count.doing += 1;
      else if (row.status === 'blocked' || row.status === 'deferred') count.blocked += 1;
      else if (row.status === 'done' || row.status === 'historical') count.done += 1;
      else count.todo += 1;
    }
    return `${count.doing} 进行 / ${count.blocked} 受阻 / ${count.done} 完成 / ${count.todo} 待办`;
  };
  const lines = [];
  // 同一会话可绑定多个任务和待办；优先显示全部匹配，避免只识别首个待办。
  const inSession = (row) => sessionId && (row.threads || []).some((thread) => thread.sessionId === sessionId);
  const boundTasks = board.tasks.filter(inSession);
  const boundTodos = board.todos.filter(inSession);
  if (boundTasks.length || boundTodos.length) {
    lines.push('当前会话绑定的看板条目：');
    for (const task of boundTasks) {
      const node = byId.get(task.nodeId);
      lines.push(`- 任务：${node ? node.title + ' / ' : ''}${task.title}（task ${task.id}，状态 ${task.status}）`);
    }
    for (const todo of boundTodos) {
      const task = tasksById.get(todo.taskId);
      const node = task ? byId.get(task.nodeId) : null;
      lines.push(`- 待办：${node ? node.title + ' / ' : ''}${task ? task.title + ' / ' : ''}${todo.title}（todo ${todo.id}，状态 ${todo.status}）`);
    }
    lines.push('按实际进展用 project_board_update 更新对应任务/待办状态；绑定会话本身不代表开始或完成。');
  }
  lines.push(`项目看板（workspace: ${workspacePath}，revision ${board.revision}，更新 ${new Date(board.updatedAt).toISOString()}）`);
  const threadedTasks = board.tasks.filter((task) => task.threads?.length);
  const threadedTodos = board.todos.filter((todo) => todo.threads?.length);
  if (threadedTasks.length || threadedTodos.length) {
    const sessions = new Set([...threadedTasks, ...threadedTodos].flatMap((row) => row.threads.map((thread) => thread.sessionId)));
    lines.push(`- 已绑定会话：${threadedTasks.length} 个任务 / ${threadedTodos.length} 个待办，共 ${sessions.size} 个会话`);
  }
  const themes = board.nodes.filter((n) => n.kind === 'theme');
  const others = board.nodes.filter((n) => n.kind !== 'theme');
  for (const theme of themes) {
    const children = board.edges.filter((e) => e.kind === 'contains' && e.from === theme.id).map((e) => byId.get(e.to)).filter(Boolean);
    const tasks = children.flatMap((child) => tasksByNode.get(child.id) || []);
    lines.push(`- ${theme.title}（${children.length} 节点；${statusCount(tasks)}）`);
    for (const child of children.slice(0, 8)) {
      const rows = tasksByNode.get(child.id) || [];
      lines.push(`  · ${child.title}${rows.length ? ` — ${statusCount(rows)}` : ''}`);
    }
    if (children.length > 8) lines.push(`  · …共 ${children.length} 个节点`);
  }
  const looseNodes = others.filter((node) => !board.edges.some((e) => e.kind === 'contains' && e.to === node.id));
  if (looseNodes.length) {
    lines.push(`- 其他节点：${looseNodes.slice(0, 10).map((n) => `${n.title}(${n.status})`).join('、')}${looseNodes.length > 10 ? ` 等 ${looseNodes.length} 个` : ''}`);
  }
  const doing = board.todos.filter((t) => t.status === 'doing' || t.status === 'active');
  if (doing.length) {
    lines.push('- 进行中的待办：');
    for (const todo of doing.slice(0, 8)) {
      const task = board.tasks.find((t) => t.id === todo.taskId);
      const node = task ? byId.get(task.nodeId) : null;
      const team = todo.team ? teamTasks?.find((t) => t.id === todo.team.taskId) : null;
      const tail = team ? `；团队状态 ${team.status}${team.ownerName ? ` @${team.ownerName}` : ''}` : todo.threads?.length ? `；已有 ${todo.threads.length} 个会话线程` : '';
      lines.push(`  · ${node ? node.title + ' / ' : ''}${task ? task.title + ' / ' : ''}${todo.title}${tail}`);
    }
  }
  const open = board.decisions.filter((d) => d.status === 'open');
  if (open.length) {
    lines.push(`- 待决策：${open.slice(0, 4).map((d) => d.question).join('；')}${open.length > 4 ? ` 等 ${open.length} 条` : ''}`);
  }
  const boardNotes = board.notes.filter((n) => n.targetType === 'board');
  if (boardNotes.length) {
    lines.push(`- 最新备注：${boardNotes.slice(-2).map((n) => n.text.split('\n')[0]).join(' / ')}`);
  }
  lines.push('约定：规划、汇报项目状态前先读看板；工作完成后用 project_board_update 回写节点/任务/待办状态；不要另建状态文件。');
  return lines.join('\n').slice(0, 4000);
}

/** Build a compact transcript entry from raw session events (filled by thread.mjs). */
export function describeActionName(action) {
  return typeof action === 'string' && action ? action : 'unknown';
}
