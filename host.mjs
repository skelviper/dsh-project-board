import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
// 浏览器与宿主共用的纯函数，不依赖 DOM、React 或 Node API。
function pbNodeIdsInScope(board, nodeId = null) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  const known = new Set(nodes.map(node => node.id));
  if (nodeId === null) return [...known];
  if (!known.has(nodeId)) return [];
  const children = new Map();
  for (const edge of board?.edges || []) {
    if (edge.kind !== 'contains' || !known.has(edge.from) || !known.has(edge.to)) continue;
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from).push(edge.to);
  }
  const seen = new Set(), pending = [nodeId];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(children.get(id) || []));
  }
  return [...seen];
}

function pbScopeStats(board, nodeId = null) {
  const nodeIds = pbNodeIdsInScope(board, nodeId);
  const scope = new Set(nodeIds), seenTasks = new Set(), seenTodos = new Set();
  const tasks = (board?.tasks || []).filter(task => {
    if ((nodeId !== null && !scope.has(task.nodeId)) || seenTasks.has(task.id)) return false;
    seenTasks.add(task.id); return true;
  });
  const todosByTask = new Map();
  for (const todo of board?.todos || []) {
    if (!seenTasks.has(todo.taskId) || seenTodos.has(todo.id)) continue;
    seenTodos.add(todo.id);
    if (!todosByTask.has(todo.taskId)) todosByTask.set(todo.taskId, []);
    todosByTask.get(todo.taskId).push(todo);
  }
  const result = { nodeIds, taskCount: tasks.length, total: 0, done: 0, doing: 0, blocked: 0, todo: 0, deferred: 0, dropped: 0, historical: 0, closed: 0, pct: 0 };
  // 有待办的任务只统计待办；没有待办的任务本身就是末级工作项。
  for (const task of tasks) for (const row of todosByTask.get(task.id) || [task]) {
    const status = row.status === 'active' ? 'doing' : row.status;
    const key = ['done', 'doing', 'blocked', 'todo', 'deferred', 'dropped', 'historical'].includes(status) ? status : 'todo';
    result[key] += 1;
    result.total += 1;
  }
  result.closed = result.done + result.dropped + result.historical;
  result.pct = result.total ? Math.round(result.closed * 100 / result.total) : 0;
  return result;
}

function pbShortSummary(text, max = 120) {
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 120;
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (value.length <= limit) return value;
  return limit > 1 ? value.slice(0, limit - 1) + '…' : limit ? '…' : '';
}

// Board schema, normalisation, and command validation for dsh-project-board.
// The board file lives at <workspace>/board/project-board.json and is owned by
// this plugin; workspace project files are never mutated.


const BOARD_VERSION = 1;
const BOARD_RELATIVE_PATH = 'board/project-board.json';

const NODE_KINDS = new Set(['theme', 'milestone', 'component', 'document', 'experiment', 'figure', 'manuscript', 'infra', 'historical']);
const NODE_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'active', 'deferred', 'historical']);
const EDGE_KINDS = new Set(['contains', 'depends', 'produces']);
const TASK_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'deferred', 'dropped', 'historical']);
const TODO_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'deferred', 'dropped', 'historical']);
const DECISION_STATUSES = new Set(['open', 'answered']);

const LIMITS = {
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

class BoardError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value, max = LIMITS.title, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text.length > max ? text.slice(0, max) : text;
}

function asBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value, fallback = 0, min = -1e6, max = 1e6) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function asIso(value, fallback) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function asId(value, fallback, prefix = 'x') {
  if (typeof value === 'string' && ID_RE.test(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const safe = value.trim().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, LIMITS.id);
    if (ID_RE.test(safe)) return safe;
  }
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function newId(prefix) {
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
function normalizeBoard(raw, options = {}) {
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
  };
}

/** New empty board for one workspace. */
function createEmptyBoard({ workspacePath, title, actor = 'user', now = new Date().toISOString() }) {
  return normalizeBoard({}, { workspacePath, title, now });
}

/** Bounded digest text for an agent's system-prompt context. */
function boardDigest(board, { workspacePath, teamTasks, sessionId } = {}) {
  if (!board) return '';
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const tasksById = new Map(board.tasks.map((task) => [task.id, task]));
  const statusCount = (stats) => `${stats.doing} 进行 / ${stats.blocked} 受阻 / ${stats.done} 完成 / ${stats.todo} 待办 / ${stats.deferred} 暂缓 / ${stats.dropped} 放弃 / ${stats.historical} 历史；已结束 ${stats.closed}/${stats.total}（${stats.pct}%）`;
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
function describeActionName(action) {
  return typeof action === 'string' && action ? action : 'unknown';
}

// Per-workspace board store: <workspace>/board/project-board.json.
// Writes are serialized per workspace and replace the file atomically.



const TMP_PREFIX = '.project-board.json.tmp-';

async function readJson(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (text.length > 8 * 1024 * 1024) throw new BoardError('BOARD_TOO_LARGE', '看板文件超过 8MB', 413);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BoardError('BOARD_CORRUPT', '看板 JSON 无法解析，请检查 board/project-board.json', 422, { cause: error.message });
  }
}

class BoardStore {
  constructor() {
    this.queues = new Map();
    this.listeners = new Set();
  }

  boardPath(workspacePath) {
    return path.join(workspacePath, BOARD_RELATIVE_PATH);
  }

  /** Read one board. Returns {exists, board, mtimeMs}. */
  async read(workspacePath) {
    const file = this.boardPath(workspacePath);
    let stat = null;
    try {
      stat = await fsp.stat(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, board: null, mtimeMs: 0 };
      throw error;
    }
    const raw = await readJson(file);
    const board = normalizeBoard(raw, { workspacePath, title: path.basename(workspacePath) });
    return { exists: true, board, mtimeMs: stat.mtimeMs };
  }

  /** Replace one board atomically. Creates the board directory when missing. */
  async write(workspacePath, board) {
    const file = this.boardPath(workspacePath);
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, TMP_PREFIX + process.pid + '-' + Math.random().toString(36).slice(2));
    const text = JSON.stringify(board, null, 2) + '\n';
    try {
      await fsp.writeFile(tmp, text, { mode: 0o644 });
      await fsp.rename(tmp, file);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    return file;
  }

  /** Serialize one read-modify-write cycle per workspace. */
  async mutate(workspacePath, task) {
    const previous = this.queues.get(workspacePath) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.queues.set(workspacePath, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(workspacePath) === tail) this.queues.delete(workspacePath);
    }
  }

  /** Subscribe to committed board changes: fn({workspacePath, board, actor}). */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event) {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a subscriber must not break storage */ }
    }
  }
}

function defaultBoard(workspacePath, title) {
  const now = new Date().toISOString();
  return normalizeBoard({}, { workspacePath, title, now });
}

// Board service: workspace validation, revision CAS, command application,
// Agent Teams dispatch, and board digests for agent prompts.





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

class BoardService {
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

// Compact transcript builder for a todo's bound DSH session.
// Reads the durable session log through ctx.sessionQuery and extracts only the
// presentation-relevant events (user prompts, assistant text, tool calls/results).

const MAX_TEXT = 4000;
const MAX_ARGUMENTS = 1200;

function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text);
    if (block.type === 'image') parts.push('[图片]');
    if (block.type === 'file' && block.name) parts.push(`[文件 ${block.name}]`);
  }
  return parts.join('\n').trim();
}

