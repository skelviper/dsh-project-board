import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { pbSessionConversationContext } from '../board-model.js';

const source = await fs.readFile(new URL('../client-src/context.js', import.meta.url), 'utf8');
const { pbTaskConversationContext, pbLegacyTaskDraftPrefix, pbRestoreConversationDraft } = vm.runInNewContext(`(function () { ${source}; return { pbTaskConversationContext, pbLegacyTaskDraftPrefix, pbRestoreConversationDraft }; })()`, {
  PB_STATUS_META: { todo: { label: '待办' }, done: { label: '完成' } },
});
const board = {
  workspacePath: '/project', revision: 12,
  nodes: [{ id: 'node-a', title: '方法节点', summary: '需要保留的节点背景', links: [{ path: 'input/method.pdf', label: '方法说明' }] }],
  tasks: [
    { id: 'task-a', nodeId: 'node-a', title: '核查新方法', status: 'todo', acceptance: '先比较协议再决定是否执行', writeScopes: ['notes/'], blockedBy: ['task-b'], artifacts: [{ path: 'notes/comparison.md' }], threads: [{ sessionId: 'task-session' }] },
    { id: 'task-b', nodeId: 'node-a', title: '准备输入', status: 'done' },
  ],
  todos: [{ id: 'todo-a', taskId: 'task-a', title: '比较假设', status: 'todo', acceptance: '列出双方假设', artifacts: [{ path: 'notes/assumptions.tsv' }], threads: [{ sessionId: 'todo-session' }] }],
  notes: [
    { targetType: 'board', targetId: 'ignored-board-id', text: '项目约定备注' },
    { targetType: 'node', targetId: 'node-a', text: '节点备注' },
    { targetType: 'task', targetId: 'task-a', text: '当前任务备注' },
    { targetType: 'todo', targetId: 'todo-a', text: '当前待办备注' },
    { targetType: 'task', targetId: 'unrelated', text: '不应混入的其他任务备注' },
  ],
};
const legacy = () => pbTaskConversationContext(board, board.todos[0], 'todo') + '\n\n我的要求：\n';

test('未绑定新会话的背景预览保留当前要求、依赖和对应备注', () => {
  const context = pbTaskConversationContext(board, board.tasks[0], 'task');
  for (const expected of ['workspace: /project', 'node node-a', 'task task-a', '先比较协议再决定是否执行', 'notes/', '准备输入', '当前任务备注']) assert(context.includes(expected), expected);
  assert(!context.includes('不应混入的其他任务备注'));
});

test('实际关联预览与宿主共用，待办关联带父任务，自身任务会话不冒认待办', () => {
  const context = pbSessionConversationContext(board, 'todo-session');
  for (const expected of ['task task-a', 'todo todo-a', '先比较协议再决定是否执行', '列出双方假设', '当前任务备注', '当前待办备注']) assert(context.includes(expected), expected);
  assert(!context.includes('不应混入的其他任务备注'));
  assert(!pbSessionConversationContext(board, 'task-session').includes('todo todo-a'));
  assert.equal(pbSessionConversationContext(board, 'unbound'), '');
});

test('机器模板迁移只删除完整已知前缀，保留用户后缀引用及附件', () => {
  const prefix = legacy(), suffix = '接着上次改\n@note';
  const input = { draft: prefix + suffix, draftRev: 9, phase: 'plain', occurrences: [{ offset: prefix.length + suffix.indexOf('@note'), length: 5, ref: 'note' }], attachmentIds: ['image-1'] };
  const actions = { insertText(text, span) {
    assert.equal(text, ''); assert.equal(span.draftRev, input.draftRev);
    const removed = span.end - span.start;
    input.draft = input.draft.slice(0, span.start) + text + input.draft.slice(span.end);
    input.occurrences = input.occurrences.map(row => ({ ...row, offset: row.offset - removed }));
    return true;
  } };
  assert.equal(pbRestoreConversationDraft(input, actions, '/project'), true);
  assert.equal(input.draft, suffix);
  assert.equal(input.occurrences[0].ref, 'note');
  assert.equal(input.occurrences[0].offset, suffix.indexOf('@note'));
  assert.deepEqual(input.attachmentIds, ['image-1']);
});

test('纯机器草稿与尾换行规范化可清除，普通草稿和其他workspace完整保留', () => {
  const prefix = legacy();
  assert.equal(pbLegacyTaskDraftPrefix(prefix, '/project'), prefix);
  assert.equal(pbLegacyTaskDraftPrefix(prefix.trimEnd(), '/project'), prefix.trimEnd());
  for (const text of ['继续上面的图', '我的要求：\n只改布局', '引用这段模板：\n' + prefix, prefix.replace('project_board_get', '我改过的背景')]) assert.equal(pbLegacyTaskDraftPrefix(text, '/project'), '');
  assert.equal(pbLegacyTaskDraftPrefix(prefix, '/other'), '');
});

test('提交中、引用落在模板区或revision已变化时不改草稿', () => {
  let calls = 0;
  const base = { draft: legacy(), draftRev: 4, phase: 'plain', occurrences: [] };
  const actions = { insertText() { calls++; return false; } };
  assert.equal(pbRestoreConversationDraft({ ...base, phase: 'submitting' }, actions, '/project'), false);
  assert.equal(pbRestoreConversationDraft({ ...base, occurrences: [{ offset: 10 }] }, actions, '/project'), false);
  assert.equal(calls, 0);
  assert.equal(pbRestoreConversationDraft(base, actions, '/project'), false);
  assert.equal(calls, 1, 'revision由原生范围CAS最终检查，不强制覆盖');
});

test('无关看板变动不改变关联投影，实际要求变化立即体现，长背景有界', () => {
  const original = pbSessionConversationContext(board, 'todo-session');
  const changed = structuredClone(board);
  changed.revision++; changed.updatedAt = 'later'; changed.nodes[0].x = 99;
  changed.tasks[1].title = '其他任务改名';
  assert.equal(pbSessionConversationContext(changed, 'todo-session'), original);
  changed.todos[0].acceptance = '新要求 {{literal}}';
  assert.match(pbSessionConversationContext(changed, 'todo-session'), /新要求 \{\{literal\}\}/);
  changed.todos[0].acceptance = '长'.repeat(20000);
  assert(pbSessionConversationContext(changed, 'todo-session').length < 11000);
});
