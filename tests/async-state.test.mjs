import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../board-model.js', import.meta.url), 'utf8')).replace(/^export /gm, '') + '\n' + (await Promise.all(['state.js', 'explorer.js', 'assistant.js', 'panel.js'].map(name => fs.readFile(new URL('../client-src/' + name, import.meta.url), 'utf8')))).join('\n');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const board = (path = '/A', revision = 1, x = 0) => ({
  workspacePath: path, revision, updatedAt: 1, assistant: { sessionId: 'lead-' + path },
  nodes: [{ id: 'node', title: 'Node', kind: 'experiment', x, y: 0, status: 'todo' }],
  tasks: [{ id: 'task', nodeId: 'node', title: 'Task', status: 'todo', threads: [] }],
  todos: [{ id: 'todo', taskId: 'task', title: 'Todo', status: 'todo', threads: [] }],
  notes: [], edges: [],
});
function all(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(all);
  return [tree, ...all(tree.props?.children)];
}
const text = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : '';
const named = (tree, name) => all(tree).find(row => row.type?.name === name);
const css = (tree, value) => all(tree).find(row => row.props?.className === value);
const button = (tree, label) => all(tree).find(row => row.type === 'button' && text(row).trim() === label);

// 执行真实组件和 effect；只替代 React 调度、浏览器外壳与可控网络。
// 不执行子组件，直接调用真实组件传给子组件的交互回调。
function harness(componentName, initialProps = {}) {
  const cells = [];
  let index = 0, effects = [], dirty = false, tree, props = initialProps;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, at) => Object.is(value, b[at]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'fragment',
    useState(initial) {
      const at = index++;
      if (!cells[at]) cells[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [cells[at].value, next => {
        const value = typeof next === 'function' ? next(cells[at].value) : next;
        if (!Object.is(value, cells[at].value)) { cells[at].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const at = index++; return cells[at] ||= { current: initial }; },
    useCallback(callback, deps) {
      const at = index++;
      if (!cells[at] || !same(cells[at].deps, deps)) cells[at] = { callback, deps };
      return cells[at].callback;
    },
    useEffect(effect, deps) {
      const at = index++;
      if (!cells[at] || !same(cells[at].deps, deps)) {
        const previous = cells[at];
        cells[at] = { deps };
        effects.push(() => { previous?.cleanup?.(); cells[at].cleanup = effect(); });
      }
    },
    useId() { const at = index++; return 'form-' + at; },
  };
  React.useLayoutEffect = React.useEffect;
  const requests = [], timers = [], keyListeners = new Set();
  const storage = new Map([['dsh.project-board.workspace.v1', '/A']]);
  const workspaces = ['/A', '/B'].map(path => ({ path, workspaceId: 'workspace-' + path, hasBoard: true }));
  const globals = {
    React, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { addEventListener() {}, removeEventListener() {} },
    document: {
      body: { style: {} },
      addEventListener: (type, callback) => { if (type === 'keydown') keyListeners.add(callback); },
      removeEventListener: (type, callback) => { if (type === 'keydown') keyListeners.delete(callback); },
    },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    useBoardThreadResults: () => ({}), useBoardJobs: () => ({}), pbItemExecution: () => ({}),
    pbThreadsOf: item => item?.threads || [], pbExecutionContext: (board, item) => ({ ids: (item.threads || []).map(row => row.sessionId) }),
    BoardCanvas: function BoardCanvas() {}, PbIcon: function PbIcon() {},
    PbNodeInspector: function PbNodeInspector() {}, PbConversationDrawer: function PbConversationDrawer() {},
    PbArtifactViewer: function PbArtifactViewer() {}, PbEmbeddedConversation: function PbEmbeddedConversation() {},
    fetchJson(url, options) {
      if (url.endsWith('/workspaces')) return Promise.resolve({ workspaces });
      const pending = deferred();
      requests.push({ url, body: options?.body ? JSON.parse(options.body) : null, ...pending });
      return pending.promise;
    },
  };
  vm.createContext(globals);
  vm.runInContext(source + '\npbFetchJson = fetchJson; useObservableSource = source => source; globalThis.components = { ProjectBoardPanel, BoardAssistant, PbNodeCreateForm };', globals);
  function render(nextProps = props) {
    props = nextProps;
    for (let turns = 0; turns < 30; turns++) {
      index = 0; effects = []; dirty = false;
      tree = globals.components[componentName](props);
      for (const effect of effects) effect();
      if (!dirty) return tree;
    }
    throw new Error('effect 未收敛');
  }
  return {
    requests, timers, storage, render, get tree() { return tree; },
    keyDown(event) { for (const callback of keyListeners) callback(event); },
    async flush() { await tick(); return render(); },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
  };
}
function panel(extra = {}) {
  const app = harness('ProjectBoardPanel', {
    workspacesSource: { items: ['/A', '/B'].map(path => ({ path, workspaceId: 'workspace-' + path })) },
    sessionsSource: { byId: {} }, sessionStatusSource: {}, createSession: async (workspace, id) => id,
    acquireConversationSession() {}, initializeDraft() {}, SessionProvider() {}, renderSlot() {}, openSession: async () => {},
    ...extra,
  });
  app.render();
  app.switchTo = path => all(app.tree).find(row => row.type === 'select').props.onChange({ target: { value: path } });
  app.canvas = () => named(app.tree, 'BoardCanvas');
  app.command = (...args) => (named(app.tree, 'BoardAssistant') || named(app.tree, 'PbNodeInspector')).props.runCommand(...args);
  return app;
}
async function readyPanel(extra) {
  const app = panel(extra);
  app.requests[0].resolve({ exists: true, board: board() });
  await app.flush();
  return app;
}
const stateRequests = app => app.requests.filter(row => row.url.includes('/state?'));
const writes = app => app.requests.filter(row => row.body);

// GET、command、dispatch 三条入口都必须同时遵守 workspace scope 和 revision 下限。
test('切项目立即清空 UI，A 的晚到 GET 不覆盖 B，也不结束 B 的加载', async () => {
  const app = panel();
  const old = app.requests[0];
  app.switchTo('/B'); app.render();
  assert.equal(app.canvas(), undefined);
  old.resolve({ exists: true, board: board('/A', 9) });
  await app.flush();
  assert.match(text(app.tree), /正在读取看板/);
  stateRequests(app)[1].resolve({ exists: true, board: board('/B', 2) });
  await app.flush();
  assert.equal(app.canvas().props.board.workspacePath, '/B');
  assert.equal(app.canvas().props.board.revision, 2);
});

test('A→B→A 即使同帧回到相同路径，也新建 scope 并重新加载', async () => {
  const app = panel();
  const old = app.requests[0];
  app.switchTo('/B'); app.switchTo('/A'); app.render();
  assert.equal(stateRequests(app).length, 2);
  stateRequests(app)[1].resolve({ exists: true, board: board('/A', 3) });
  await app.flush();
  old.resolve({ exists: true, board: board('/A', 99) });
  await app.flush();
  assert.equal(app.canvas().props.board.revision, 3);
});

test('同项目 GET 乱序、低 revision、旧错误均不回退当前快照', async () => {
  const app = await readyPanel();
  const refresh = button(app.tree, '刷新').props.onClick;
  const first = refresh(), second = refresh();
  stateRequests(app)[2].resolve({ exists: true, board: board('/A', 6) });
  await second; await app.flush();
  stateRequests(app)[1].reject(new Error('旧请求失败'));
  await first; await app.flush();
  assert.equal(app.canvas().props.board.revision, 6);
  assert.equal(css(app.tree, 'pb-error'), undefined);
  const low = button(app.tree, '刷新').props.onClick();
  stateRequests(app)[3].resolve({ exists: true, board: board('/A', 2) });
  await low; await app.flush();
  assert.equal(app.canvas().props.board.revision, 6);
});

test('本地保存串行发送，出队时读取最新 revision，busy 覆盖整个队列', async () => {
  const app = await readyPanel();
  const move = app.canvas().props.onMoveNodes;
  const first = move([{ id: 'node', x: 10, y: 0 }]);
  const second = move([{ id: 'node', x: 20, y: 0 }]);
  await app.flush();
  assert.equal(writes(app).length, 1);
  assert.equal(writes(app)[0].body.expectedRevision, 1);
  assert.ok(css(app.tree, 'pb-busy'));
  writes(app)[0].resolve({ board: board('/A', 2, 10) });
  await first; await app.flush();
  assert.equal(writes(app).length, 2);
  assert.equal(writes(app)[1].body.expectedRevision, 2);
  assert.ok(css(app.tree, 'pb-busy'));
  writes(app)[1].resolve({ board: board('/A', 3, 20) });
  await second; await app.flush();
  assert.equal(app.canvas().props.board.nodes[0].x, 20);
  assert.equal(css(app.tree, 'pb-busy'), undefined);
});

test('外部冲突只重载一次，后续队列等待重载，无盲目重放且保留错误', async () => {
  const app = await readyPanel();
  const first = app.command('save_positions', { positions: [{ id: 'node', x: 10, y: 0 }] });
  const second = app.command('save_positions', { positions: [{ id: 'node', x: 20, y: 0 }] });
  await app.flush();
  writes(app)[0].reject(Object.assign(new Error('revision conflict'), { code: 'STALE_REVISION' }));
  await app.flush();
  assert.equal(writes(app).length, 1);
  stateRequests(app)[1].resolve({ exists: true, board: board('/A', 8) });
  assert.equal(await first, null);
  await app.flush();
  assert.equal(writes(app).length, 2);
  assert.equal(writes(app)[1].body.expectedRevision, 8);
  assert.equal(writes(app)[1].body.input.positions[0].x, 20);
  writes(app)[1].resolve({ board: board('/A', 9, 20) });
  await second; await app.flush();
  assert.match(text(css(app.tree, 'pb-error')), /revision conflict/);
});

test('切项目取消旧排队写入，晚到 command 不改新项目状态', async () => {
  const app = await readyPanel();
  const first = app.command('rename_board', { title: 'A1' });
  const second = app.command('rename_board', { title: 'A2' });
  await app.flush();
  app.switchTo('/B'); app.render();
  stateRequests(app)[1].resolve({ exists: true, board: board('/B', 4) });
  await app.flush();
  writes(app)[0].resolve({ board: board('/A', 80) });
  assert.equal(await first, null); assert.equal(await second, null);
  await app.flush();
  assert.equal(writes(app).length, 1);
  assert.equal(app.canvas().props.board.workspacePath, '/B');
  assert.equal(css(app.tree, 'pb-error'), undefined);
  assert.equal(css(app.tree, 'pb-busy'), undefined);
});

test('command 与 dispatch 低 revision 响应不覆盖更新 GET，返回当前快照', async () => {
  for (const action of ['rename_board', '__dispatch_task']) {
    const app = await readyPanel();
    const saving = app.command(action, { taskId: 'task', title: 'name' });
    await app.flush();
    const loading = button(app.tree, '刷新').props.onClick();
    stateRequests(app)[1].resolve({ exists: true, board: board('/A', 10) });
    await loading;
    writes(app)[0].resolve({ board: board('/A', 2), created: [] });
    const result = await saving;
    await app.flush();
    assert.equal(result.board.revision, 10);
    assert.equal(app.canvas().props.board.revision, 10);
  }
});

test('旧 dispatch 失败和完成通知不能污染新项目', async () => {
  for (const failure of [false, true]) {
    const app = await readyPanel();
    const dispatching = app.command('__dispatch_task', { taskId: 'task' });
    await app.flush();
    assert.equal(writes(app)[0].url, '/api/project-board/dispatch');
    app.switchTo('/B'); app.render();
    stateRequests(app)[1].resolve({ exists: true, board: board('/B', 2) });
    await app.flush();
    if (failure) writes(app)[0].reject(new Error('旧派发失败'));
    else writes(app)[0].resolve({ board: board('/A', 9), created: [{}] });
    await dispatching; await app.flush();
    assert.equal(app.canvas().props.board.workspacePath, '/B');
    assert.equal(css(app.tree, 'pb-toast'), undefined);
    assert.equal(css(app.tree, 'pb-error'), undefined);
  }
});

test('切换同步清空节点、弹窗、产物和会话，旧组件回调失效，新组件按项目重建', async () => {
  const app = await readyPanel();
  const oldCanvas = app.canvas().props;
  oldCanvas.onSelectNode('node'); app.render();
  const inspector = named(app.tree, 'PbNodeInspector');
  assert.equal(inspector.props.key, '/A:node');
  inspector.props.onOpenArtifact({ path: 'result.png' });
  inspector.props.onOpenTodo('todo');
  oldCanvas.onCreateAt({ x: 1, y: 2 }); app.render();
  const drawer = named(app.tree, 'PbConversationDrawer');
  assert.equal(drawer.props.key, '/A:todo:todo');
  assert.ok(named(app.tree, 'PbModal')); assert.ok(named(app.tree, 'PbArtifactViewer'));
  app.switchTo('/B'); app.render();
  assert.equal(named(app.tree, 'PbModal'), undefined);
  assert.equal(named(app.tree, 'PbArtifactViewer'), undefined);
  assert.equal(named(app.tree, 'PbConversationDrawer'), undefined);
  stateRequests(app)[1].resolve({ exists: true, board: board('/B') });
  await app.flush();
  oldCanvas.onSelectNode('node'); oldCanvas.onCreateAt({ x: 7, y: 8 });
  inspector.props.onOpenArtifact({ path: 'old.png' }); inspector.props.onOpenTodo('todo');
  drawer.props.onSelectThread('todo', 'todo', 'old-session');
  app.render();
  assert.equal(app.canvas().props.selectedNodeId, null);
  assert.equal(named(app.tree, 'PbModal'), undefined);
  assert.equal(named(app.tree, 'PbArtifactViewer'), undefined);
  assert.equal(named(app.tree, 'BoardAssistant').props.key, '/B');
  app.canvas().props.onSelectNode('node'); app.render();
  assert.equal(named(app.tree, 'PbNodeInspector').props.key, '/B:node');
});

test('创建条目会话去重；创建期间切项目不再绑定或打开旧会话', async () => {
  const creation = deferred(); let creations = 0;
  const app = await readyPanel({ createSession: () => { creations++; return creation.promise; } });
  app.canvas().props.onSelectNode('node'); app.render();
  const create = named(app.tree, 'PbNodeInspector').props.threadUi.create;
  const first = create('todo', 'todo'), second = create('todo', 'todo');
  const rejected = [assert.rejects(first, /项目已切换/), assert.rejects(second, /项目已切换/)];
  assert.equal(creations, 1);
  app.switchTo('/B'); app.render();
  creation.resolve('created-old-session');
  await Promise.all(rejected); await app.flush();
  assert.equal(writes(app).length, 0);
  assert.equal(named(app.tree, 'PbConversationDrawer'), undefined);
});

test('节点创建失败保留弹窗，只有成功响应关闭同一个弹窗', async () => {
  const app = await readyPanel();
  app.canvas().props.onCreateAt({ x: 12, y: 34 }); app.render();
  const create = named(app.tree, 'PbNodeCreateForm').props.onCreate;
  const failed = assert.rejects(create({ title: 'Draft', kind: 'experiment' }), /保存失败/);
  await app.flush();
  writes(app)[0].reject(new Error('保存失败'));
  await failed; await app.flush();
  assert.ok(named(app.tree, 'PbModal'));
  const retry = named(app.tree, 'PbNodeCreateForm').props.onCreate({ title: 'Draft', kind: 'experiment' });
  await app.flush();
  assert.equal(writes(app)[1].body.input.node.x, 12);
  writes(app)[1].resolve({ board: board('/A', 2) });
  await retry; await app.flush();
  assert.equal(named(app.tree, 'PbModal'), undefined);
});

test('节点表单保留失败草稿，阻止重复点击/长按 Enter/中文 IME 误提交', async () => {
  const pending = deferred(); const calls = [];
  const form = harness('PbNodeCreateForm', { onCreate: value => { calls.push(value); return pending.promise; }, onCancel() {} });
  form.render();
  all(form.tree).find(row => row.type === 'input').props.onChange({ target: { value: '中文节点' } });
  form.render();
  const input = all(form.tree).find(row => row.type === 'input');
  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) input.props.onKeyDown({ key: 'Enter', nativeEvent, preventDefault: () => assert.fail('IME 不应阻止选词') });
  assert.equal(calls.length, 0);
  const submit = button(form.tree, '创建').props.onClick;
  const first = submit(), second = submit();
  input.props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} });
  assert.equal(calls.length, 1);
  pending.reject(new Error('网络失败'));
  await Promise.all([first, second]); await form.flush();
  assert.equal(all(form.tree).find(row => row.type === 'input').props.value, '中文节点');
  assert.match(text(form.tree), /网络失败/);
  assert.equal(button(form.tree, '创建').props.disabled, false);
});