function clip(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Convert one SessionLogSnapshot into a bounded transcript for the UI. */
function transcriptFromSnapshot(snapshot, { limit = 200, startSeq = 0 } = {}) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const rows = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (Number.isFinite(startSeq) && Number.isFinite(event.seq) && event.seq < startSeq) continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const base = { seq: event.seq, time: event.time, type: event.type };
    if (event.type === 'user/message') {
      const sourceKind = data.source && typeof data.source === 'object' ? data.source.kind : undefined;
      // Only real conversation turns: skip agent-instructions, runtime-context,
      // skill-catalog, time-context and other synthetic context messages.
      if (sourceKind !== 'user' && sourceKind !== 'goal') continue;
      const text = textOf(data.content);
      if (text) rows.push({ ...base, kind: 'user', text: clip(text, MAX_TEXT) });
    } else if (event.type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      const text = textOf(message.content);
      if (text) rows.push({ ...base, kind: 'assistant', text: clip(text, MAX_TEXT) });
      if (data.interrupted) rows.push({ ...base, kind: 'note', text: '（本轮回复被中断）' });
    } else if (event.type === 'tool/call') {
      rows.push({
        ...base,
        kind: 'tool-call',
        name: typeof data.name === 'string' ? data.name : 'tool',
        callId: typeof data.callId === 'string' ? data.callId : undefined,
        arguments: clip(typeof data.arguments === 'string' ? data.arguments : '', MAX_ARGUMENTS),
      });
    } else if (event.type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      rows.push({
        ...base,
        kind: 'tool-result',
        callId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
        isError: Boolean(message.isError || data.error),
        text: clip(textOf(message.content), MAX_TEXT),
        errorReason: data.error && typeof data.error.reason === 'string' ? clip(data.error.reason, 600) : '',
      });
    } else if (event.type === 'turn/end') {
      const reason = data.reason;
      if (reason && (reason.kind === 'aborted' || reason.kind === 'error')) {
        rows.push({ ...base, kind: 'note', text: `（回合异常结束：${reason.kind}）` });
      }
    }
  }
  const bounded = rows.slice(-Math.max(1, Math.min(1000, limit)));
  return {
    sessionId: snapshot?.session?.id,
    title: snapshot?.session?.title,
    cwd: snapshot?.session?.cwd,
    totalEvents: events.length,
    entries: bounded,
  };
}

/** Read one session log and return its compact transcript. */
async function readThread(ctx, sessionId, options = {}) {
  if (!ctx.sessionQuery) throw new Error('session query is unavailable');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId is required');
  const snapshot = await readSnapshot(ctx, sessionId, options.signal);
  return transcriptFromSnapshot(snapshot, options);
}

async function readSnapshot(ctx, sessionId, signal) {
  const query = ctx.sessionQuery;
  if (typeof query.observeSession === 'function') {
    const observation = await query.observeSession(sessionId, { projectionMode: 'none', signal });
    try {
      const inherited = Number(observation.inheritedEventCount) || 0;
      return {
        session: observation.header,
        inheritedEventCount: inherited,
        events: Array.isArray(observation.events) ? observation.events.slice(inherited) : [],
      };
    } finally {
      try { observation[Symbol.dispose]?.(); } catch { /* ignore */ }
    }
  }
  return query.readSession(sessionId);
}

// dsh-project-board host plugin.
// Registers the per-workspace project board API, model-facing tools, and the
// board digest injected into each agent's runtime context.








const name = 'project-board';
const inject = ['connection', 'tools', 'systemPrompt', 'agents', 'agentTeams', 'workspaceRegistry', 'sessionQuery'];

async function runtimeModule(specifier) {
  const candidates = [process.argv[1] && path.resolve(process.argv[1]), import.meta.url];
  let resolved;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      resolved = createRequire(candidate).resolve(specifier);
      break;
    } catch { /* try the next owner */ }
  }
  if (!resolved) resolved = createRequire(import.meta.url).resolve(specifier);
  return import(pathToFileURL(resolved).href);
}

