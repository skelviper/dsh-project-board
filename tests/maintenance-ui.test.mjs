import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const fragments = ['state.js', 'explorer.js', 'inspector.js', 'assistant.js', 'maintenance.js', 'panel.js'];
const source = fs.readFileSync(new URL('../board-model.js', import.meta.url), 'utf8').replace(/^export /gm, '') + '\n' + fragments.map(name => fs.readFileSync(new URL('../client-src/' + name, import.meta.url), 'utf8')).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = () => ({ preventDefault() {}, stopPropagation() {} });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children || []).flatMap(nodes)];
const text = tree => tree == null || tree === false ? '' : typeof tree !== 'object' ? String(tree) : (tree.children || []).map(text).join('');
const find = (tree, predicate) => { const result = nodes(tree).find(predicate); assert.ok(result, '未找到需要的界面元素'); return result; };
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node).trim() === label);
const field = (tree, label) => find(tree, node => node.props['aria-label'] === label);
const formFor = (tree, label) => find(tree, node => node.type === 'form' && nodes(node).some(child => child.props['aria-label'] === label));
const recordToggle = tree => find(tree, node => node.type === 'button' && text(node).startsWith('维护记录'));
const updateMessage = '请按当前项目目标整理新增资料：优先更新现有任务和来源，只有明确独立事项才新增节点，不要把目录或每份文档逐个建卡。';
const candidates = () => [
  { path: 'docs/new-a.md', kind: 'document', title: '不应逐项显示的资料甲', summary: '新增报告', fingerprint: 'a', status: 'pending' },
  { path: 'results/new-unit', kind: 'directory', title: '不应逐项显示的目录乙', summary: '新增目录', fingerprint: 'b', status: 'pending' },
  { path: 'docs/already-linked.md', kind: 'document', title: '已关联资料', summary: '既有任务来源', fingerprint: 'c', status: 'linked', targetType: 'task', targetId: 'task' },
  { path: 'docs/unrelated.md', kind: 'document', title: '已忽略资料', summary: '无关线索', fingerprint: 'd', status: 'dismissed', reason: '与当前项目目标无关' },
];
const conflicts = () => [
  { id: 'field', kind: 'field', targetType: 'task', targetId: 'task', title: '任务字段', field: 'summary', current: '看板保留的说明', proposed: '磁盘新说明', sourcePath: 'docs/task.md', status: 'open' },
  { id: 'archive', kind: 'archive', targetType: 'todo', targetId: 'todo', title: '共享文件', deletionId: 'deletion', status: 'open' },
  { id: 'missing', kind: 'missing', targetType: 'node', targetId: 'node', title: '来源已缺失', sourcePath: 'docs/missing.md', status: 'open' },
];
function board(path = '/A', revision = 1, maintenance = {}) {
  return {
    workspacePath: path, revision, updatedAt: '2026-10-19T14:00:00.000Z', assistant: { sessionId: 'lead-' + path },
    nodes: [{ id: 'node', title: '节点', kind: 'experiment', x: 0, y: 0, status: 'todo' }],
    tasks: [{ id: 'task', nodeId: 'node', title: '任务', status: 'todo', threads: [] }],
    todos: [{ id: 'todo', taskId: 'task', title: '待办', status: 'todo', threads: [] }],
    edges: [], notes: [], decisions: [], changes: [],
    maintenance: { scope: 'linked', roots: [], candidates: [], sources: [], deletions: [], conflicts: [], ...maintenance },
  };
}