test('GET 失败不能清除期间已成功保存的新 board', async () => {
  const app = await readyPanel();
  const refresh = button(app.tree, '刷新').props.onClick();
  const saving = app.command('rename_board', { title: 'new' });
  await app.flush();
  writes(app)[0].resolve({ board: board('/A', 4) });
  await saving;
  stateRequests(app)[1].reject(new Error('旧快照刷新失败'));
  await refresh; await app.flush();
  assert.equal(app.canvas().props.board.revision, 4);
  assert.equal(css(app.tree, 'pb-error'), undefined);
});

test('派发通知的旧定时器不能清除新项目通知', async () => {
  const app = await readyPanel();
  const first = app.command('__dispatch_task', { taskId: 'task' });
  await app.flush();
  writes(app)[0].resolve({ board: board('/A', 2), created: [{}] });
  await first; await app.flush();
  const oldTimer = app.timers.at(-1);
  app.switchTo('/B'); app.render();
  stateRequests(app)[1].resolve({ exists: true, board: board('/B') });
  await app.flush();
  const second = app.command('__dispatch_task', { taskId: 'task' });
  await app.flush();
  writes(app)[1].resolve({ board: board('/B', 2), created: [{}, {}] });
  await second; await app.flush();
  oldTimer(); app.render();
  assert.match(text(css(app.tree, 'pb-toast')), /2 项/);
  app.timers.at(-1)(); app.render();
  assert.equal(css(app.tree, 'pb-toast'), undefined);
});

