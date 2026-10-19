// Board schema, normalisation, and command validation for dsh-project-board.
// The board file lives at <workspace>/board/project-board.json and is owned by
// this plugin; explicit board deletions may archive owned workspace outputs.

import { pbNodeIdsInScope, pbScopeStats, pbShortSummary } from './board-model.js';
import { normalizeMaintenance } from './maintenance.mjs';

export const BOARD_VERSION = 1;
export const BOARD_RELATIVE_PATH = 'board/project-board.json';

export const NODE_KINDS = new Set(['theme', 'milestone', 'component', 'document', 'experiment', 'figure', 'manuscript', 'infra', 'historical']);
export const NODE_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'active', 'deferred', 'historical']);
export const EDGE_KINDS = new Set(['contains', 'depends', 'produces']);
export const TASK_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'deferred', 'dropped', 'historical']);
export const TODO_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'deferred', 'dropped', 'historical']);
export const DECISION_STATUSES = new Set(['open', 'answered']);

export const LIMITS = {
  nodes: 400,
  edges: 900,
  tasks: 1500,
  todos: 5000,
  decisions: 120,
  notes: 400,
  applied: 40,
  changes: 80,
  changeBytes: 2 * 1024 * 1024,
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
    ownedPaths: Array.isArray(raw.ownedPaths) ? [...new Set(raw.ownedPaths.map(v => asString(v, LIMITS.path)).filter(Boolean))].slice(0, 40) : [],
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

function normalizeDelivery(raw) {
  const value = isObject(raw) ? raw : {};
  return {
    summary: asString(value.summary, LIMITS.description),
    outcome: ['unspecified', 'supported', 'not_supported', 'not_triggered', 'inconclusive'].includes(value.outcome) ? value.outcome : 'unspecified',
    review: ['none', 'pending', 'accepted', 'changes_requested'].includes(value.review) ? value.review : 'none',
    submittedAt: asIso(value.submittedAt, ''),
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
    delivery: normalizeDelivery(raw.delivery),
    primaryArtifactPath: asString(raw.primaryArtifactPath, LIMITS.path),
    blockedBy: Array.isArray(raw.blockedBy) ? [...new Set(raw.blockedBy.map((v) => asString(v, LIMITS.id)).filter(Boolean))].slice(0, 40) : [],
    writeScopes: Array.isArray(raw.writeScopes) ? [...new Set(raw.writeScopes.map((v) => asString(v, LIMITS.path)).filter(Boolean))].slice(0, 20) : [],
    artifacts: normalizeArtifacts(raw.artifacts),
    ownedPaths: Array.isArray(raw.ownedPaths) ? [...new Set(raw.ownedPaths.map(v => asString(v, LIMITS.path)).filter(Boolean))].slice(0, 40) : [],
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
    delivery: normalizeDelivery(raw.delivery),
    primaryArtifactPath: asString(raw.primaryArtifactPath, LIMITS.path),
    order: Number.isFinite(raw.order) ? Math.trunc(raw.order) : 0,
    threads,
    team: normalizeTeam(raw.team, now),
    artifacts: normalizeArtifacts(raw.artifacts),
    ownedPaths: Array.isArray(raw.ownedPaths) ? [...new Set(raw.ownedPaths.map(v => asString(v, LIMITS.path)).filter(Boolean))].slice(0, 40) : [],
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

const CHANGE_COLLECTIONS = new Set(['nodes', 'edges', 'tasks', 'todos', 'notes', 'decisions']);

function normalizeChanges(input, now) {
  const rows = [], seen = new Set();
  let bytes = 0;
  for (const raw of Array.isArray(input) ? input : []) {
    if (!isObject(raw) || !ID_RE.test(raw.id || '') || seen.has(raw.id)) continue;
    const patches = Array.isArray(raw.patches) ? raw.patches : [];
    const guards = Array.isArray(raw.guards) ? raw.guards : [];
    const validPatch = patch => isObject(patch) && CHANGE_COLLECTIONS.has(patch.collection) && ID_RE.test(patch.id || '') &&
      Array.isArray(patch.path) && patch.path.length <= 2 && patch.path.every(key => typeof key === 'string' && !['__proto__', 'prototype', 'constructor', 'id'].includes(key)) &&
      (patch.path.length === 0 || (typeof patch.rowCreatedAt === 'string' && Number.isFinite(Date.parse(patch.rowCreatedAt)))) &&
      typeof patch.beforeExists === 'boolean' && typeof patch.afterExists === 'boolean' &&
      (!patch.beforeExists || Object.hasOwn(patch, 'before')) && (!patch.afterExists || Object.hasOwn(patch, 'after'));
    const validGuard = guard => isObject(guard) && CHANGE_COLLECTIONS.has(guard.collection) && ID_RE.test(guard.id || '') && Array.isArray(guard.relations) && guard.relations.every(value => typeof value === 'string') &&
      (guard.parents === undefined || (Array.isArray(guard.parents) && guard.parents.every(parent => isObject(parent) && CHANGE_COLLECTIONS.has(parent.collection) && ID_RE.test(parent.id || '') && typeof parent.createdAt === 'string' && Number.isFinite(Date.parse(parent.createdAt)))));
    const valid = patches.length > 0 && patches.every(validPatch) && guards.every(validGuard);
    const undo = isObject(raw.undo) ? raw.undo : {};
    const row = {
      id: raw.id, at: asIso(raw.at, now), actor: asString(raw.actor, 200, 'system'),
      action: asString(raw.action, 80), summary: asString(raw.summary, LIMITS.short),
      targets: (Array.isArray(raw.targets) ? raw.targets : []).filter(target => isObject(target) && ['node', 'edge', 'task', 'todo', 'note', 'decision', 'board'].includes(target.type)).map(target => ({ type: target.type, id: asString(target.id, LIMITS.id), title: asString(target.title, LIMITS.title) })),
      undo: {
        status: undo.status === 'undone' ? 'undone' : undo.status === 'available' && valid ? 'available' : 'unavailable',
        reason: asString(undo.reason, LIMITS.short), undoneAt: asIso(undo.undoneAt, ''), undoneBy: asString(undo.undoneBy, 200),
      },
      patches: valid ? patches : [], guards: valid ? guards : [],
    };
    let size = new TextEncoder().encode(JSON.stringify(row)).length;
    if (size > LIMITS.changeBytes / 2) {
      row.patches = []; row.guards = [];
      row.undo = { ...row.undo, status: 'unavailable', reason: '变更过大，仅保留摘要，无法撤销' };
      row.targets = row.targets.slice(0, 20);
      size = new TextEncoder().encode(JSON.stringify(row)).length;
    }
    if (bytes + size > LIMITS.changeBytes) break;
    bytes += size; seen.add(row.id); rows.push(row);
    if (rows.length >= LIMITS.changes) break;
  }
  return rows;
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
    applied.push({ id: row.id.slice(0, 120), revision: Math.max(1, Math.trunc(Number(row.revision) || 1)), at: asIso(row.at, now), ...(row.changeId ? { changeId: asString(row.changeId, LIMITS.id) } : {}) });
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
    changes: normalizeChanges(source.changes, now),
    ...(assistant ? { assistant } : {}),
    ...(source.maintenance ? { maintenance: normalizeMaintenance(source.maintenance) } : {}),
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
  const statusCount = (stats) => `${stats.doing} 进行 / ${stats.blocked} 受阻 / ${stats.done} 完成 / ${stats.todo} 待办 / ${stats.deferred} 暂缓 / ${stats.dropped} 放弃 / ${stats.historical} 历史；已结束 ${stats.closed}/${stats.total}（${stats.pct}%）`;
  const lines = [];
  if (board.maintenance) {
    const open = board.maintenance.conflicts.filter(c => c.status === 'open').length;
    lines.push(`看板维护：${board.maintenance.lastScanAt || '尚未扫描'}；${open} 个冲突需决定。用project_board_maintain读取/更新；删除标记不能复活。`);
  }
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
  lines.push(`项目看板（workspace: ${pbShortSummary(workspacePath || board.workspacePath || board.title, 180)}，revision ${board.revision}，更新 ${new Date(board.updatedAt).toISOString()}）`);
  const threadedTasks = board.tasks.filter((task) => task.threads?.length);
  const threadedTodos = board.todos.filter((todo) => todo.threads?.length);
  if (threadedTasks.length || threadedTodos.length) {
    const sessions = new Set([...threadedTasks, ...threadedTodos].flatMap((row) => row.threads.map((thread) => thread.sessionId)));
    lines.push(`- 已绑定会话：${threadedTasks.length} 个任务 / ${threadedTodos.length} 个待办，共 ${sessions.size} 个会话`);
  }
  lines.push(`- 全板末级工作项：${statusCount(pbScopeStats(board))}`);
  const themes = board.nodes.filter((n) => n.kind === 'theme');
  const assigned = new Set(themes.flatMap(theme => pbNodeIdsInScope(board, theme.id)));
  const looseNodes = board.nodes.filter(node => !assigned.has(node.id));
  if (looseNodes.length) {
    const looseIds = new Set(looseNodes.map(node => node.id));
    const looseBoard = { ...board, nodes: looseNodes, tasks: board.tasks.filter(task => looseIds.has(task.nodeId)) };
    lines.push(`- 未归属主题：${looseNodes.length} 节点；${statusCount(pbScopeStats(looseBoard))}`);
    lines.push(`  · ${looseNodes.slice(0, 10).map(node => `${pbShortSummary(node.title, 45)}(${node.status})`).join('、')}${looseNodes.length > 10 ? ` 等 ${looseNodes.length} 个` : ''}`);
  }
  for (const theme of themes) {
    const stats = pbScopeStats(board, theme.id);
    const children = stats.nodeIds.filter(id => id !== theme.id).map(id => byId.get(id));
    lines.push(`- ${pbShortSummary(theme.title, 70)}（含自身 ${stats.nodeIds.length} 节点；${statusCount(stats)}）`);
    for (const child of children.slice(0, 8)) {
      const childStats = pbScopeStats(board, child.id);
      lines.push(`  · ${pbShortSummary(child.title, 70)}${childStats.taskCount ? ` — ${statusCount(childStats)}` : ''}`);
    }
    if (children.length > 8) lines.push(`  · …共 ${children.length} 个后代节点`);
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
    lines.push(`- 待决策：${open.slice(0, 4).map((d) => pbShortSummary(d.question, 140)).join('；')}${open.length > 4 ? ` 等 ${open.length} 条` : ''}`);
  }
  const boardNotes = board.notes.filter((n) => n.targetType === 'board');
  if (boardNotes.length) {
    lines.push(`- 最新备注摘要：${boardNotes.slice(-2).map((n) => pbShortSummary(n.text)).join(' / ')}（正文保留在看板）`);
  }
  const convention = '约定：规划、汇报项目状态前先读看板；工作完成后用 project_board_update 回写节点/任务/待办状态；不要另建状态文件。';
  const omission = '（部分条目省略；完整内容请读取看板。）';
  // 给总数、未归属条目、决策、最新结论和约定留足预算，逐行省略其余内容。
  const fixed = new Set(lines.filter(line => /^(项目看板|\- 全板末级|\- 未归属主题|\- 待决策|\- 最新备注摘要)/.test(line)));
  const fixedSize = [...fixed].reduce((sum, line) => sum + line.length + 1, 0);
  const selected = [], budget = 4000 - convention.length - omission.length - fixedSize - 3;
  let used = 0, omitted = false;
  for (const line of lines) {
    if (!fixed.has(line)) {
      if (used + line.length + 1 > budget) { omitted = true; continue; }
      used += line.length + 1;
    }
    selected.push(line);
  }
  if (omitted) selected.push(omission);
  selected.push(convention);
  return selected.join('\n');
}

/** Build a compact transcript entry from raw session events (filled by thread.mjs). */
export function describeActionName(action) {
  return typeof action === 'string' && action ? action : 'unknown';
}
