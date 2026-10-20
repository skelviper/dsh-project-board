// 画布框选与多节点整体拖动：直接驱动 BoardCanvas 的真实事件处理函数，不依赖浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../board-model.js', import.meta.url), 'utf8')).replace(/^export /gm, '') + '\n'
  + (await Promise.all(['state.js', 'explorer.js', 'canvas.js'].map((name) => fs.readFile(new URL('../client-src/' + name, import.meta.url), 'utf8')))).join('\n');

const BaseReact = {
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
};

// 带最小 rerender 语义的 React 替身：state/ref 槽位跨渲染保留，effect 只在依赖变化时执行。
function mountReact() {
  const slots = [];
  let cursor = 0;
  let pending = [];
  const documentListeners = [];
  const timers = [];
  const document = {
    addEventListener(type, listener) { documentListeners.push({ type, listener }); },
    removeEventListener(type, listener) {
      const at = documentListeners.findIndex((row) => row.type === type && row.listener === listener);
      if (at >= 0) documentListeners.splice(at, 1);
    },
  };
  const react = {
    createElement: BaseReact.createElement,
    useState(initial) {
      const at = cursor++;
      if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[at];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useRef(initial) {
      const at = cursor++;
      if (!slots[at]) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect(effect, dependencies) {
      const at = cursor++;
      const previous = slots[at];
      if (!dependencies || !previous || dependencies.some((value, index) => !Object.is(value, previous[index]))) {
        slots[at] = dependencies;
        pending.push(effect);
      }
    },
  };
  react.useLayoutEffect = react.useEffect;
  return { react, document, timers, documentListeners, begin() { cursor = 0; pending = []; }, runEffects() { const effects = pending; pending = []; for (const effect of effects) effect(); } };
}

const sandboxReact = mountReact();
const BoardCanvas = vm.runInNewContext(`${source}\nBoardCanvas;`, {
  React: sandboxReact.react,
  PbExecutionBadge: function PbExecutionBadge() {},
  localStorage: { getItem: () => null, setItem: () => {} },
  document: sandboxReact.document,
  setTimeout: (fn, ms) => { sandboxReact.timers.push({ fn, ms }); return sandboxReact.timers.length; },
  clearTimeout: () => {},
});

const fixture = () => ({
  nodes: [
    { id: 'a', kind: 'theme', title: '主题 A', x: 0, y: 0 },
    { id: 'b', kind: 'experiment', title: '实验 B', x: 300, y: 0 },
    { id: 'c', kind: 'document', title: '文档 C', x: 0, y: 400 },
  ],
  edges: [],
  tasks: [],
  todos: [],
});

const plain = (value) => JSON.parse(JSON.stringify(value));

function walk(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(walk);
  return [tree, ...(tree.children || []).flatMap(walk)];
}
const byClass = (tree, className) => walk(tree).find((row) => row.props?.className === className);
const card = (tree, id) => walk(tree).find((row) => row.props?.['data-node-id'] === id);
const selectionPill = (tree) => walk(tree).find((row) => typeof row.props?.className === 'string' && row.props.className.split(' ').includes('pb-selection-pill'));
const text = (tree) => (typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.children) : '');

function event(extra = {}) {
  const target = extra.target || { closest: () => null };
  return {
    button: 0, clientX: 0, clientY: 0, pointerId: 1,
    shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    preventDefault() {}, stopPropagation() {}, target, currentTarget: target,
    ...extra,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function mount(overrides = {}) {
  const state = { selection: overrides.selectedNodeIds ? [...overrides.selectedNodeIds] : [], moves: [], views: [] };
  const props = {
    board: fixture(),
    view: { x: 0, y: 0, scale: 1 },
    executionFor: () => ({ kind: 'idle' }),
    selectedNodeIds: state.selection,
    onSelectNodes: (ids) => { state.selection = [...ids]; props.selectedNodeIds = state.selection; },
    onMoveNodes: (targets) => { state.moves.push(targets); return state.movePromise; },
    setView: (value) => { state.views.push(value); props.view = typeof value === 'function' ? value(props.view) : value; },
    onSelectEdge: () => {},
    ...overrides,
  };
  const render = () => {
    sandboxReact.begin();
    const tree = BoardCanvas(props);
    sandboxReact.runEffects();
    return tree;
  };
  return { props, state, render };
}

// 空白处拖动：pointerdown → pointermove → pointerup，返回最后一次渲染的树。
function marqueeDrag(mountApi, from, to, extra = {}) {
  let tree = mountApi.render();
  tree.props.onPointerDown(event({ clientX: from.x, clientY: from.y, ...extra }));
  tree = mountApi.render();
  tree.props.onPointerMove(event({ clientX: to.x, clientY: to.y, ...extra }));
  tree = mountApi.render();
  tree.props.onPointerUp(event({ clientX: to.x, clientY: to.y, ...extra }));
  return mountApi.render();
}
function emptyClick(mountApi, extra = {}) {
  let tree = mountApi.render();
  tree.props.onPointerDown(event({ clientX: 900, clientY: 700, ...extra }));
  tree = mountApi.render();
  tree.props.onPointerUp(event({ clientX: 900, clientY: 700, ...extra }));
  return mountApi.render();
}

test('空白拖动框选相交节点，拖动中显示框选矩形，单击空白取消选择', () => {
  const app = mount();
  let tree = app.render();
  tree.props.onPointerDown(event({ clientX: 10, clientY: 10 }));
  tree = app.render();
  tree.props.onPointerMove(event({ clientX: 250, clientY: 120 }));
  tree = app.render();
  assert.ok(byClass(tree, 'pb-marquee'), '拖动中应渲染框选矩形');
  tree.props.onPointerUp(event({ clientX: 250, clientY: 120 }));
  tree = app.render();
  assert.deepEqual(plain(app.state.selection), ['a']);
  assert.equal(byClass(tree, 'pb-marquee'), undefined, '松手后框选矩形消失');
  assert.ok(card(tree, 'a').props.className.includes('selected'));

  // 扩大框选范围同时命中 A、B；多选状态显示计数条。
  tree = marqueeDrag(app, { x: 0, y: 0 }, { x: 620, y: 300 });
  assert.deepEqual(plain(app.state.selection), ['a', 'b']);
  assert.ok(selectionPill(tree), '多选时显示选择计数条');
  assert.match(text(selectionPill(tree)), /已选 2 个节点/);
  assert.ok(card(tree, 'b').props.className.includes('selected'));

  // 空白单击清空选择。
  tree = emptyClick(app);
  assert.deepEqual(plain(app.state.selection), []);
  assert.equal(selectionPill(tree), undefined);
  assert.doesNotMatch(card(tree, 'a').props.className, /selected/);
});

test('Shift 框选在既有选择上追加，不覆盖原选择', () => {
  const app = mount({ selectedNodeIds: ['a'] });
  const tree = marqueeDrag(app, { x: 260, y: 0 }, { x: 600, y: 200 }, { shiftKey: true });
  assert.deepEqual(plain(app.state.selection), ['a', 'b']);
  assert.ok(card(tree, 'b').props.className.includes('selected'));
});

test('Shift 单击加选与再次单击移出，普通单击收敛为单选', () => {
  const app = mount();
  let tree = app.render();
  // Shift 单击 A：加入选择。
  card(tree, 'a').props.onPointerDown(event({ shiftKey: true }));
  tree = app.render();
  tree.props.onPointerUp(event({ shiftKey: true }));
  tree = app.render();
  card(tree, 'a').props.onClick(event({ shiftKey: true }));
  tree = app.render();
  assert.deepEqual(plain(app.state.selection), ['a']);

  // Shift 单击 B：加入选择。
  card(tree, 'b').props.onPointerDown(event({ shiftKey: true }));
  tree = app.render();
  tree.props.onPointerUp(event({ shiftKey: true }));
  tree = app.render();
  card(tree, 'b').props.onClick(event({ shiftKey: true }));
  tree = app.render();
  assert.deepEqual(plain(app.state.selection), ['a', 'b']);
  assert.ok(selectionPill(tree));

  // Shift 再次单击 A：从多选移出。
  card(tree, 'a').props.onPointerDown(event({ shiftKey: true }));
  tree = app.render();
  tree.props.onPointerUp(event({ shiftKey: true }));
  tree = app.render();
  card(tree, 'a').props.onClick(event({ shiftKey: true }));
  tree = app.render();
  assert.deepEqual(plain(app.state.selection), ['b']);

  // 普通单击 A：收敛为单选。
  tree = app.render();
  card(tree, 'a').props.onPointerDown(event());
  tree = app.render();
  tree.props.onPointerUp(event());
  tree = app.render();
  card(tree, 'a').props.onClick(event());
  tree = app.render();
  assert.deepEqual(plain(app.state.selection), ['a']);
});

test('多选后拖动任一卡片整体移动，保存前保持本地坐标，返回后释放', async () => {
  const hold = deferred();
  const app = mount({ selectedNodeIds: ['a', 'b'] });
  app.state.movePromise = hold.promise;
  let tree = app.render();
  card(tree, 'a').props.onPointerDown(event({ clientX: 100, clientY: 100 }));
  tree = app.render();
  tree.props.onPointerMove(event({ clientX: 140, clientY: 125 }));
  tree = app.render();
  // 拖动中两张卡片一起位移。
  assert.equal(card(tree, 'a').props.style.left, 40);
  assert.equal(card(tree, 'a').props.style.top, 25);
  assert.equal(card(tree, 'b').props.style.left, 340);
  assert.equal(card(tree, 'b').props.style.top, 25);
  assert.ok(card(tree, 'a').props.className.includes('dragging'));

  tree.props.onPointerUp(event({ clientX: 140, clientY: 125 }));
  tree = app.render();
  assert.equal(app.state.moves.length, 1);
  assert.deepEqual(plain(app.state.moves[0]), [{ id: 'a', x: 40, y: 25 }, { id: 'b', x: 340, y: 25 }]);
  // 保存返回前继续显示拖到的位置，避免闪回。
  assert.equal(card(tree, 'a').props.style.left, 40);
  assert.equal(card(tree, 'b').props.style.left, 340);

  hold.resolve({ board: null });
  await hold.promise;
  await new Promise((resolve) => setImmediate(resolve));
  tree = app.render();
  assert.equal(card(tree, 'a').props.style.left, 0);
  assert.equal(card(tree, 'b').props.style.left, 300);
});

test('拖动未选中的卡片先替换选择，只保存该卡片位置', () => {
  const app = mount({ selectedNodeIds: ['b'] });
  let tree = app.render();
  card(tree, 'c').props.onPointerDown(event({ clientX: 0, clientY: 400 }));
  tree = app.render();
  assert.deepEqual(plain(app.state.selection), ['c']);
  tree.props.onPointerMove(event({ clientX: 10, clientY: 430 }));
  tree = app.render();
  tree.props.onPointerUp(event({ clientX: 10, clientY: 430 }));
  tree = app.render();
  assert.deepEqual(plain(app.state.moves), [[{ id: 'c', x: 10, y: 430 }]]);
});

test('Alt+左键拖动平移画布：不改变选择，也不保存节点位置', () => {
  const app = mount({ selectedNodeIds: ['a'] });
  let tree = app.render();
  tree.props.onPointerDown(event({ clientX: 500, clientY: 300, altKey: true }));
  tree = app.render();
  tree.props.onPointerMove(event({ clientX: 530, clientY: 320, altKey: true }));
  tree = app.render();
  tree.props.onPointerUp(event({ clientX: 530, clientY: 320, altKey: true }));
  app.render();
  assert.deepEqual(plain(app.state.selection), ['a']);
  assert.equal(app.state.moves.length, 0);
  assert.equal(app.state.views.length, 1);
  assert.deepEqual(plain(app.state.views[0]), { x: 30, y: 20, scale: 1 });
});

test('Shift/Ctrl/Command 点击非首个已选节点时只移出该节点', () => {
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey']) {
    const app = mount({ selectedNodeIds: ['a', 'b'] });
    let tree = app.render();
    card(tree, 'b').props.onPointerDown(event({ [modifier]: true }));
    tree = app.render();
    tree.props.onPointerUp(event({ [modifier]: true }));
    tree = app.render();
    card(tree, 'b').props.onClick(event({ [modifier]: true }));
    app.render();
    assert.deepEqual(plain(app.state.selection), ['a'], modifier);
    assert.equal(app.state.moves.length, 0);
  }
});

test('上一轮保存未返回时继续拖动，使用屏幕上保持的位置且旧响应不清除新预览', async () => {
  const first = deferred(), second = deferred();
  const app = mount({ selectedNodeIds: ['a', 'b'] });
  app.state.movePromise = first.promise;
  let tree = app.render();
  card(tree, 'a').props.onPointerDown(event({ clientX: 0, clientY: 0 }));
  tree = app.render();
  tree.props.onPointerMove(event({ clientX: 40, clientY: 25 }));
  tree = app.render();
  tree.props.onPointerUp(event({ clientX: 40, clientY: 25 }));
  tree = app.render();
  assert.equal(card(tree, 'b').props.style.left, 340);
  app.state.movePromise = second.promise;
  card(tree, 'b').props.onPointerDown(event({ clientX: 340, clientY: 25 }));
  tree = app.render();
  assert.equal(card(tree, 'b').props.style.left, 340, '再次按下不能跳回未保存的旧位置');
  tree.props.onPointerMove(event({ clientX: 350, clientY: 30 }));
  tree = app.render();
  assert.equal(card(tree, 'a').props.style.left, 50);
  assert.equal(card(tree, 'b').props.style.left, 350);
  tree.props.onPointerUp(event({ clientX: 350, clientY: 30 }));
  tree = app.render();
  assert.deepEqual(plain(app.state.moves[1]), [{ id: 'a', x: 50, y: 30 }, { id: 'b', x: 350, y: 30 }]);
  first.resolve(); await first.promise; await new Promise(resolve => setImmediate(resolve));
  tree = app.render();
  assert.equal(card(tree, 'a').props.style.left, 50, '旧保存完成不能清除新保存的保持位置');
  const positions = new Map(app.state.moves[1].map(row => [row.id, row]));
  app.props.board = { ...app.props.board, nodes: app.props.board.nodes.map(node => ({ ...node, ...positions.get(node.id) })) };
  second.resolve(); await second.promise; await new Promise(resolve => setImmediate(resolve));
  tree = app.render();
  assert.equal(card(tree, 'a').props.style.left, 50);
});

test('输入框和活动预览的 Esc 不清空底层画布选择', () => {
  const app = mount({ selectedNodeIds: ['a', 'b'] });
  app.render();
  const keydown = sandboxReact.documentListeners.filter(row => row.type === 'keydown').at(-1);
  keydown.listener({ key: 'Escape', defaultPrevented: false, target: { closest: () => ({}) } });
  assert.deepEqual(plain(app.state.selection), ['a', 'b']);
  sandboxReact.document.querySelector = () => ({});
  try {
    keydown.listener({ key: 'Escape', defaultPrevented: false, target: { closest: () => null } });
    assert.deepEqual(plain(app.state.selection), ['a', 'b']);
  } finally {
    delete sandboxReact.document.querySelector;
  }
});

test('Esc 清空画布多选', () => {
  const app = mount({ selectedNodeIds: ['a', 'b'] });
  app.render();
  const keydown = sandboxReact.documentListeners.filter((row) => row.type === 'keydown').at(-1);
  assert.ok(keydown, '多选时应注册 Esc 监听');
  keydown.listener({ key: 'Escape', defaultPrevented: false });
  assert.deepEqual(plain(app.state.selection), []);
});