test('完整会话导航获得切项目取消条件，旧导航回调失效', async () => {
  const calls = [];
  const app = await readyPanel({ openSession: async (id, current) => { calls.push({ id, current }); } });
  const assistantOpen = named(app.tree, 'BoardAssistant').props.onOpenSession;
  await assistantOpen('lead-A');
  assert.equal(calls[0].current(), true);
  app.canvas().props.onSelectNode('node'); app.render();
  named(app.tree, 'PbNodeInspector').props.onOpenTodo('todo'); app.render();
  const drawerOpen = named(app.tree, 'PbConversationDrawer').props.onOpenSession;
  await drawerOpen('todo-session');
  assert.equal(calls[1].current(), true);
  app.switchTo('/B');
  assert.equal(calls[0].current(), false);
  assert.equal(calls[1].current(), false);
  await assistantOpen('old-assistant'); await drawerOpen('old-task');
  assert.equal(calls.length, 2);
});

const branchingBoard = (revision = 1, edges = []) => ({
  ...board('/A', revision), edges,
  nodes: [...board().nodes, ...['branch-A', 'branch-B', 'branch-C'].map(id => ({ id, title: id, kind: 'theme', x: 0, y: 0 }))],
});
async function readyBranchPanel() {
  const app = panel();
  stateRequests(app)[0].resolve({ exists: true, board: branchingBoard() });
  await app.flush();
  button(app.tree, '连线').props.onClick(); app.render();
  return app;
}
const connectionSelect = app => all(app.tree).find(row => row.props?.['aria-label'] === '连线类型');

