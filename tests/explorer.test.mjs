import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../board-model.js', import.meta.url), 'utf8').replace(/^export /gm, '') + '\n' + ['state.js', 'context.js', 'conversations.js', 'execution.js', 'explorer.js'].map(name => fs.readFileSync(new URL('../client-src/' + name, import.meta.url), 'utf8')).join('\n');
const data = new Map();
const api = vm.runInNewContext(source + '\n({pbSearchRows,pbInboxRows,pbPrimaryArtifact,pbWorkspaceView,pbWriteLocal,pbDeliveryLabel})', { React: { createElement() {}, createContext: () => ({ Provider: 'provider' }) }, localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } });
function board() { return { nodes: [{ id: 'theme', kind: 'theme', title: '论文' }, { id: 'deep', kind: 'experiment', title: '子实验' }, { id: 'loose', kind: 'figure', title: '未归属图' }], edges: [{ kind: 'contains', from: 'theme', to: 'deep' }], tasks: [{ id: 'task', nodeId: 'deep', title: '父任务', status: 'doing', threads: [{ sessionId: 'session' }], artifacts: [] }, { id: 'result', nodeId: 'loose', title: '条件未触发', status: 'done', delivery: { summary: '预算条件未触发，全部记录已交付', outcome: 'not_triggered', review: 'pending', submittedAt: '2026-10-19' }, artifacts: [{ path: 'result.tsv', label: '证据' }], primaryArtifactPath: 'result.tsv' }], todos: [{ id: 'todo', taskId: 'task', title: '等待回答', status: 'blocked', threads: [{ sessionId: 'session' }] }], decisions: [{ id: 'question', nodeId: 'loose', question: '如何安排后续', status: 'open', updatedAt: '1' }] }; }
test('搜索同时覆盖后代、结论与文件；分支/类型/状态/结论组合筛选', () => {
  const value = board();
  assert.deepEqual(Array.from(api.pbSearchRows(value, { branch: 'theme' }), row => row.item.id), ['theme', 'deep', 'task', 'todo']);
  assert.deepEqual(Array.from(api.pbSearchRows(value, { branch: 'unparented', query: '证据 result.tsv', status: 'done', kind: 'figure', outcome: 'not_triggered' }), row => row.item.id), ['result']);
  assert.equal(api.pbSearchRows(value, { query: '不匹配' }).length, 0);
});
test('待处理问题按真实等待去重，普通完成/回复不自动变成待验收', () => {
  const value = board(), statuses = new Map([['session', { pendingInteraction: { id: 'pending-1' } }]]);
  const rows = api.pbInboxRows(value, { byId: {} }, statuses);
  assert.equal(rows.filter(row => row.kind === 'question').length, 1);
  assert.equal(rows.find(row => row.kind === 'question').targetId, 'todo');
  assert.equal(rows.find(row => row.kind === 'review').targetId, 'result');
  assert.equal(rows.filter(row => row.kind === 'blocked').length, 1);
  assert.equal(rows.filter(row => row.kind === 'decision').length, 1);
  value.tasks[1].delivery.review = 'accepted';
  assert.equal(api.pbInboxRows(value, { byId: {} }, new Map()).length, 2);
});
test('主成果必须显式指定且存在；视口按workspace独立并拒绝异常值', () => {
  const item = board().tasks[1]; assert.equal(api.pbPrimaryArtifact(item).path, 'result.tsv');
  assert.equal(api.pbPrimaryArtifact({ ...item, primaryArtifactPath: 'gone' }), null);
  assert.match(api.pbDeliveryLabel(item), /条件未触发.*待验收/);
  api.pbWriteLocal('dsh.project-board.view.v2:/A', { x: 7, y: 12, scale: .8 });
  assert.equal(api.pbWorkspaceView('/A').scale, .8); assert.equal(api.pbWorkspaceView('/B'), null);
  data.set('dsh.project-board.view.v2:/A', '{broken'); assert.equal(api.pbWorkspaceView('/A'), null);
  api.pbWriteLocal('dsh.project-board.view.v2:/A', { x: 0, y: 0, scale: 500 }); assert.equal(api.pbWorkspaceView('/A'), null);
});

test('里程碑、模块和文档支持分支与类型筛选，交付摘要仍可搜索', () => {
  const value = board();
  for (const kind of ['milestone', 'component', 'document']) {
    value.nodes.push({ id: kind, kind, title: kind, status: 'todo' });
    value.edges.push({ kind: 'contains', from: 'theme', to: kind });
    value.tasks.push({ id: kind + '-delivery', nodeId: kind, title: '发布交付', status: 'done', delivery: { summary: '通过评审的交付', review: 'accepted' } });
    assert.deepEqual(Array.from(api.pbSearchRows(value, { branch: 'theme', kind, status: 'done', query: '评审 交付' }), row => row.item.id), [kind + '-delivery']);
  }
});