// 执行真实组件、hooks 和子组件；仅替换 React 调度、浏览器外壳与网络。
// 请求从真实按钮/form 回调进入主面板写入队列，不在 stub 中复制维护逻辑。
function fixture(name = 'ProjectBoardPanel', initialProps = {}) {
  const instances = new Map(), components = new Map(), requests = [], events = [], timers = new Map(), confirmations = [];
  let current, effects = [], changed = false, tree, props = initialProps, timerId = 0, created = 0, confirmAnswer = true;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  function slot(initialize) { const at = current.cursor++; if (!(at in current.slots)) current.slots[at] = initialize(); return [current.slots[at], at, current]; }
  function effect(callback, deps) {
    const [saved] = slot(() => ({}));
    if (!same(saved.deps, deps)) { saved.deps = deps; effects.push(() => { saved.cleanup?.(); saved.cleanup = callback(); }); }
  }
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== false && child != null) }),
    useState(initial) { const [value, at, owner] = slot(() => typeof initial === 'function' ? initial() : initial); return [value, next => { const value = typeof next === 'function' ? next(owner.slots[at]) : next; if (!Object.is(value, owner.slots[at])) { owner.slots[at] = value; changed = true; } }]; },
    useRef: initial => slot(() => ({ current: initial }))[0],
    useEffect: effect, useLayoutEffect: effect,
    useCallback(callback, deps) { const [saved] = slot(() => ({})); if (!same(saved.deps, deps)) { saved.callback = callback; saved.deps = deps; } return saved.callback; },
    useId: () => slot(() => 'maintenance-' + instances.size + '-' + current.cursor)[0],
  };
  const storage = new Map([['dsh.project-board.workspace.v1', '/A']]);
  const workspaces = ['/A', '/B'].map(path => ({ path, workspaceId: 'workspace-' + path, hasBoard: true }));
  const context = {
    React, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { innerWidth: 1200, addEventListener() {}, removeEventListener() {}, confirm(message) { confirmations.push(message); return confirmAnswer; } },
    document: { body: { style: {} }, addEventListener() {}, removeEventListener() {} },
    EventSource: class {
      constructor(url) { this.url = url; this.listeners = new Map(); events.push(this); }
      addEventListener(name, callback) { this.listeners.set(name, callback); }
      close() { this.closed = true; }
    },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); },
    PbIcon: () => null, PbExecutionBadge: () => null, PbConversationMenu: () => null,
    BoardCanvas: function BoardCanvas({ board }) { return React.createElement('canvas', { 'data-board': board }); },
    PbEmbeddedConversation: function PbEmbeddedConversation({ sessionId }) { return React.createElement('div', { 'data-embedded-session': sessionId }); },
    PbConversationDrawer: () => null, PbArtifactViewer: () => null,
    useBoardThreadResults: () => ({}), useBoardJobs: () => ({}), pbItemExecution: () => ({}),
    pbThreadsOf: item => item?.threads || [], pbExecutionContext: (_board, item) => ({ ids: (item.threads || []).map(row => row.sessionId) }),
    fetchJson(url, options = {}) {
      if (url.endsWith('/workspaces')) return Promise.resolve({ workspaces });
      const pending = deferred(); requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null, ...pending }); return pending.promise;
    },
  };
  vm.createContext(context);
  const api = vm.runInContext(source + '\npbFetchJson = fetchJson; useObservableSource = source => source; ({ ProjectBoardPanel, PbMaintenancePanel, PbNodeInspector });', context);
  function renderNode(node, path, visited) {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const identity = path + ':' + node.type.name + ':' + (node.props.key || '');
      visited.add(identity); if (!instances.has(identity)) instances.set(identity, { slots: [], cursor: 0 });
      const parent = current; current = instances.get(identity); current.cursor = 0;
      components.set(node.type.name, node);
      const result = node.type({ ...node.props, children: node.children }); current = parent;
      return renderNode(result, identity, visited);
    }
    return { ...node, children: node.children.map((child, index) => renderNode(child, path + '/' + (child?.props?.key || index), visited)) };
  }
  function render(nextProps = props) {
    props = nextProps;
    for (let turns = 0; turns < 30; turns++) {
      changed = false; effects = []; components.clear();
      const visited = new Set(); tree = renderNode(React.createElement(api[name], props), 'root', visited);
      for (const [key, owner] of instances) if (!visited.has(key)) { for (const cell of owner.slots) cell?.cleanup?.(); instances.delete(key); }
      for (const run of effects) run();
      if (!changed) return tree;
    }
    throw new Error('effect 未收敛');
  }
  const panelProps = {
    workspacesSource: { items: workspaces }, sessionsSource: { byId: {} }, sessionStatusSource: {},
    createSession: async (_workspace, id) => { created++; return id; }, openSession: async () => {},
    acquireConversationSession() {}, initializeDraft() {}, SessionProvider() {}, renderSlot() {}, ...initialProps,
  };
  if (name === 'ProjectBoardPanel') props = panelProps;
  render();
  return {
    render, requests, events, confirmations, component: name => components.get(name), get tree() { return tree; }, get created() { return created; },
    get confirmAnswer() { return confirmAnswer; }, set confirmAnswer(value) { confirmAnswer = value; },
    switchTo(path) { field(tree, '选择 workspace').props.onChange({ target: { value: path } }); },
    change(label, value) { field(tree, label).props.onChange({ target: { value } }); return render(); },
    async flush() { await tick(); return render(); },
    runTimers() { const scheduled = [...timers.values()]; timers.clear(); for (const callback of scheduled) callback(); },
    unmount() { for (const owner of instances.values()) for (const cell of owner.slots) cell?.cleanup?.(); },
  };
}
const stateRequests = app => app.requests.filter(row => row.url.includes('/state?'));
const writes = app => app.requests.filter(row => row.body);
const maintenanceWrites = app => writes(app).filter(row => row.url.endsWith('/maintenance'));
async function ready(initialBoard = board()) {
  const app = fixture(); stateRequests(app)[0].resolve({ exists: true, board: initialBoard }); await app.flush(); return app;
}
function expand(app) { if (recordToggle(app.tree).props['aria-expanded'] !== true) { recordToggle(app.tree).props.onClick(); app.render(); } }
function start(app, operation) {
  expand(app);
  if (operation === 'update') return button(app.tree, '更新看板').props.onClick();
  if (operation === 'notify') { app.change('通知看板 Lead 的附言', '请检查这次新增'); return formFor(app.tree, '通知看板 Lead 的附言').props.onSubmit(event()); }
  if (operation === 'configure') { app.change('看板检查目录', 'docs\nmain'); return formFor(app.tree, '看板检查目录').props.onSubmit(event()); }
  return find(find(app.tree, node => node.props['data-conflict-id'] === 'field'), node => node.props['data-maintenance-choice'] === 'use_disk').props.onClick();
}