test('连线类型、提示和 Escape 保留；保存失败仍保留源节点且阻止重复提交', async () => {
  const app = await readyBranchPanel();
  assert.equal(connectionSelect(app).props.value, 'contains');
  assert.match(app.canvas().props.connectionHint, /归属连线/);
  await app.canvas().props.onConnectNode('branch-A'); app.render();
  assert.match(app.canvas().props.connectionHint, /branch-A/);
  connectionSelect(app).props.onChange({ target: { value: 'produces' } }); app.render();
  assert.equal(app.canvas().props.connectSource, null);
  assert.match(app.canvas().props.connectionHint, /产出连线/);
  let canceled = 0;
  app.keyDown({ key: 'Escape', preventDefault: () => canceled++ }); app.render();
  assert.equal(canceled, 1);
  assert.equal(app.canvas().props.connectMode, false);
  button(app.tree, '连线').props.onClick(); app.render();
  assert.equal(connectionSelect(app).props.value, 'contains');
  await app.canvas().props.onConnectNode('branch-A'); app.render();
  const connect = app.canvas().props.onConnectNode;
  const first = connect('node'), duplicate = connect('node');
  await app.flush();
  assert.equal(writes(app).length, 1);
  assert.equal(app.canvas().props.connectPending, true);
  assert.equal(connectionSelect(app).props.disabled, true);
  assert.equal(all(app.tree).find(row => row.props?.['aria-label'] === '选择 workspace').props.disabled, true);
  app.switchTo('/B'); app.keyDown({ key: 'Escape', preventDefault: () => canceled++ }); app.render();
  assert.equal(stateRequests(app).length, 1);
  assert.equal(app.canvas().props.connectMode, true);
  assert.equal(canceled, 1);
  writes(app)[0].reject(new Error('分支保存失败'));
  await Promise.all([first, duplicate]); await app.flush();
  assert.equal(app.canvas().props.connectSource, 'branch-A');
  assert.equal(app.canvas().props.connectPending, false);
  assert.equal(css(app.tree, 'pb-error').props.role, 'alert');
  assert.match(text(css(app.tree, 'pb-error')), /分支保存失败/);
  const retry = app.canvas().props.onConnectNode('node'); await app.flush();
  assert.equal(writes(app).length, 2);
  writes(app)[1].resolve({ board: branchingBoard(2, [{ id: 'membership', from: 'branch-A', to: 'node', kind: 'contains' }]) });
  await retry; await app.flush();
  assert.equal(app.canvas().props.connectMode, false);
  assert.equal(app.canvas().props.selectedNodeId, 'node');
  assert.match(text(css(app.tree, 'pb-toast')), /归入「branch-A」/);
});

