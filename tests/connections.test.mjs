import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BoardService } from '../service.mjs';

const source = (await fs.readFile(new URL('../board-model.js', import.meta.url), 'utf8')).replace(/^export /gm, '') + '\n' + (await Promise.all(['state.js', 'explorer.js', 'canvas.js'].map(name => fs.readFile(new URL('../client-src/' + name, import.meta.url), 'utf8')))).join('\n');
const React = {
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
  useRef(value) { return { current: value }; }, useState(value) { return [value, () => {}]; },
  useEffect() {}, useLayoutEffect() {},
};
const { pbPlanConnection, pbNodeBranchPath, BoardCanvas } = vm.runInNewContext(`(() => { ${source}; return { pbPlanConnection, pbNodeBranchPath, BoardCanvas }; })()`, { React, PbExecutionBadge: function PbExecutionBadge() {} });
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

function canvasRows(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(canvasRows);
  return [tree, ...(tree.children || []).flatMap(canvasRows)];
}
const canvasText = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(canvasText).join('') : tree && typeof tree === 'object' ? canvasText(tree.children) : '';
function genericBoard() {
  const kinds = ['figure', 'milestone', 'component', 'document'];
  const nodes = kinds.map((kind, index) => ({ id: kind, kind, title: kind, x: index * 320, y: 0, w: 305 }));
  return { nodes, edges: [], tasks: kinds.slice(0, 3).flatMap(kind => Array.from({ length: 4 }, (_, index) => ({ id: kind + '-' + index, nodeId: kind, title: kind + ' task ' + index, status: 'todo' }))), todos: [] };
}

test('通用里程碑和模块保留三项任务预览与宽度，图例按实际类型生成', () => {
  const { rows } = cards({ board: genericBoard(), connectMode: false });
  for (const kind of ['figure', 'milestone', 'component']) {
    const card = rows.find(row => row.props['data-node-id'] === kind);
    assert.equal(card.props.style.width, 305);
    assert.equal(canvasRows(card).filter(row => row.props?.['data-preview-task-id']).length, 3);
    assert.ok(canvasRows(card).some(row => row.props?.['aria-label'] === `展开${kind}全部 4 项任务`));
  }
  assert.equal(rows.find(row => row.props['data-node-id'] === 'document').props.style.width, 230);
  const tree = BoardCanvas({ board: genericBoard(), view: { x: 0, y: 0, scale: 1 }, executionFor: () => ({ kind: 'idle' }) });
  const legend = canvasRows(tree).find(row => row.props?.className === 'pb-legend');
  for (const label of ['主题', '图', '里程碑', '模块', '文档']) assert.match(canvasText(legend), new RegExp(label));
  assert.doesNotMatch(canvasText(legend), /实验|文稿/);
});

function persistentCanvas(board, workspacePath, storage) {
  const slots = [];
  let cursor = 0, effects = [];
  const react = {
    createElement: React.createElement,
    useState(initial) { const at = cursor++; if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[at].value, next => { slots[at].value = typeof next === 'function' ? next(slots[at].value) : next; }]; },
    useRef(initial) { const at = cursor++; return slots[at] ||= { current: initial }; },
    useEffect(effect, dependencies) {
      const at = cursor++;
      if (!dependencies || !slots[at] || dependencies.some((value, index) => !Object.is(value, slots[at][index]))) { slots[at] = dependencies; effects.push(effect); }
    },
  };
  react.useLayoutEffect = react.useEffect;
  const renderCanvas = vm.runInNewContext(source + '\nBoardCanvas;', {
    React: react, PbExecutionBadge: function PbExecutionBadge() {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  return () => {
    cursor = 0; effects = [];
    const tree = renderCanvas({ board, workspacePath, view: { x: 0, y: 0, scale: 1 }, executionFor: () => ({ kind: 'idle' }) });
    for (const effect of effects) effect();
    return tree;
  };
}

test('通用节点展开按项目恢复，另一项目独立，保存的节点位置不变', () => {
  const board = genericBoard(), before = structuredClone(board), storage = new Map();
  const render = persistentCanvas(board, '/project-a', storage);
  const toggle = canvasRows(render()).find(row => row.props?.['aria-label'] === '展开milestone全部 4 项任务');
  toggle.props.onClick(event());
  const milestoneTasks = tree => canvasRows(tree).filter(row => row.props?.['data-preview-task-id']?.startsWith('milestone-')).length;
  assert.equal(milestoneTasks(render()), 4);
  assert.equal(milestoneTasks(persistentCanvas(board, '/project-a', storage)()), 4);
  assert.equal(milestoneTasks(persistentCanvas(board, '/project-b', storage)()), 3);
  assert.deepEqual(board, before);
});