test('更新按钮只notify原Lead按项目目标整理，同帧去重，排队回执不冒称整理完成', async () => {
  const app = await ready();
  assert.equal(nodes(app.tree).some(node => node.props['aria-label'] === '看板维护记录'), false);
  expand(app); app.change('通知看板 Lead 的附言', updateMessage);
  const update = button(app.tree, '更新看板').props.onClick;
  const first = update(), duplicate = update(); await app.flush();
  assert.equal(maintenanceWrites(app).length, 1);
  const request = maintenanceWrites(app)[0];
  assert.equal(request.method, 'POST');
  assert.deepEqual(Object.keys(request.body).sort(), ['commandId', 'message', 'operation', 'workspacePath']);
  assert.equal(request.body.operation, 'notify'); assert.equal(request.body.message, updateMessage);
  assert.equal(request.body.workspacePath, '/A'); assert.ok(request.body.commandId);
  assert.equal(button(app.tree, '通知中…').props.disabled, true);
  request.resolve({ board: board('/A', 2, { candidates: candidates(), lastScanAt: '2026-10-19T14:05:00.000Z', lastSummary: '已检查关联入口，发现 2 条待整理线索' }), summary: '已整理完成', sessionId: 'lead-/A' });
  await Promise.all([first, duplicate]); await app.flush();
  assert.match(text(app.tree), /已通知看板 Lead，整理请求已排队/); assert.match(text(app.tree), /上次检查/);
  assert.ok(!text(app.tree).includes('已整理完成')); assert.match(text(recordToggle(app.tree)), /待整理 2/);
  assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, updateMessage, '主按钮不清理独立附言草稿，即使文本恰好相同');
  assert.equal(button(app.tree, '更新看板').props.disabled, false);
  const current = find(app.tree, node => node.type === 'canvas').props['data-board'];
  assert.equal(current.revision, 2); assert.equal(current.nodes.length, 1);
  assert.equal(find(app.tree, node => node.props['data-embedded-session']).props['data-embedded-session'], 'lead-/A');
  assert.equal(app.created, 0);
});