test('连线在出队时按最新归属生成计划，多条修复命令不被其他本地写入插入', async () => {
  const app = await readyBranchPanel();
  const current = [{ id: 'fresh-membership', from: 'branch-A', to: 'node', kind: 'contains' }, { id: 'duplicate-membership', from: 'branch-C', to: 'node', kind: 'contains' }];
  const first = app.command('upsert_edge', { edge: current[0] });
  await app.canvas().props.onConnectNode('branch-B'); app.render();
  const connect = app.canvas().props.onConnectNode('node');
  const trailing = app.command('save_positions', { positions: [] });
  await app.flush();
  assert.equal(writes(app).length, 1);
  writes(app)[0].resolve({ board: branchingBoard(2, current) });
  await first; await app.flush();
  assert.equal(writes(app)[1].body.action, 'upsert_edge');
  assert.equal(writes(app)[1].body.input.edge.id, 'fresh-membership');
  assert.equal(writes(app)[1].body.input.edge.from, 'branch-B');
  assert.equal(writes(app)[1].body.expectedRevision, 2);
  const moved = [{ ...current[0], from: 'branch-B' }, current[1]];
  writes(app)[1].resolve({ board: branchingBoard(3, moved) }); await app.flush();
  assert.equal(writes(app)[2].body.action, 'delete_edge');
  assert.equal(writes(app)[2].body.input.id, 'duplicate-membership');
  assert.equal(writes(app)[2].body.expectedRevision, 3);
  writes(app)[2].resolve({ board: branchingBoard(4, moved.slice(0, 1)) });
  await connect; await app.flush();
  assert.equal(writes(app)[3].body.action, 'save_positions');
  assert.equal(writes(app)[3].body.expectedRevision, 4);
  writes(app)[3].resolve({ board: branchingBoard(5, moved.slice(0, 1)) });
  await trailing; await app.flush();
  assert.equal(app.canvas().props.board.revision, 5);
  assert.equal(css(app.tree, 'pb-busy'), undefined);
});