const MAX_BODY_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const digestCache = new Map();

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function errorResponse(error) {
  if (error instanceof BoardError) {
    return jsonResponse(error.status, { error: { code: error.code, message: error.message, details: error.details } });
  }
  return jsonResponse(500, { error: { code: 'INTERNAL', message: String(error?.message || error) } });
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BoardError('BODY_TOO_LARGE', '请求体过大', 413);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BoardError('INVALID_JSON', '请求体不是合法 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BoardError('INVALID_INPUT', '请求体必须是对象');
  return value;
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const table = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
    '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.json': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
    '.yml': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  };
  return table[ext] || 'application/octet-stream';
}

const jsonSafe = (value) => JSON.parse(JSON.stringify(value));

async function apply(ctx) {
  const service = new BoardService({ ctx });
  const { defineTool } = await runtimeModule('@deepseek-ai/dsh-tools');

  // ---- authenticated HTTP routes -------------------------------------------
  const routes = [];

  routes.push(['GET', '/api/project-board/workspaces', async () => {
    const workspaces = [];
    for (const workspace of service.registryWorkspaces()) {
      let exists = false;
      try {
        exists = (await service.read(workspace.path)).exists;
      } catch { exists = false; }
      workspaces.push({ ...workspace, hasBoard: exists });
    }
    return jsonResponse(200, { workspaces });
  }]);

  routes.push(['GET', '/api/project-board/state', async (request) => {
    const url = new URL(request.url);
    const workspacePath = url.searchParams.get('workspacePath');
    if (!workspacePath) throw new BoardError('INVALID_INPUT', '缺少 workspacePath');
    return jsonResponse(200, await service.state(workspacePath));
  }]);

  routes.push(['POST', '/api/project-board/command', async (request) => {
    const body = await readJsonBody(request);
    const result = await service.command({
      workspacePath: body.workspacePath,
      expectedRevision: body.expectedRevision,
      commandId: body.commandId,
      action: body.action,
      input: body.input,
      actor: typeof body.actor === 'string' ? body.actor : 'user',
    });
    return jsonResponse(200, { board: result.board, workspace: result.workspace, replayed: Boolean(result.replayed), changeId: result.changeId, lastChange: result.lastChange });
  }]);

  routes.push(['POST', '/api/project-board/dispatch', async (request) => {
    const body = await readJsonBody(request);
    const result = await service.dispatch({
      workspacePath: body.workspacePath,
      expectedRevision: body.expectedRevision,
      commandId: body.commandId,
      leadSessionId: body.leadSessionId,
      items: body.items,
      actor: typeof body.actor === 'string' ? body.actor : 'user',
    });
    return jsonResponse(200, { board: result.board, created: result.created, changeId: result.changeId, lastChange: result.lastChange });
  }]);

  routes.push(['GET', '/api/project-board/thread', async (request) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 200)));
    const startSeq = Math.max(0, Number(url.searchParams.get('startSeq') || 0));
    return jsonResponse(200, await readThread(ctx, sessionId, { limit, startSeq }));
  }]);

  routes.push(['GET', '/api/project-board/artifact', async (request) => {
    const url = new URL(request.url);
    const workspacePath = url.searchParams.get('workspacePath');
    const relative = url.searchParams.get('path');
    if (!workspacePath || !relative) throw new BoardError('INVALID_INPUT', '缺少 workspacePath 或 path');
    const workspace = service.findWorkspace(workspacePath);
    const root = workspace.path;
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new BoardError('PATH_OUTSIDE_WORKSPACE', '路径必须在 workspace 内', 403);
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch {
      throw new BoardError('FILE_NOT_FOUND', '文件不存在', 404);
    }
    if (stat.isSymbolicLink()) throw new BoardError('SYMLINK_REFUSED', '不跟随符号链接', 403);
    // 父目录也可能是符号链接；读取前核对真实路径归属。
    const realRoot = await fsp.realpath(root);
    const realTarget = await fsp.realpath(target);
    const fromRoot = path.relative(realRoot, realTarget);
    if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) {
      throw new BoardError('PATH_OUTSIDE_WORKSPACE', '路径必须在 workspace 内', 403);
    }
    if (!stat.isFile()) throw new BoardError('NOT_A_FILE', '不是普通文件', 422);
    if (stat.size > MAX_ARTIFACT_BYTES) throw new BoardError('FILE_TOO_LARGE', '文件超过预览上限', 413);
    const bytes = await fsp.readFile(target);
    const contentType = contentTypeFor(target);
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (contentType === 'image/svg+xml' || contentType.startsWith('text/')) {
      headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:";
    }
    if (contentType === 'application/octet-stream') headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
    return new Response(bytes, { status: 200, headers });
  }]);

  routes.push(['GET', '/api/project-board/events', async (request) => {
    const url = new URL(request.url);
    const workspacePath = url.searchParams.get('workspacePath');
    if (!workspacePath) throw new BoardError('INVALID_INPUT', '缺少 workspacePath');
    const workspace = service.findWorkspace(workspacePath);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let unsubscribe = () => {};
        const send = (event, value) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
          } catch { closed = true; }
        };
        send('hello', { workspacePath: workspace.path, timestamp: Date.now() });
        unsubscribe = service.store.onChange((event) => {
          if (event.workspacePath !== workspace.path) return;
          send('board', { revision: event.board.revision, updatedAt: event.board.updatedAt, actor: event.actor });
        });
        const keepalive = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { closed = true; }
        }, 20000);
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepalive);
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        };
        request.signal.addEventListener('abort', cleanup);
      },
      cancel() {
        // The start() closure owns the subscription; the request abort cleanup
        // runs for browser disconnects as well.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }]);

  for (const [method, routePath, handler] of routes) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({
        path: routePath,
        methods: [method],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request);
          } catch (error) {
            if (!(error instanceof BoardError)) ctx.logger?.warn?.(`project-board route ${routePath} failed: ${error?.stack || error}`);
            return errorResponse(error);
          }
        },
      });
      return async () => { await dispose(); };
    }, `project-board route ${routePath}`);
  }

  // ---- model-facing tools --------------------------------------------------
  const jsonOutput = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  const workspaceArg = { type: 'string', description: '目标 workspace 的绝对路径；省略时使用当前会话工作目录所属的 workspace' };

  function toolWorkspace(agent, requested) {
    if (requested) {
      const absolute = path.resolve(requested);
      const workspace = service.registryWorkspaces().find((row) => row.path === absolute);
      return workspace || { workspaceId: '', path: absolute, title: path.basename(absolute), unregistered: true };
    }
    return service.workspaceForAgent(agent);
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_board_get',
    description: '读取项目看板：摘要（digest）、完整看板、节点/任务/待办详情，或某个任务或待办绑定会话的对话记录。规划项目或汇报状态前先调用。',
    parameters: {
      workspacePath: workspaceArg,
      view: { type: 'string', enum: ['digest', 'board', 'node', 'tasks', 'todos', 'thread'], description: '读取视图，默认 digest' },
      nodeId: { type: 'string', description: 'view=node 时的节点 id' },
      taskId: { type: 'string', description: '筛选某个任务下的待办' },
      sessionId: { type: 'string', description: 'view=thread 时的会话 id' },
      limit: { type: 'integer', description: 'view=thread 时最多返回的消息条数（默认 120）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: typeof value?.digest === 'string' ? value.digest : JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30000,
    execute: async (args, exec) => {
      const agent = exec.agent;
      const workspace = toolWorkspace(agent, args.workspacePath);
      const view = args.view || 'digest';
      if (view === 'digest') {
        const { digest, board } = await service.digestFor(agent, workspace);
        return jsonSafe({ workspacePath: workspace.path, revision: board?.revision, digest: digest || '（该 workspace 还没有项目看板）' });
      }
      if (view === 'thread') {
        return jsonSafe(await readThread(ctx, args.sessionId, { limit: Math.max(1, Math.min(500, args.limit || 120)) }));
      }
      const { exists, board } = await service.read(workspace.path);
      if (!exists) return jsonSafe({ workspacePath: workspace.path, exists: false, board: null });
      if (view === 'board') return jsonSafe({ workspacePath: workspace.path, revision: board.revision, board });
      if (view === 'node') {
        const node = board.nodes.find((row) => row.id === args.nodeId);
        if (!node) throw new BoardError('NODE_NOT_FOUND', `节点不存在：${args.nodeId}`, 404);
        return jsonSafe({
          workspacePath: workspace.path,
          revision: board.revision,
          node,
          tasks: board.tasks.filter((row) => row.nodeId === node.id),
          todos: board.todos.filter((row) => board.tasks.some((task) => task.id === row.taskId && task.nodeId === node.id)),
          edges: board.edges.filter((row) => row.from === node.id || row.to === node.id),
        });
      }
      if (view === 'tasks') return jsonSafe({ workspacePath: workspace.path, revision: board.revision, tasks: board.tasks, todos: board.todos });
      const todos = args.taskId ? board.todos.filter((row) => row.taskId === args.taskId) : board.todos;
      return jsonSafe({ workspacePath: workspace.path, revision: board.revision, todos });
    },
  })), 'project-board tool: get');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_board_update',
    description: '修改项目看板：节点/连线/任务/待办/备注/决策的增删改、保存节点位置、给任务或待办绑定或解绑多个会话线程。绑定会话不改变条目状态。写操作带 expectedRevision 可避免覆盖他人修改。',
    parameters: {
      workspacePath: workspaceArg,
      expectedRevision: { type: 'integer', description: '当前看板 revision；省略则不做并发检查' },
      commandId: { type: 'string', description: '幂等命令 id，重试时复用同一个值' },
      action: {
        type: 'string',
        required: true,
        enum: [
          'create_board', 'rename_board', 'upsert_node', 'delete_node', 'upsert_edge', 'delete_edge',
          'upsert_task', 'delete_task', 'upsert_todo', 'delete_todo', 'move_todo', 'save_positions',
          'add_note', 'delete_note', 'upsert_decision', 'delete_decision', 'bind_thread', 'unbind_thread', 'undo_change',
        ],
        description: '看板操作类型',
      },
      input: { type: 'json', description: '操作参数，例如 {node:{...}}、{id:"..."}、{positions:[{id,x,y}]}。bind_thread/unbind_thread 的 taskId 和 todoId 恰好提供一个，并提供 sessionId；绑定追加且幂等，不覆盖已有会话。仅旧 unbind_thread({todoId}) 可省略 sessionId 清空待办会话。upsert_task/upsert_todo 可保存 threads、primaryArtifactPath，以及 delivery:{summary,outcome,review,submittedAt}；outcome 为 unspecified/supported/not_supported/not_triggered/inconclusive，review 为 none/pending/accepted/changes_requested。旧 acceptance 是验收要求，结论写 delivery。undo_change 用 {changeId} 撤销一条可撤销变更，遇到字段或关联冲突会拒绝。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify({ revision: value?.revision, action: value?.action, ok: value?.ok }, null, 2) }],
    },
    timeoutMs: 30000,
    execute: async (args, exec) => {
      const agent = exec.agent;
      const workspace = toolWorkspace(agent, args.workspacePath);
      const result = await service.command({
        workspacePath: workspace.path,
        expectedRevision: args.expectedRevision,
        commandId: args.commandId,
        action: args.action,
        input: args.input,
        actor: `agent:${agent?.id || 'unknown'}`,
        allowCreate: args.action === 'create_board',
      });
      return jsonSafe({ ok: true, action: args.action, revision: result.board.revision, workspacePath: workspace.path, board: result.board, changeId: result.changeId, lastChange: result.lastChange });
    },
  })), 'project-board tool: update');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_board_dispatch',
    description: '把项目看板上的任务或待办派发为 Agent Team 任务，并把 team task id 回写到看板。只能在 Agent Team 的 Lead 会话中调用。',
    parameters: {
      workspacePath: workspaceArg,
      expectedRevision: { type: 'integer', description: '当前看板 revision；省略则不检查' },
      commandId: { type: 'string', description: '幂等命令 id' },
      leadSessionId: { type: 'string', description: 'Team Lead 会话 id；省略时使用当前会话（必须是 Team Lead）' },
      items: {
        type: 'array',
        description: '要派发的条目：{taskId} 或 {todoId}',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string' },
            todoId: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 120000,
    execute: async (args, exec) => {
      const agent = exec.agent;
      const workspace = toolWorkspace(agent, args.workspacePath);
      const leadSessionId = args.leadSessionId || agent?.id;
      const result = await service.dispatch({
        workspacePath: workspace.path,
        expectedRevision: args.expectedRevision,
        commandId: args.commandId,
        leadSessionId,
        items: args.items || [],
        actor: `agent:${agent?.id || 'unknown'}`,
      });
      return jsonSafe({ workspacePath: workspace.path, revision: result.board.revision, created: result.created });
    },
  })), 'project-board tool: dispatch');

  // ---- per-agent board digest ---------------------------------------------
  const installed = new WeakSet();
  const installDigest = (agent) => {
    if (!agent || installed.has(agent)) return;
    installed.add(agent);
    try {
      agent.ctx.systemPrompt.context({
        name: 'project_board',
        order: 150,
        text: () => {
          try {
            return digestForAgent(agent);
          } catch {
            return '';
          }
        },
      });
    } catch (error) {
      ctx.logger?.warn?.(`project-board prompt context failed: ${error?.message || error}`);
    }
  };
  ctx.effect(() => {
    for (const agent of ctx.agents.list()) installDigest(agent);
    const off = ctx.on('agent/created', ({ agent }) => installDigest(agent));
    return () => { if (typeof off === 'function') off(); };
  }, 'project-board prompt context');

  /** Synchronous digest computation used from the prompt provider. */
  function digestForAgent(agent) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return '';
    const workspaces = service.registryWorkspaces();
    const matches = workspaces.filter((row) => cwd === row.path || cwd.startsWith(row.path + path.sep));
    const root = matches.length ? matches.sort((a, b) => b.path.length - a.path.length)[0].path : cwd;
    const file = path.join(root, 'board', 'project-board.json');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return '';
    }
    const cached = digestCache.get(file);
    let board = cached && cached.mtimeMs === stat.mtimeMs ? cached.board : null;
    if (!board) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        board = normalizeBoard(raw, { workspacePath: root, title: path.basename(root) });
        digestCache.set(file, { mtimeMs: stat.mtimeMs, board });
      } catch {
        return '';
      }
    }
    const teamTasks = service.teamTasksFor(agent);
    const sessionId = agent?.id;
    // 摘要统一识别任务和待办的全部绑定，系统提示与读取工具保持一致。
    let digest = boardDigest(board, { workspacePath: root, teamTasks, sessionId });
    if (board.assistant && board.assistant.sessionId === sessionId) {
      digest = '你是这个 workspace 的「项目看板 Lead」（Agent Team Lead），用户正在看板页面与你对话。你可以用 project_board_get 读取看板、project_board_update 直接修改节点/连线/任务/待办（用户的语言调整请求直接执行，不要只给建议）；也可以用 spawn_teammate、team_task_*、send_message、wait_agent 组织 Agent Team 执行看板任务；用 project_board_dispatch 把看板任务派发成 Team 任务。修改后简短说明改了什么。除非用户明确要求，不要修改项目文件或运行实验。\n' + digest;
    }
    return digest;
  }
}
export { name, inject, apply };