test('候选线索仅显示pending数量和整理原则，138个目录也不铺成条目列表', async () => {
  const pending = Array.from({ length: 138 }, (_, index) => ({ path: 'results/private-' + index, kind: 'directory', title: '候选目录-' + index, summary: '资料线索', fingerprint: String(index), status: 'pending' }));
  const app = await ready(board('/A', 1, { candidates: [...pending, ...candidates().filter(row => row.status === 'linked')] })); expand(app);
  assert.match(text(recordToggle(app.tree)), /待整理 138/);
  assert.match(text(field(app.tree, '待整理资料线索')), /待整理线索 138 条.*优先补充现有任务与来源/);
  for (const row of pending) { assert.ok(!text(app.tree).includes(row.path)); assert.ok(!text(app.tree).includes(row.title)); }
  assert.equal(find(app.tree, node => node.type === 'canvas').props['data-board'].nodes.length, 1);
  assert.equal(nodes(app.tree).filter(node => node.props['data-deletion-id'] || node.props['data-conflict-id']).length, 0);
  assert.equal(writes(app).length, 0);
});

test('主按钮通知失败可复用原请求重试，不影响单独附言草稿或创建新会话', async () => {
  const app = await ready(); expand(app); app.change('通知看板 Lead 的附言', '还未提交的独立附言');
  const first = button(app.tree, '更新看板').props.onClick(); await app.flush();
  const request = maintenanceWrites(app)[0]; request.reject(new Error('暂时不能通知')); await first; await app.flush();
  assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, '还未提交的独立附言');
  const retry = button(app.tree, '重试此操作').props.onClick(); await app.flush();
  assert.deepEqual(maintenanceWrites(app)[1].body, request.body);
  maintenanceWrites(app)[1].resolve({ board: board('/A', 2), sessionId: 'lead-/A', coalesced: true, summary: '队列已接受' }); await retry; await app.flush();
  assert.match(text(app.tree), /已合并通知，待看板 Lead 整理/);
  assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, '还未提交的独立附言'); assert.equal(app.created, 0);
});

test('缺少原Lead时更新入口禁用，避免借更新按钮另建会话', async () => {
  let calls = 0;
  const app = fixture('PbMaintenancePanel', { board: { ...board(), assistant: undefined }, workspacePath: '/A', workspaceScope: {}, isCurrentWorkspace: () => true, runMaintenance: async () => { calls++; return { board: board() }; } });
  assert.equal(button(app.tree, '更新看板').props.disabled, true); await button(app.tree, '更新看板').props.onClick();
  expand(app); assert.equal(button(app.tree, '通知看板 Lead').props.disabled, true); assert.equal(calls, 0);
});

test('scan桥接仍可只检查，主更新按钮采用独立notify流程', async () => {
  const app = await ready();
  const checking = app.component('PbMaintenancePanel').props.runMaintenance('scan'); await app.flush();
  assert.equal(maintenanceWrites(app)[0].body.operation, 'scan'); assert.equal(maintenanceWrites(app)[0].body.message, undefined);
  maintenanceWrites(app)[0].resolve({ board: board('/A', 2, { candidates: candidates(), lastSummary: '检查得到线索' }), summary: '检查得到线索' }); await checking; await app.flush();
  assert.match(text(recordToggle(app.tree)), /待整理 2/); assert.equal(app.created, 0);
});

