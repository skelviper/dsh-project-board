import test from 'node:test';
import assert from 'node:assert/strict';
import { pbNodeIdsInScope, pbScopeStats, pbShortSummary } from '../board-model.js';
import { normalizeBoard, boardDigest } from '../schema.mjs';

function graph() {
  return normalizeBoard({
    title: '统计测试',
    nodes: [{ id: 'root', kind: 'theme', title: '主题' }, { id: 'a' }, { id: 'b' }, { id: 'deep' }, { id: 'loose', title: '未归属节点' }],
    edges: [
      { id: 'e1', from: 'root', to: 'a', kind: 'contains' }, { id: 'e2', from: 'root', to: 'b', kind: 'contains' },
      { id: 'e3', from: 'a', to: 'deep', kind: 'contains' }, { id: 'e4', from: 'b', to: 'deep', kind: 'contains' },
      { id: 'cycle', from: 'deep', to: 'root', kind: 'contains' }, { id: 'dependency', from: 'root', to: 'loose', kind: 'depends' },
    ],
    tasks: [
      { id: 'root-task', nodeId: 'root', status: 'done' },
      { id: 'parent', nodeId: 'deep', status: 'done' },
      { id: 'defer', nodeId: 'a', status: 'deferred' },
      { id: 'history', nodeId: 'b', status: 'historical' },
      { id: 'loose-task', nodeId: 'loose', status: 'doing' },
    ],
    todos: [{ id: 'done', taskId: 'parent', status: 'done' }, { id: 'drop', taskId: 'parent', status: 'dropped' }, { id: 'blocked', taskId: 'parent', status: 'blocked' }, { id: 'todo', taskId: 'parent', status: 'todo' }],
  }, { workspacePath: '/tmp/pb-model', now: '2026-01-01T00:00:00Z' });
}

test('范围包含主题本身和多层后代，菱形与环不重复、depends不展开', () => {
  const board = graph();
  assert.deepEqual(new Set(pbNodeIdsInScope(board, 'root')), new Set(['root', 'a', 'b', 'deep']));
  assert.deepEqual(pbNodeIdsInScope(board, 'missing'), []);
  assert.equal(pbNodeIdsInScope(board).length, 5);
  const stats = pbScopeStats(board, 'root');
  assert.deepEqual({ ...stats, nodeIds: null }, { nodeIds: null, taskCount: 4, total: 7, done: 2, doing: 0, blocked: 1, todo: 1, deferred: 1, dropped: 1, historical: 1, closed: 4, pct: 57 });
  assert.equal(pbScopeStats(board).total, 8);
  assert.equal(pbScopeStats(board).doing, 1);
  assert.equal(pbScopeStats(board).pct, 50);
});

test('空范围与脏输入保持稳定，重复ID不双计数', () => {
  assert.equal(pbScopeStats(null).pct, 0);
  assert.equal(pbScopeStats({}, 'x').total, 0);
  const board = graph();
  board.tasks.push(board.tasks[0]); board.todos.push(board.todos[0]);
  assert.equal(pbScopeStats(board).total, 8);
});

test('短摘要压缩空白并明确省略，正文保持原样', () => {
  const text = '  第一行\n\n后续结论  与说明  ';
  assert.equal(pbShortSummary(text), '第一行 后续结论 与说明');
  assert.equal(pbShortSummary(text, 7), '第一行 后续…');
  assert.equal(pbShortSummary(text, 0), '');
  assert.equal(text, '  第一行\n\n后续结论  与说明  ');
});

test('摘要与范围统计一致，保留未归属条目、长备注摘要和约定', () => {
  const board = graph();
  const fullText = '结论已记录。' + '详细证据'.repeat(3000);
  board.notes.push({ id: 'note', targetType: 'board', targetId: '', text: fullText, author: 'user', createdAt: board.createdAt });
  const digest = boardDigest(board);
  assert.match(digest, /全板末级工作项：1 进行 .*2 完成.*已结束 4\/8（50%）/);
  assert.match(digest, /主题（含自身 4 节点；.*已结束 4\/7（57%）/);
  assert.match(digest, /未归属主题：1 节点/);
  assert.match(digest, /结论已记录/);
  assert.match(digest, /正文保留在看板/);
  assert.ok(digest.endsWith('不要另建状态文件。'));
  assert.ok(digest.length <= 4000);
  assert.equal(board.notes[0].text, fullText);
});

test('大量主题和超长问题不会截断摘要末尾约定', () => {
  const board = normalizeBoard({ nodes: Array.from({ length: 100 }, (_, index) => ({ id: `n${index}`, title: '主题'.repeat(100), kind: 'theme' })), decisions: [{ id: 'question', question: '问题'.repeat(5000) }], notes: [{ id: 'long', targetType: 'board', text: '保留最新结论 ' + '证据'.repeat(4000) }] });
  const digest = boardDigest(board);
  assert.match(digest, /全板末级工作项/);
  assert.match(digest, /待决策/);
  assert.match(digest, /保留最新结论/);
  assert.ok(digest.length <= 4000);
  assert.match(digest, /部分条目省略/);
  assert.ok(digest.endsWith('不要另建状态文件。'));
});
