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

// 同一份关联背景用于模型运行时上下文与界面预览；无关看板变化不改变这段内容。
export function pbSessionConversationContext(board, sessionId) {
  if (!board || typeof sessionId !== 'string' || !sessionId) return '';
  const bound = item => (Array.isArray(item?.threads) ? item.threads : item?.thread ? [item.thread] : []).some(row => row.sessionId === sessionId);
  const todos = (board.todos || []).filter(bound);
  const parentIds = new Set(todos.map(todo => todo.taskId));
  const tasks = (board.tasks || []).filter(task => bound(task) || parentIds.has(task.id));
  if (!tasks.length && !todos.length) return '';
  const clip = (value, max = 1200) => typeof value !== 'string' ? '' : value.length > max ? value.slice(0, max) + '…（完整内容见看板）' : value;
  const status = value => ({ todo: '待办', doing: '进行中', active: '进行中', blocked: '受阻', done: '完成', deferred: '暂缓', dropped: '放弃', historical: '历史' })[value] || value || '待办';
  const lines = [
    '当前会话关联的任务背景（自动提供给 AI）',
    'workspace: ' + (board.workspacePath || ''),
    '沿用本会话的历史、图片和已有决定，直接处理用户本次的新要求。以下为任务记录，以用户最新明确指令为准；关联、完成状态或打开页面本身不构成执行新工作的指令。',
    '需要完整要求、来源或最新进展时用 project_board_get 读取对应任务/待办；只在实际完成工作后回写对应条目。',
  ];
  const seenNodes = new Set();
  function details(item, type) {
    lines.push((type === 'task' ? '任务' : '待办') + ': ' + clip(item.title, 180) + '（' + type + ' ' + item.id + '，' + status(item.status) + '）');
    if (item.acceptance) lines.push('要求与验收: ' + clip(item.acceptance, 1800));
    if (item.writeScopes?.length) lines.push('文件范围: ' + clip(item.writeScopes.join('、'), 500));
    if (item.blockedBy?.length) lines.push('前置任务: ' + clip(item.blockedBy.join('、'), 400));
    if (item.delivery?.summary) lines.push('当前交付: ' + clip(item.delivery.summary, 800));
    if (item.delivery?.review && item.delivery.review !== 'none') lines.push('验收状态: ' + item.delivery.review);
    const paths = [...new Set([item.primaryArtifactPath, ...(item.artifacts || []).map(row => row.path)].filter(Boolean))];
    if (paths.length) lines.push('关联成果: ' + clip(paths.slice(0, 5).join('、'), 600));
    const notes = (board.notes || []).filter(row => row.targetType === type && row.targetId === item.id).slice(-2);
    if (notes.length) lines.push('条目备注: ' + notes.map(row => clip(row.text, 350)).join('；'));
  }
  for (const task of tasks.slice(0, 6)) {
    const node = (board.nodes || []).find(row => row.id === task.nodeId);
    if (node && !seenNodes.has(node.id)) {
      seenNodes.add(node.id);
      lines.push('节点: ' + clip(node.title, 180) + '（node ' + node.id + '）');
      if (node.summary) lines.push('节点概览: ' + clip(node.summary, 500));
    }
    details(task, 'task');
    for (const todo of todos.filter(row => row.taskId === task.id).slice(0, 6)) details(todo, 'todo');
  }
  if (tasks.length > 6 || todos.length > 6) lines.push('关联条目较多，完整关联请用 project_board_get 查看。');
  const text = lines.join('\n');
  return clip(text, 10000);
}

export function pbShortSummary(text, max = 120) {
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 120;
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (value.length <= limit) return value;
  return limit > 1 ? value.slice(0, limit - 1) + '…' : limit ? '…' : '';
}