test('维护面板展示归档原因、收据、字段双方值，所有冲突选择携带精确参数', async () => {
  const choices = [['field', 'keep_board', '保留看板'], ['field', 'use_disk', '采用盘上'], ['archive', 'keep_files', '保留文件'], ['archive', 'retry_archive', '重试归档'], ['missing', 'keep_board', '缺件保留记录']];
  for (const [conflictId, choice, label] of choices) {
    const maintenance = { conflicts: conflicts(), deletions: [
      { id: 'deletion', title: '共享文件', targetType: 'todo', targetId: 'todo', status: 'needs_decision', reason: '仍被另一个任务引用', paths: ['results/shared.txt'] },
      { id: 'done', title: '已归档记录', status: 'archived', reason: '独占且没有活动会话', paths: ['results/solo.txt'], receipt: { fileCount: 3, bytes: 2048, receiptPath: 'board/receipts/archive.json', moves: [{ from: 'results/solo.txt', to: 'archive/solo.txt' }] } },
    ] };
    const app = await ready(board('/A', 1, maintenance)); expand(app);
    assert.match(text(recordToggle(app.tree)), /需决定 3/);
    for (const expected of ['看板当前值', '看板保留的说明', '盘上新值', '磁盘新说明', '仍被另一个任务引用', '已归档 3 个文件 · 2.0 KB', 'board/receipts/archive.json']) assert.ok(text(app.tree).includes(expected));
    const conflict = find(app.tree, node => node.props['data-conflict-id'] === conflictId);
    const pending = button(conflict, label).props.onClick(); await app.flush();
    const request = maintenanceWrites(app)[0];
    if (choice === 'retry_archive') {
      assert.ok(app.confirmations.at(-1).includes('results/shared.txt'));
      assert.ok(app.confirmations.at(-1).includes('共享或活动文件仍会保留'));
    }
    assert.deepEqual({ ...request.body, commandId: 'id' }, { workspacePath: '/A', operation: 'resolve', commandId: 'id', conflictId, choice });
    const updated = { ...maintenance, conflicts: maintenance.conflicts.map(row => row.id === conflictId ? { ...row, status: 'resolved' } : row) };
    request.resolve({ board: board('/A', 2, updated), summary: '已记录选择' }); await pending; await app.flush();
    assert.match(text(recordToggle(app.tree)), /需决定 2/); assert.match(text(app.tree), /已处理决定 · 1/);
  }
});

test('重试归档先确认列出的范围，取消不发请求，保留文件提示仍保留删除标记', async () => {
  const app = await ready(board('/A', 1, { conflicts: conflicts(), deletions: [{ id: 'deletion', title: '共享文件', status: 'needs_decision', reason: '活动会话正在使用', paths: ['results/shared.txt'] }] })); expand(app);
  const conflict = find(app.tree, node => node.props['data-conflict-id'] === 'archive');
  assert.match(text(conflict), /保留文件会留下删除标记/); assert.match(text(conflict), /results\/shared.txt/);
  app.confirmAnswer = false; await button(conflict, '重试归档').props.onClick(); await app.flush();
  assert.equal(maintenanceWrites(app).length, 0);
});

test('目录配置换行解析去重，异常保留原输入，重试复用commandId并不发送内部草稿', async () => {
  const app = await ready(); expand(app);
  assert.equal(field(app.tree, '看板检查目录').props.value, '');
  const draft = ' docs \nmain\n docs\n'; app.change('看板检查目录', draft);
  const save = formFor(app.tree, '看板检查目录').props.onSubmit;
  const first = save(event()), duplicate = save(event()); await app.flush();
  assert.equal(maintenanceWrites(app).length, 1);
  const request = maintenanceWrites(app)[0]; assert.deepEqual(request.body.roots, ['docs', 'main']); assert.equal(request.body.draft, undefined);
  request.reject(new Error('目录暂时不可读')); await Promise.all([first, duplicate]); await app.flush();
  assert.equal(field(app.tree, '看板检查目录').props.value, draft); assert.match(text(app.tree), /目录暂时不可读.*输入已保留/);
  const retry = button(app.tree, '重试此操作').props.onClick(); await app.flush();
  assert.deepEqual(maintenanceWrites(app)[1].body, request.body);
  app.change('看板检查目录', 'newer');
  maintenanceWrites(app)[1].resolve({ board: board('/A', 2, { scope: 'custom', roots: ['docs', 'main'] }), summary: '目录已保存' }); await retry; await app.flush();
  assert.equal(field(app.tree, '看板检查目录').props.value, 'newer'); assert.equal(button(app.tree, '保存检查目录').props.disabled, false);
});