test('连线计划遇到外部冲突重载后终止，保留源节点等待用户重试', async () => {
  const app = await readyBranchPanel();
  await app.canvas().props.onConnectNode('branch-A'); app.render();
  const connect = app.canvas().props.onConnectNode('node'); await app.flush();
  writes(app)[0].reject(Object.assign(new Error('归属已被其他会话更新'), { code: 'STALE_REVISION' }));
  await app.flush();
  assert.equal(app.canvas().props.connectPending, true);
  stateRequests(app)[1].resolve({ exists: true, board: branchingBoard(8, [{ id: 'external', from: 'branch-C', to: 'node', kind: 'contains' }]) });
  await connect; await app.flush();
  assert.equal(writes(app).length, 1);
  assert.equal(app.canvas().props.board.revision, 8);
  assert.equal(app.canvas().props.connectSource, 'branch-A');
  assert.equal(app.canvas().props.connectMode, true);
  assert.equal(app.canvas().props.connectPending, false);
  assert.match(text(css(app.tree, 'pb-error')), /其他会话更新/);
});

test('旧连线回调和多命令计划在切项目后失效，不能继续第二条写入', async () => {
  const app = await readyBranchPanel();
  const refresh = button(app.tree, '刷新').props.onClick();
  const edges = [{ id: 'keep', from: 'branch-A', to: 'node', kind: 'contains' }, { id: 'drop', from: 'branch-C', to: 'node', kind: 'contains' }];
  stateRequests(app)[1].resolve({ exists: true, board: branchingBoard(2, edges) }); await refresh; await app.flush();
  const oldCallback = app.canvas().props.onConnectNode;
  const connect = app.command('__connect_nodes', { source: 'branch-B', target: 'node', kind: 'contains' });
  await app.flush();
  assert.equal(writes(app).length, 1);
  app.switchTo('/B'); app.render();
  stateRequests(app)[2].resolve({ exists: true, board: board('/B', 3) }); await app.flush();
  await oldCallback('branch-A');
  writes(app)[0].resolve({ board: branchingBoard(9, [{ ...edges[0], from: 'branch-B' }, edges[1]]) });
  await connect; await app.flush();
  assert.equal(writes(app).length, 1);
  assert.equal(app.canvas().props.board.workspacePath, '/B');
  assert.equal(app.canvas().props.connectMode, false);
  assert.equal(css(app.tree, 'pb-error'), undefined);
});

