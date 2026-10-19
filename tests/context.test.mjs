import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../client-src/context.js', import.meta.url), 'utf8');
const { pbTaskConversationContext, pbTaskConversationDraft } = vm.runInNewContext(`(function () { ${source}; return { pbTaskConversationContext, pbTaskConversationDraft }; })()`, {
  PB_STATUS_META: { todo: { label: '待办' }, done: { label: '完成' } },
});
const board = {
  workspacePath: '/project', revision: 12,
  nodes: [{ id: 'node-a', title: '方法节点', summary: '需要保留的节点背景', links: [{ path: 'input/method.pdf', label: '方法说明' }] }],
  tasks: [
    { id: 'task-a', nodeId: 'node-a', title: '核查新方法', status: 'todo', acceptance: '先比较协议再决定是否执行', writeScopes: ['notes/'], blockedBy: ['task-b'], artifacts: [{ path: 'notes/comparison.md' }] },
    { id: 'task-b', nodeId: 'node-a', title: '准备输入', status: 'done' },
  ],
  todos: [{ id: 'todo-a', taskId: 'task-a', title: '比较假设', status: 'todo', acceptance: '列出双方假设', artifacts: [{ path: 'notes/assumptions.tsv' }] }],
  notes: [
    { targetType: 'board', targetId: 'ignored-board-id', text: '项目约定备注' },
    { targetType: 'node', targetId: 'node-a', text: '节点备注' },
    { targetType: 'task', targetId: 'task-a', text: '当前任务备注' },
    { targetType: 'todo', targetId: 'todo-a', text: '当前待办备注' },
    { targetType: 'task', targetId: 'unrelated', text: '不应混入的其他任务备注' },
  ],
};

test('任务草稿包含节点背景、要求、依赖、文件及对应备注', () => {
  const context = pbTaskConversationContext(board, board.tasks[0], 'task');
  for (const expected of ['workspace: /project', '/project/board/project-board.json', '看板版本: 12', 'node node-a', 'task task-a', '需要保留的节点背景', '先比较协议再决定是否执行', 'notes/', '准备输入', 'input/method.pdf', 'notes/comparison.md', '项目约定备注', '当前任务备注', '比较假设']) assert(context.includes(expected), expected);
  assert(!context.includes('不应混入的其他任务备注'));
  assert(!context.includes('当前待办备注'));
});

test('待办上下文同时保留父任务与自身的验收和文件', () => {
  const context = pbTaskConversationContext(board, board.todos[0], 'todo');
  for (const expected of ['node node-a', 'task task-a', 'todo todo-a', '先比较协议再决定是否执行', '列出双方假设', 'notes/assumptions.tsv', '当前任务备注', '当前待办备注']) assert(context.includes(expected), expected);
  assert(!context.includes('不应混入的其他任务备注'));
});

test('初始内容是可编辑的未发送背景，等待用户补充要求', () => {
  const context = pbTaskConversationContext(board, board.tasks[0], 'task');
  const draft = pbTaskConversationDraft(context);
  assert(draft.startsWith(context));
  assert(draft.endsWith('\n\n我的要求：\n'));
  assert(!draft.includes('请直接继续执行'));
  assert.equal(pbTaskConversationDraft(''), undefined);
});

test('过长的要求明确指向完整看板而不会生成无限长草稿', () => {
  const item = { ...board.tasks[0], acceptance: '长'.repeat(20000) };
  const context = pbTaskConversationContext(board, item, 'task');
  assert(context.includes('完整内容见看板'));
  assert(context.length < 10000);
});