test('空目录配置发送roots[]恢复linked，失败保留空白草稿并支持重试', async () => {
  const app = await ready(board('/A', 1, { scope: 'custom', roots: ['docs'] })); expand(app);
  assert.equal(field(app.tree, '看板检查目录').props.value, 'docs');
  app.change('看板检查目录', ' \n ');
  const saving = formFor(app.tree, '看板检查目录').props.onSubmit(event()); await app.flush();
  const request = maintenanceWrites(app)[0]; assert.deepEqual(request.body.roots, []);
  request.reject(new Error('配置保存失败')); await saving; await app.flush();
  assert.equal(field(app.tree, '看板检查目录').props.value, ' \n ');
  const retry = button(app.tree, '重试此操作').props.onClick(); await app.flush(); assert.deepEqual(maintenanceWrites(app)[1].body, request.body);
  maintenanceWrites(app)[1].resolve({ board: board('/A', 2), summary: '恢复关联范围' }); await retry; await app.flush();
  assert.equal(field(app.tree, '看板检查目录').props.value, ''); assert.match(text(app.tree), /已恢复检查已关联的活动入口/);
  const legacy = await ready(board('/A', 1, { scope: 'linked', roots: ['.'] })); expand(legacy);
  assert.equal(field(legacy.tree, '看板检查目录').props.value, '', 'linked范围不会重现旧版根目录默认值');
});

test('通知先走notify接口并复用Lead，失败保留附言、成功仅清理本次文本', async () => {
  const app = await ready(); expand(app);
  app.change('通知看板 Lead 的附言', '请看新增内容');
  const first = formFor(app.tree, '通知看板 Lead 的附言').props.onSubmit(event()); await app.flush();
  const request = maintenanceWrites(app)[0];
  assert.deepEqual({ ...request.body, commandId: 'id' }, { workspacePath: '/A', operation: 'notify', commandId: 'id', message: '请看新增内容' });
  request.reject(new Error('会话通知失败')); await first; await app.flush();
  assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, '请看新增内容');
  const retry = button(app.tree, '重试此操作').props.onClick(); await app.flush(); assert.deepEqual(maintenanceWrites(app)[1].body, request.body);
  app.change('通知看板 Lead 的附言', '下一条补充');
  maintenanceWrites(app)[1].resolve({ board: board('/A', 2), summary: '已检查', sessionId: 'lead-/A', coalesced: true }); await retry; await app.flush();
  assert.equal(app.created, 0); assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, '下一条补充');
  assert.equal(find(app.tree, node => node.props['data-embedded-session']).props['data-embedded-session'], 'lead-/A');
  assert.match(text(app.tree), /已合并通知/);
  const next = formFor(app.tree, '通知看板 Lead 的附言').props.onSubmit(event()); await app.flush();
  maintenanceWrites(app)[2].resolve({ board: board('/A', 3), summary: '已检查', sessionId: 'lead-/A' }); await next; await app.flush();
  assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, '');
});

test('过期冲突保留选择入口，重新更新通过notify检查并通知原Lead', async () => {
  const app = await ready(board('/A', 1, { conflicts: conflicts() }));
  const resolving = start(app, 'resolve'); await app.flush();
  maintenanceWrites(app)[0].reject(Object.assign(new Error('来源已变化，请先更新看板再决定'), { code: 'MAINTENANCE_CONFLICT_STALE' })); await resolving; await app.flush();
  assert.match(text(app.tree), /来源已变化，请先更新看板再决定/);
  assert.equal(button(find(app.tree, node => node.props['data-conflict-id'] === 'field'), '采用盘上').props.disabled, false);
  const update = button(app.tree, '更新看板').props.onClick(); await app.flush();
  assert.equal(maintenanceWrites(app)[1].body.operation, 'notify');
  maintenanceWrites(app)[1].resolve({ board: board('/A', 2, { lastSummary: '已重新检查', conflicts: conflicts().slice(0, 1) }), summary: '已重新检查', sessionId: 'lead-/A' }); await update; await app.flush();
  assert.match(text(recordToggle(app.tree)), /需决定 1/); assert.equal(nodes(app.tree).some(node => node.props.role === 'alert'), false);
});

