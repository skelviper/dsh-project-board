// 浏览器与宿主共用的纯函数，不依赖 DOM、React 或 Node API。
export function pbNodeIdsInScope(board, nodeId = null) {
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

export function pbScopeStats(board, nodeId = null) {
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

export function pbShortSummary(text, max = 120) {
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 120;
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (value.length <= limit) return value;
  return limit > 1 ? value.slice(0, limit - 1) + '…' : limit ? '…' : '';
}