function assistant(extra = {}) {
  const props = { board: { ...board(), assistant: undefined }, workspacePath: '/A', workspaceInfo: { workspaceId: 'workspace-A' },
    createSession: async () => 'actual-created-id', runCommand: async () => null, onOpenSession: async () => {},
    acquireConversationSession() {}, initializeDraft() {}, SessionProvider() {}, renderSlot() {}, ...extra };
  const app = harness('BoardAssistant', props);
  app.render();
  return { app, props };
}

test('Lead 绑定返回 null 或错误 sessionId 时保留错误，不挂载原生输入框、不发送消息', async () => {
  for (const response of [null, { board: { assistant: { sessionId: 'wrong-id' } } }]) {
    let created = 0, prompted = 0;
    const { app } = assistant({ createSession: async () => { created++; return 'real-id'; }, runCommand: async () => response, promptSession: () => { prompted++; } });
    await app.flush();
    assert.match(text(app.tree), /绑定失败/);
    assert.ok(button(app.tree, '重试创建'));
    assert.equal(named(app.tree, 'PbEmbeddedConversation'), undefined);
    await app.flush();
    assert.equal(created, 1, '失败不因 rerender 自动循环创建');
    assert.equal(prompted, 0);
  }
});

test('Lead 重试共用 in-flight Promise，绑定真实返回 ID，成功后保留原生会话 props', async () => {
  const pending = deferred(); let creates = 0; const binds = [];
  const { app, props } = assistant({
    createSession: () => { creates++; return creates === 1 ? Promise.reject(new Error('首次失败')) : pending.promise; },
    runCommand: async (action, input, options) => { binds.push({ action, input, options }); return { board: { assistant: { sessionId: input.sessionId } } }; },
  });
  await app.flush();
  const retry = button(app.tree, '重试创建').props.onClick;
  const first = retry(), second = retry();
  assert.equal(creates, 2);
  pending.resolve('server-returned-id');
  await Promise.all([first, second]); await app.flush();
  assert.equal(binds.length, 1);
  assert.equal(binds[0].input.sessionId, 'server-returned-id');
  assert.equal(binds[0].options.throwOnError, true);
  props.board = { ...board(), assistant: { sessionId: 'server-returned-id' } };
  app.render(props);
  const native = named(app.tree, 'PbEmbeddedConversation');
  assert.equal(native.props.sessionId, 'server-returned-id');
  assert.equal(native.props.key, '/A:server-returned-id');
  assert.equal(native.props.acquireConversationSession, props.acquireConversationSession);
  assert.equal(native.props.initializeDraft, props.initializeDraft);
  assert.equal(native.props.renderSlot, props.renderSlot);
});

test('Lead 创建返回前切项目或卸载，禁止后续绑定；晚到失败也不污染新项目', async () => {
  for (const unmount of [false, true]) {
    const pending = deferred(); let active = true, binds = 0;
    const { app } = assistant({ createSession: () => pending.promise, runCommand: async () => { binds++; return null; }, isCurrentWorkspace: () => active });
    if (unmount) app.unmount(); else active = false;
    pending.resolve('old-created-id');
    await app.flush();
    assert.equal(binds, 0);
    assert.equal(css(app.tree, 'pb-conversation-error'), undefined);
  }
});