test('所有维护异步操作在A→B和A→B→A后隔离晚到结果、错误、旧回调', async () => {
  for (const operation of ['update', 'configure', 'notify', 'resolve']) for (const backToA of [false, true]) for (const failure of [false, true]) {
    const app = await ready(board('/A', 1, { conflicts: conflicts() }));
    const oldUpdate = button(app.tree, '更新看板').props.onClick;
    const pending = start(app, operation); await app.flush();
    const request = maintenanceWrites(app)[0];
    const oldInput = field(app.tree, '通知看板 Lead 的附言').props.onChange;
    app.switchTo('/B'); if (backToA) app.switchTo('/A'); app.render();
    const path = backToA ? '/A' : '/B';
    stateRequests(app).at(-1).resolve({ exists: true, board: board(path, 3, { lastSummary: '当前项目结果', scope: 'custom', roots: ['current'] }) }); await app.flush(); expand(app);
    app.change('通知看板 Lead 的附言', '当前项目草稿'); app.change('看板检查目录', 'current-draft');
    if (failure) request.reject(new Error('旧项目失败')); else request.resolve({ board: board('/A', 99, { lastSummary: '旧项目结果' }), summary: '旧项目结果', sessionId: 'old-session' });
    await pending; await app.flush();
    assert.equal(find(app.tree, node => node.type === 'canvas').props['data-board'].workspacePath, path);
    assert.equal(find(app.tree, node => node.type === 'canvas').props['data-board'].revision, 3);
    assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, '当前项目草稿');
    assert.equal(field(app.tree, '看板检查目录').props.value, 'current-draft');
    assert.ok(!text(app.tree).includes('旧项目')); assert.equal(nodes(app.tree).some(node => node.props.role === 'alert'), false);
    assert.equal(button(app.tree, '更新看板').props.disabled, false);
    await oldUpdate(); oldInput({ target: { value: '旧回调输入' } }); await app.flush();
    assert.equal(maintenanceWrites(app).length, 1); assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, '当前项目草稿');
  }
});

test('卸载后的晚到维护响应不触发继续会话，失败也不写回组件', async () => {
  for (const failure of [false, true]) {
    const pending = deferred(); let continued = 0;
    const app = fixture('PbMaintenancePanel', { board: board(), workspacePath: '/A', workspaceScope: {}, isCurrentWorkspace: () => true, runMaintenance: () => pending.promise, onContinue: () => { continued++; } });
    expand(app); app.change('通知看板 Lead 的附言', '即将卸载');
    const operation = formFor(app.tree, '通知看板 Lead 的附言').props.onSubmit(event()); app.unmount();
    if (failure) pending.reject(new Error('晚到失败')); else pending.resolve({ board: board('/A', 2), sessionId: 'lead-/A' });
    await operation; assert.equal(continued, 0);
  }
});

test('SSE更新维护摘要、冲突数和未编辑目录，同时保留本地草稿', async () => {
  const app = await ready(); expand(app);
  app.change('通知看板 Lead 的附言', '尚未发出'); app.change('看板检查目录', 'draft-roots');
  app.events.at(-1).listeners.get('board')(); assert.equal(stateRequests(app).length, 1);
  app.runTimers(); assert.equal(stateRequests(app).length, 2);
  stateRequests(app).at(-1).resolve({ exists: true, board: board('/A', 5, { scope: 'custom', roots: ['remote'], candidates: candidates(), lastSummary: 'SSE收到新增内容', conflicts: conflicts() }) }); await app.flush();
  assert.match(text(app.tree), /SSE收到新增内容/); assert.match(text(recordToggle(app.tree)), /需决定 3/); assert.match(text(recordToggle(app.tree)), /待整理 2/);
  assert.equal(field(app.tree, '通知看板 Lead 的附言').props.value, '尚未发出'); assert.equal(field(app.tree, '看板检查目录').props.value, 'draft-roots');
  app.events[0].listeners.get('board')(); app.runTimers();
  stateRequests(app).at(-1).resolve({ exists: true, board: board('/A', 6, { candidates: candidates().map(row => ({ ...row, status: 'linked' })) }) }); await app.flush();
  assert.ok(!text(recordToggle(app.tree)).includes('待整理')); assert.match(text(field(app.tree, '待整理资料线索')), /待整理线索 0 条/);
  assert.equal(field(app.tree, '看板检查目录').props.value, 'draft-roots');
  assert.equal(maintenanceWrites(app).length, 0); assert.equal(app.events.length, 1);
  const fresh = await ready(); expand(fresh); fresh.events[0].listeners.get('board')(); fresh.runTimers();
  stateRequests(fresh).at(-1).resolve({ exists: true, board: board('/A', 2, { scope: 'custom', roots: ['docs'] }) }); await fresh.flush();
  assert.equal(field(fresh.tree, '看板检查目录').props.value, 'docs');
});

