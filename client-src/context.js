// 任务背景作为可编辑、未发送的原生草稿，不以打开会话代替发送操作。
function pbTaskConversationContext(board, item, targetType) {
  if (!board || !item) return '';
  const task = targetType === 'todo' ? board.tasks.find((row) => row.id === item.taskId) : item;
  const node = task ? board.nodes.find((row) => row.id === task.nodeId) : null;
  const workspacePath = board.workspacePath || '';
  const clip = (text, max = 3000) => typeof text === 'string' && text.length > max ? text.slice(0, max) + '…（完整内容见看板）' : text || '';
  const lines = [
    '项目看板 · 当前' + (targetType === 'todo' ? '待办' : '任务') + '上下文',
    'workspace: ' + workspacePath,
    '看板文件: ' + workspacePath.replace(/\/$/, '') + '/board/project-board.json',
    '看板版本: ' + board.revision,
  ];
  if (node) {
    lines.push('节点: ' + node.title + '（node ' + node.id + '）');
    if (node.summary) lines.push('节点概览: ' + clip(node.summary));
  }
  if (task) {
    lines.push('任务: ' + task.title + '（task ' + task.id + '，状态 ' + (PB_STATUS_META[task.status]?.label || task.status) + '）');
    if (task.acceptance) lines.push('任务要求与验收: ' + clip(task.acceptance, 6000));
    if (task.writeScopes?.length) lines.push('任务文件范围: ' + clip(task.writeScopes.join('、')));
    if (task.blockedBy?.length) lines.push('前置任务: ' + task.blockedBy.map((id) => {
      const row = board.tasks.find((candidate) => candidate.id === id);
      return row ? row.title + '（' + id + '，' + (PB_STATUS_META[row.status]?.label || row.status) + '）' : id;
    }).join('；'));
  }
  if (targetType === 'todo') {
    lines.push('待办: ' + item.title + '（todo ' + item.id + '，状态 ' + (PB_STATUS_META[item.status]?.label || item.status) + '）');
    if (item.acceptance) lines.push('待办要求与验收: ' + clip(item.acceptance, 6000));
  } else if (task) {
    const todos = board.todos.filter((row) => row.taskId === task.id);
    if (todos.length) lines.push('任务待办:\n' + todos.slice(0, 20).map((row) => '- ' + row.title + '（todo ' + row.id + '，' + (PB_STATUS_META[row.status]?.label || row.status) + '）').join('\n'));
  }
  const files = [...(node?.links || []), ...(task?.artifacts || []), ...(targetType === 'todo' ? item.artifacts || [] : [])];
  if (files.length) lines.push('关联文件与产物:\n' + files.slice(0, 20).map((row) => '- ' + (row.label ? row.label + ': ' : '') + row.path).join('\n'));
  const targets = new Set(['board:', ...(node ? ['node:' + node.id] : []), ...(task ? ['task:' + task.id] : []), ...(targetType === 'todo' ? ['todo:' + item.id] : [])]);
  const notes = (board.notes || []).filter((row) => targets.has(row.targetType + ':' + (row.targetType === 'board' ? '' : row.targetId))).slice(-5);
  if (notes.length) lines.push('相关备注:\n' + notes.map((row) => '- ' + clip(row.text, 1200)).join('\n'));
  lines.push('这是打开会话时的任务背景。处理前请用 project_board_get 读取最新详情，以我接下来输入的要求为准；按实际进展回写对应任务或待办。');
  return lines.join('\n');
}

function pbTaskConversationDraft(context) {
  return context ? context + '\n\n我的要求：\n' : undefined;
}