test('待办共享父任务会话的选择在面板与抽屉一致，拒绝移除父关联及过期ID', async () => {
  const initial = board();
  initial.tasks[0].threads = [{ sessionId: 'parent-a' }, { sessionId: 'parent-b' }];
  const app = panel({ createSession: () => assert.fail('打开不应创建会话') });
  app.requests[0].resolve({ exists: true, board: initial }); await app.flush();
  app.canvas().props.onSelectNode('node'); app.render();
  const inspector = named(app.tree, 'PbNodeInspector');
  assert.equal(inspector.props.threadUi.selectedFor('todo', initial.todos[0]), 'parent-b');
  inspector.props.threadUi.select('todo', 'todo', 'parent-a'); app.render();
  assert.equal(named(app.tree, 'PbConversationDrawer').props.sessionId, 'parent-a');
  await assert.rejects(named(app.tree, 'PbConversationDrawer').props.onRemoveThread('todo', 'todo', 'parent-a'), /所属任务/);
  assert.throws(() => named(app.tree, 'PbConversationDrawer').props.onSelectThread('todo', 'todo', 'missing'), /关联已更新/);
  assert.equal(writes(app).length, 0);
  assert.equal(initial.todos[0].threads.length, 0);
});

test('移除最后一个待办自身关联后恢复父会话；相同ID也只移除待办关联', async () => {
  for (const own of ['own', 'parent']) {
    const initial = board();
    initial.tasks[0].threads = [{ sessionId: 'parent' }];
    initial.todos[0].threads = [{ sessionId: own }];
    const app = panel(); app.requests[0].resolve({ exists: true, board: initial }); await app.flush();
    app.canvas().props.onSelectNode('node'); app.render();
    named(app.tree, 'PbNodeInspector').props.threadUi.select('todo', 'todo', own); app.render();
    assert.equal(named(app.tree, 'PbConversationDrawer').props.sessionId, own);
    const removing = named(app.tree, 'PbConversationDrawer').props.onRemoveThread('todo', 'todo', own);
    await app.flush();
    assert.equal(writes(app).length, 1);
    assert.equal(writes(app)[0].body.action, 'unbind_thread');
    assert.equal(writes(app)[0].body.input.todoId, 'todo');
    assert.equal(writes(app)[0].body.input.taskId, undefined);
    const next = structuredClone(initial); next.revision = 2; next.todos[0].threads = [];
    writes(app)[0].resolve({ board: next }); await removing; await app.flush();
    assert.equal(named(app.tree, 'PbConversationDrawer').props.sessionId, 'parent');
    assert.deepEqual(app.canvas().props.board.tasks[0].threads, [{ sessionId: 'parent' }]);
  }
});


test('视口按项目恢复与保存，旧项目回调不能污染新视口或存储', async () => {
  const app = await readyPanel();
  const initialA = { x: 10, y: 20, scale: .8 }, initialB = { x: -30, y: 50, scale: 1.2 };
  const key = path => 'dsh.project-board.view.v2:' + path;
  app.storage.set(key('/A'), JSON.stringify(initialA));
  app.storage.set(key('/B'), JSON.stringify(initialB));
  app.canvas().props.onViewport({ width: 900, height: 700 }); app.render();
  assert.equal(JSON.stringify(app.canvas().props.view), JSON.stringify(initialA));
  const changeA = app.canvas().props.setView;
  const finalA = { x: 80, y: -20, scale: .6 };
  changeA(finalA); app.render();
  assert.deepEqual(JSON.parse(app.storage.get(key('/A'))), finalA);
  app.switchTo('/B'); app.render();
  stateRequests(app).at(-1).resolve({ exists: true, board: board('/B') }); await app.flush();
  assert.equal(JSON.stringify(app.canvas().props.view), JSON.stringify(initialB));
  changeA({ x: 999, y: 999, scale: 1 }); app.render();
  assert.deepEqual(JSON.parse(app.storage.get(key('/A'))), finalA);
  assert.deepEqual(JSON.parse(app.storage.get(key('/B'))), initialB);
  app.switchTo('/A'); app.render();
  stateRequests(app).at(-1).resolve({ exists: true, board: board('/A') }); await app.flush();
  assert.equal(JSON.stringify(app.canvas().props.view), JSON.stringify(finalA));
});
