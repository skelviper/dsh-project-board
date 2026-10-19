import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BoardService } from '../service.mjs';

const source = (await Promise.all(['state.js', 'canvas.js'].map(name => fs.readFile(new URL('../client-src/' + name, import.meta.url), 'utf8')))).join('\n');
const React = {
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
  useRef(value) { return { current: value }; }, useState(value) { return [value, () => {}]; },
  useEffect() {}, useLayoutEffect() {},
};
const { pbPlanConnection, pbNodeBranchPath, BoardCanvas } = vm.runInNewContext(`(() => { ${source}; return { pbPlanConnection, pbNodeBranchPath, BoardCanvas }; })()`, { React });
const fixture = () => ({
  nodes: [{ id: 'a', title: '探索性实验', kind: 'theme', x: 20, y: 30 }, { id: 'b', title: 'baseline', kind: 'theme', x: 320, y: 30 }, { id: 'c', title: '新节点', kind: 'experiment', x: 40, y: 230 }, { id: 'd', title: '下一级', kind: 'experiment', x: 60, y: 400 }],
  edges: [{ id: 'old', from: 'a', to: 'c', kind: 'contains', createdAt: '2026-10-19T00:00:00Z' }, { id: 'sub', from: 'c', to: 'd', kind: 'contains' }, { id: 'dep', from: 'c', to: 'b', kind: 'depends' }],
  tasks: [{ id: 'task', nodeId: 'c', title: '保留任务', status: 'doing', threads: [{ sessionId: 'session-original' }] }],
  todos: [{ id: 'todo', taskId: 'task', title: '保留待办', status: 'todo', artifacts: [{ path: 'result.png' }] }],
});
const plain = value => JSON.parse(JSON.stringify(value));

test('新建归属使用contains，重复连接没有写命令', () => {
  const board = fixture(); board.edges = board.edges.filter(e => e.id !== 'old');
  const plan = pbPlanConnection(board, 'a', 'c', 'contains');
  assert.equal(plan.commands.length, 1);
  assert.deepEqual(plain(plan.commands[0].input.edge), { from: 'a', to: 'c', kind: 'contains', label: '' });
  assert.equal(pbPlanConnection(fixture(), 'a', 'c', 'contains').commands.length, 0);
});

test('换分支只更新原边ID，保留位置、子分支、任务、待办与线程', () => {
  const board = fixture(), before = structuredClone(board);
  const plan = pbPlanConnection(board, 'b', 'c', 'contains');
  assert.deepEqual(plain(plan.commands), [{ action: 'upsert_edge', input: { edge: { id: 'old', from: 'b', to: 'c', kind: 'contains', label: '' } } }]);
  const service = new BoardService({ ctx: {} });
  for (const command of plan.commands) service.applyCommand(board, command.action, command.input, 'test');
  assert.deepEqual(board.nodes, before.nodes); assert.deepEqual(board.tasks, before.tasks); assert.deepEqual(board.todos, before.todos);
  assert.equal(board.edges.find(e => e.id === 'old').createdAt, before.edges[0].createdAt);
  assert.deepEqual(board.edges.filter(e => e.id !== 'old'), before.edges.filter(e => e.id !== 'old'));
  assert.deepEqual(plain(pbNodeBranchPath(board, 'd')).map(n => n.id), ['b', 'c']);
});

test('已有目标父边仍清理legacy多父，不影响依赖与产出', () => {
  const board = fixture(); board.edges.push({ id: 'newparent', from: 'b', to: 'c', kind: 'contains' }, { id: 'output', from: 'a', to: 'c', kind: 'produces' });
  const plan = pbPlanConnection(board, 'b', 'c', 'contains');
  assert.deepEqual(plain(plan.commands), [{ action: 'delete_edge', input: { id: 'old' } }]);
  assert.equal(pbPlanConnection(board, 'a', 'c', 'produces').commands.length, 0);
  assert.equal(pbPlanConnection(board, 'a', 'b', 'depends').commands[0].input.edge.kind, 'depends');
});

test('拒绝自连接、失效节点及归属祖先环，但不把depends当归属', () => {
  const board = fixture();
  assert.throws(() => pbPlanConnection(board, 'c', 'c', 'contains'), /自身/);
  assert.throws(() => pbPlanConnection(board, 'missing', 'c', 'contains'), /节点已更新/);
  assert.throws(() => pbPlanConnection(board, 'd', 'a', 'contains'), /归属循环/);
  assert.equal(pbPlanConnection(board, 'b', 'c', 'contains').commands.length, 1);
  assert.throws(() => pbPlanConnection(board, 'a', 'c', 'other'), /请选择/);
});

test('父路径安全处理未归属、失效边、旧环与多个父节点', () => {
  const board = fixture();
  assert.deepEqual(plain(pbNodeBranchPath(board, 'b')), []);
  board.edges.push({ id: 'bad', from: 'd', to: 'a', kind: 'contains' });
  const result = plain(pbNodeBranchPath(board, 'd')).map(n => n.id);
  assert.equal(new Set(result).size, result.length); assert.ok(!result.includes('d'));
  board.edges.unshift({ id: 'missing', from: 'missing', to: 'c', kind: 'contains' });
  assert.deepEqual(plain(pbNodeBranchPath(board, 'c')), []);
});

function cards(options = {}) {
  const calls = [];
  const tree = BoardCanvas({ board: fixture(), connectMode: true, connectSource: null, connectPending: false, connectionHint: '归属', view: { x: 0, y: 0, scale: 1 }, onConnectNode: id => calls.push(id), executionFor: () => ({ kind: 'idle' }), ...options });
  const found = [];
  function walk(row) { if (!row || typeof row !== 'object') return; if (row.props?.['data-node-id']) found.push(row); for (const child of row.children || []) { if (Array.isArray(child)) child.forEach(walk); else walk(child); } }
  walk(tree); return { calls, rows: found };
}
function event(key, extra = {}) { const target = {}; return { key, target, currentTarget: target, button: 0, repeat: false, preventDefault() {}, stopPropagation() {}, ...extra }; }

test('真实卡片pointerdown+click只激活一次，连接时不触发位置保存', () => {
  const moved = [], { calls, rows } = cards({ onMoveNodes: value => moved.push(value) });
  const node = rows.find(n => n.props['data-node-id'] === 'a');
  node.props.onPointerDown(event()); node.props.onClick(event());
  assert.deepEqual(calls, ['a']); assert.deepEqual(moved, []);
  assert.equal(node.props.role, 'button'); assert.equal(node.props.tabIndex, 0);
});

test('卡片Enter和Space各激活一次，忽略repeat、子控件及pending', () => {
  const { calls, rows } = cards(), node = rows[0];
  node.props.onKeyDown(event('Enter')); node.props.onKeyUp(event('Enter'));
  node.props.onKeyDown(event(' ')); node.props.onKeyUp(event(' '));
  node.props.onKeyDown(event('Enter', { repeat: true }));
  node.props.onKeyDown(event('Enter', { target: {} }));
  assert.deepEqual(calls, ['a', 'a']);
  const waiting = cards({ connectPending: true });
  waiting.rows[0].props.onClick(event()); waiting.rows[0].props.onKeyDown(event('Enter')); waiting.rows[0].props.onKeyUp(event(' '));
  assert.deepEqual(waiting.calls, []);
});