test('删除并归档使用原命令，确认说明独占归档、待决策与会话保留，节点不递归删除分支', async () => {
  for (const [kind, title, id] of [['node', '节点', 'node'], ['task', '任务', 'task'], ['todo', '待办', 'todo']]) {
    const app = await ready(); app.component('BoardCanvas').props.onSelectNode('node'); app.render();
    const remove = field(app.tree, '删除并归档' + ({ node: '节点', task: '任务', todo: '待办' }[kind]) + '：' + title);
    assert.equal(text(remove), '删除并归档');
    app.confirmAnswer = false; remove.props.onClick(event()); await app.flush(); assert.equal(writes(app).length, 0);
    app.confirmAnswer = true; remove.props.onClick(event()); await app.flush();
    assert.equal(writes(app)[0].body.action, 'delete_' + kind); assert.deepEqual(writes(app)[0].body.input, { id });
    const confirmation = app.confirmations.at(-1); for (const expected of ['仅独占文件可自动归档', '待决策', '既有会话会保留']) assert.ok(confirmation.includes(expected));
    if (kind === 'node') { assert.ok(confirmation.includes('直挂')); assert.ok(confirmation.includes('子节点会保留')); }
    writes(app)[0].resolve({ board: board('/A', 2) }); await app.flush();
  }
});

test('任务与待办抽屉删除复用归档确认，取消不发命令，确认后保留原删除命令', () => {
  const drawerSource = fs.readFileSync(new URL('../client-src/conversations.js', import.meta.url), 'utf8');
  const calls = [], confirmations = []; let accepted = false;
  const context = { React: {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child != null && child !== false) }),
    createContext: () => ({}), useState: initial => [initial, () => {}],
  }, window: { confirm: message => { confirmations.push(message); return accepted; } },
  pbTaskConversationContext: () => '条目背景', pbTaskConversationDraft: text => text,
  PbIcon: () => null,
  };
  vm.createContext(context);
  const Drawer = vm.runInContext(source + '\n' + drawerSource + '\nPbConversationDrawer;', context);
  for (const targetType of ['task', 'todo']) {
    const value = board(), item = value[targetType === 'task' ? 'tasks' : 'todos'][0];
    const tree = Drawer({ board: value, item, targetType, task: value.tasks[0], node: value.nodes[0], runCommand: (...args) => calls.push(plain(args)) });
    const remove = button(tree, '删除并归档'); accepted = false; remove.props.onClick(); assert.equal(calls.length, 0);
    accepted = true; remove.props.onClick(); assert.deepEqual(calls.pop(), ['delete_' + targetType, { id: item.id }]);
    for (const expected of ['仅独占文件可自动归档', '待决策', '既有会话会保留']) assert.ok(confirmations.at(-1).includes(expected));
  }
});

test('构建入口在panel之前载入维护fragment，完整源码可编译且不生成构建产物', () => {
  const buildSource = fs.readFileSync(new URL('../build-client.mjs', import.meta.url), 'utf8');
  assert.ok(buildSource.indexOf("'maintenance.js'") < buildSource.indexOf("'panel.js'"));
  assert.doesNotThrow(() => new vm.Script(source));
});
