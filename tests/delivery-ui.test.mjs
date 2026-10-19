import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { BoardService } from '../service.mjs';

const source = fs.readFileSync(new URL('../board-model.js', import.meta.url), 'utf8').replace(/^export /gm, '') + '\n' + ['state.js', 'inspector.js'].map(name => fs.readFileSync(new URL('../client-src/' + name, import.meta.url), 'utf8')).join('\n');
const exported = '({ PbDeliveryEditor, PbExpandableText, PbNodeMembership, PbChangeHistory, PbNodeInspector, PbTaskRow })';
const event = () => ({ preventDefault() {}, stopPropagation() {} });
const plain = value => JSON.parse(JSON.stringify(value));
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children || []).flatMap(nodes)];
const text = tree => tree == null || tree === false ? '' : typeof tree !== 'object' ? String(tree) : (tree.children || []).map(text).join('');
const find = (tree, predicate) => { const found = nodes(tree).find(predicate); assert.ok(found, '未找到需要的界面元素'); return found; };
const field = (tree, label) => find(find(tree, row => row.type === 'label' && row.children[0] === label), row => ['input', 'textarea', 'select'].includes(row.type));
const button = (tree, label) => find(tree, row => row.type === 'button' && text(row) === label);

// 小型 hooks/reconciliation harness：运行真实组件和 effects，按组件 key 隔离状态。
// 不把保存逻辑复制进 mock；命令成功、失败及跨记录响应由各测试显式控制。
function fixture(name, initialProps) {
  const instances = new Map();
  let current, effects = [], changed = false, props = initialProps, tree;
  function slot(initialize) { const at = current.cursor++; if (!(at in current.slots)) current.slots[at] = initialize(); return [current.slots[at], at, current]; }
  function effect(callback, deps) {
    const [saved] = slot(() => ({}));
    if (!saved.deps || deps.some((value, index) => !Object.is(value, saved.deps[index]))) {
      saved.deps = deps; effects.push(() => { saved.cleanup?.(); saved.cleanup = callback(); });
    }
  }
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }),
    useState(initial) { const [value, at, owner] = slot(() => typeof initial === 'function' ? initial() : initial); return [value, next => { const value = typeof next === 'function' ? next(owner.slots[at]) : next; if (!Object.is(value, owner.slots[at])) { owner.slots[at] = value; changed = true; } }]; },
    useRef: initial => slot(() => ({ current: initial }))[0],
    useEffect: effect, useLayoutEffect: effect,
  };
  const context = { React, PbIcon: () => null, PbExecutionBadge: () => null, PbConversationMenu: () => null };
  vm.createContext(context);
  const api = vm.runInContext(source + '\n' + exported, context);
  function renderNode(node, path, visited) {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const identity = path + ':' + node.type.name + ':' + (node.props.key || '');
      visited.add(identity);
      if (!instances.has(identity)) instances.set(identity, { slots: [], cursor: 0 });
      const parent = current;
      current = instances.get(identity); current.cursor = 0;
      const result = node.type({ ...node.props, children: node.children });
      current = parent;
      return renderNode(result, identity, visited);
    }
    return { ...node, children: node.children.map((child, index) => renderNode(child, path + '/' + (child?.props?.key || index), visited)) };
  }
  function render(nextProps = props) {
    props = nextProps;
    let rounds = 0;
    do {
      changed = false; effects = [];
      const visited = new Set();
      tree = renderNode(React.createElement(api[name], props), 'root', visited);
      for (const [key, owner] of instances) if (!visited.has(key)) { for (const saved of owner.slots) saved?.cleanup?.(); instances.delete(key); }
      effects.forEach(run => run());
      assert.ok(++rounds < 10, 'effects 不应产生渲染循环');
    } while (changed);
    return tree;
  }
  render();
  return { api, render, get tree() { return tree; }, change(label, value) { field(render(), label).props.onChange({ target: { value } }); return render(); }, submit() { return find(render(), row => row.type === 'form').props.onSubmit(event()); } };
}

function deliveryFixture(item = { id: 't1', acceptance: '原标准' }, runCommand = async () => ({ board: {} }), targetType = 'task', extra = {}) {
  return fixture('PbDeliveryEditor', { item, targetType, runCommand, ...extra });
}

test('旧验收文本不迁移、不推断结果；只提交显式修改的delivery字段', async () => {
  const calls = [];
  const f = deliveryFixture({ id: 't1', acceptance: '完成且未通过可靠性门', delivery: undefined }, async (...args) => { calls.push(plain(args)); return { board: {} }; });
  for (const label of ['验收标准', '交付结论', '结果标签', '验收状态', '主成果']) assert.equal(field(f.tree, label).props['aria-label'], label);
  assert.equal(field(f.tree, '验收标准').props.value, '完成且未通过可靠性门');
  assert.equal(field(f.tree, '交付结论').props.value, '');
  assert.equal(field(f.tree, '结果标签').props.value, 'unspecified');
  assert.equal(field(f.tree, '验收状态').props.value, 'none');
  await f.submit(); assert.equal(calls.length, 0);
  f.change('交付结论', '本次显式结论'); await f.submit();
  assert.deepEqual(calls[0], ['upsert_task', { task: { id: 't1', delivery: { summary: '本次显式结论' } }, base: { delivery: { summary: '' } } }, { throwOnError: true }]);
  f.change('验收标准', '新标准'); await f.submit();
  assert.deepEqual(calls[1][1], { task: { id: 't1', acceptance: '新标准' }, base: { acceptance: '完成且未通过可靠性门' } });
});

test('完整结果与验收选项独立，待办写入todo且无完成状态副作用', async () => {
  const calls = [];
  const f = deliveryFixture({ id: 'd1', status: 'done' }, async (...args) => { calls.push(plain(args)); return { board: {} }; }, 'todo');
  assert.deepEqual(nodes(field(f.tree, '结果标签')).filter(row => row.type === 'option').map(row => [row.props.value, text(row)]), [
    ['unspecified', '未填写'], ['supported', '支持假设'], ['not_supported', '未支持假设'], ['not_triggered', '条件未触发'], ['inconclusive', '尚无定论'],
  ]);
  assert.deepEqual(nodes(field(f.tree, '验收状态')).filter(row => row.type === 'option').map(row => [row.props.value, text(row)]), [
    ['none', '未提交'], ['pending', '待验收'], ['accepted', '已验收'], ['changes_requested', '需修改'],
  ]);
  f.change('结果标签', 'not_triggered'); f.change('验收状态', 'accepted'); await f.submit();
  assert.deepEqual(calls[0][1], { todo: { id: 'd1', delivery: { outcome: 'not_triggered', review: 'accepted' } }, base: { delivery: { outcome: 'unspecified', review: 'none' } } });
});

test('失败保留草稿与明确冲突提示，重试成功后关闭未保存标记', async () => {
  let calls = 0;
  const f = deliveryFixture(undefined, async () => { if (++calls === 1) throw Object.assign(new Error('看板已更新'), { code: 'STALE_REVISION' }); return { board: {} }; });
  f.change('交付结论', '待保存草稿'); await f.submit();
  assert.equal(field(f.render(), '交付结论').props.value, '待保存草稿');
  assert.match(text(find(f.tree, row => row.props.role === 'alert')), /版本冲突.*草稿已保留/);
  assert.equal(button(f.tree, '保存交付信息').props.disabled, false);
  await f.submit();
  assert.equal(calls, 2); assert.equal(button(f.render(), '保存交付信息').props.disabled, true);
});

test('在途重复提交只有一次命令，成功后保留继续输入的新版草稿', async () => {
  let resolve, count = 0;
  const f = deliveryFixture(undefined, () => { count++; return new Promise(done => { resolve = done; }); });
  f.change('交付结论', '第一版');
  const submit = find(f.tree, row => row.type === 'form').props.onSubmit;
  const pending = submit(event()); await submit(event());
  assert.equal(count, 1); assert.equal(button(f.render(), '保存中…').props.disabled, true);
  f.change('交付结论', '第二版'); resolve({ board: {} }); await pending;
  assert.equal(field(f.render(), '交付结论').props.value, '第二版');
  assert.equal(button(f.tree, '保存交付信息').props.disabled, false);
});

test('切换记录重建草稿，旧记录晚到响应不会清空新记录输入', async () => {
  let resolve;
  const runCommand = () => new Promise(done => { resolve = done; });
  const f = deliveryFixture({ id: 'a', acceptance: '甲' }, runCommand);
  f.change('交付结论', '甲草稿'); const pending = f.submit();
  f.render({ item: { id: 'b', acceptance: '乙', delivery: { summary: '乙原文' } }, targetType: 'todo', runCommand });
  assert.equal(field(f.tree, '验收标准').props.value, '乙'); assert.equal(field(f.tree, '交付结论').props.value, '乙原文');
  f.change('交付结论', '乙新草稿'); resolve({ board: {} }); await pending;
  assert.equal(field(f.render(), '交付结论').props.value, '乙新草稿');
});

test('同记录远端更新只同步未编辑字段，保存不回写远端字段', async () => {
  const calls = [], runCommand = async (...args) => { calls.push(plain(args)); return { board: {} }; };
  const f = deliveryFixture({ id: 'a', acceptance: '旧标准', delivery: { summary: '旧结论', review: 'none' } }, runCommand);
  f.change('交付结论', '本地草稿');
  f.render({ item: { id: 'a', acceptance: '远端标准', delivery: { summary: '远端结论', review: 'pending' } }, targetType: 'task', runCommand });
  assert.equal(field(f.tree, '验收标准').props.value, '远端标准');
  assert.equal(field(f.tree, '交付结论').props.value, '本地草稿');
  assert.equal(field(f.tree, '验收状态').props.value, 'pending');
  await f.submit(); assert.deepEqual(calls[0][1], { task: { id: 'a', delivery: { summary: '本地草稿' } }, base: { delivery: { summary: '旧结论' } } });
});

test('中文组合输入、229兼容键码与长按回车不会误提交', async () => {
  let count = 0;
  const f = deliveryFixture(undefined, async () => { count++; return { board: {} }; });
  f.change('交付结论', '中文输入'); const form = find(f.tree, row => row.type === 'form');
  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    let prevented = false;
    form.props.onKeyDown({ key: 'Enter', nativeEvent, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  form.props.onCompositionStart(); await form.props.onSubmit(event()); assert.equal(count, 0);
  form.props.onCompositionEnd(); await f.submit(); assert.equal(count, 1);
});

test('显式提交验收写ISO时间，可单独清除时间', async () => {
  const calls = [];
  const f = deliveryFixture(undefined, async (...args) => { calls.push(plain(args)); return { board: {} }; });
  const before = Date.now(); await button(f.tree, '提交验收').props.onClick(event());
  const delivery = calls[0][1].task.delivery;
  assert.equal(delivery.review, 'pending');
  assert.equal(new Date(delivery.submittedAt).toISOString(), delivery.submittedAt);
  assert.ok(Date.parse(delivery.submittedAt) >= before && Date.parse(delivery.submittedAt) <= Date.now());
  button(f.render(), '清除提交时间').props.onClick(); await f.submit();
  assert.deepEqual(calls[1][1], { task: { id: 't1', delivery: { submittedAt: '' } }, base: { delivery: { submittedAt: delivery.submittedAt } } });
});

test('提交验收空响应保留状态、时间和草稿，普通保存重试不改提交时间', async () => {
  const calls = [];
  const f = deliveryFixture(undefined, async (...args) => { calls.push(plain(args)); return calls.length === 1 ? null : { board: {} }; });
  f.change('交付结论', '待验收的新结论');
  await button(f.tree, '提交验收').props.onClick(event());
  assert.match(text(find(f.render(), row => row.props.role === 'alert')), /草稿已保留/);
  assert.equal(field(f.tree, '验收状态').props.value, 'pending');
  assert.equal(field(f.tree, '交付结论').props.value, '待验收的新结论');
  await f.submit();
  assert.deepEqual(calls[1][1], calls[0][1]);
  assert.equal(button(f.render(), '保存交付信息').props.disabled, true);
});

test('任务树同时接入任务和待办，表单默认折叠且保留打开待办操作', () => {
  const task = { id: 't', nodeId: 'n', title: '任务', status: 'todo' }, todo = { id: 'd', taskId: 't', title: '待办', status: 'todo' }, opened = [];
  const f = fixture('PbTaskRow', { board: { tasks: [task], todos: [todo] }, task, executionFor() {}, threadUi: { selectedFor() {} }, onOpenTodo: id => opened.push(id), runCommand() {} });
  assert.deepEqual(nodes(f.tree).filter(row => row.props['data-delivery-target']).map(row => row.props['data-delivery-target']), ['task:t', 'todo:d']);
  for (const row of nodes(f.tree).filter(row => row.props.className === 'pb-delivery-details')) assert.equal(row.props.open, undefined);
  find(f.tree, row => row.props['data-todo-id'] === 'd').props.onClick(); assert.deepEqual(opened, ['d']);
  let stopped = false;
  find(f.tree, row => row.props['data-delivery-target'] === 'todo:d').props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});

test('主成果仅选登记产物，当前采用复用原预览回调且可以清除', async () => {
  const artifact = { path: 'results/figure.png', label: '结果图' }, opened = [], calls = [];
  const f = deliveryFixture({ id: 't1', artifacts: [artifact, { path: 'report.md' }], primaryArtifactPath: artifact.path }, async (...args) => { calls.push(plain(args)); return { board: {} }; }, 'task', { onOpenArtifact: row => opened.push(row) });
  const options = nodes(field(f.tree, '主成果')).filter(row => row.type === 'option');
  assert.deepEqual(options.map(row => row.props.value), ['', artifact.path, 'report.md']);
  find(f.tree, row => row.props.className === 'pb-primary-artifact').props.onClick();
  assert.equal(opened[0], artifact);
  f.change('主成果', 'outside.txt'); await f.submit(); assert.equal(calls.length, 0); assert.match(text(f.render()), /主成果已不在登记产物中/);
  f.change('主成果', ''); await f.submit(); assert.deepEqual(calls[0][1], { task: { id: 't1', primaryArtifactPath: '' }, base: { primaryArtifactPath: artifact.path } });
});

test('长摘要默认第一行短结论，完整原文可展开且逐字保留', () => {
  const original = '简短结论\n' + '详细证据。'.repeat(60) + '\n  保留缩进';
  const f = fixture('PbExpandableText', { text: original });
  const details = find(f.tree, row => row.type === 'details');
  assert.equal(details.props.open, undefined);
  assert.equal(find(f.tree, row => row.props.className === 'pb-summary-brief').children[0], '简短结论');
  assert.equal(find(details, row => row.props.className === 'pb-full-text').children[0], original);
});

test('未归属只依据contains父级，主题不告警，归属失败保留选择并去重', async () => {
  const node = { id: 'n', title: '图', kind: 'figure' }, parent = { id: 'p', title: '论文', kind: 'theme' };
  const board = { nodes: [node, parent], edges: [{ kind: 'depends', from: 'p', to: 'n' }] };
  let count = 0, reject;
  const f = fixture('PbNodeMembership', { board, node, parentCandidates: [parent], onReparentNode: id => { assert.equal(id, 'p'); count++; return new Promise((_, fail) => { reject = fail; }); } });
  assert.match(text(f.tree), /^未归属/);
  find(f.tree, row => row.type === 'select').props.onChange({ target: { value: 'p' } });
  const first = f.submit(); await f.submit(); assert.equal(count, 1);
  reject(Object.assign(new Error('归属已更新'), { code: 'STALE_REVISION' })); await first;
  assert.equal(find(f.render(), row => row.type === 'select').props.value, 'p');
  assert.match(text(f.tree), /版本冲突.*选择已保留/);
  const theme = fixture('PbNodeMembership', { board, node: parent, parentCandidates: [node] });
  assert.equal(text(theme.tree), '顶层项目分支');
  const owned = fixture('PbNodeMembership', { board: { ...board, edges: [{ kind: 'contains', from: 'p', to: 'n' }] }, node });
  assert.equal(text(owned.tree), '所属分支：论文');
});

test('历史精确匹配target并保持最新在前，显示操作者时间和撤销冲突', async () => {
  const at = '2026-10-19T12:00:00.000Z';
  const changes = [
    { id: 'new', at, actor: 'Lead', summary: '更新结论', targets: [{ type: 'node', id: 'n', title: '节点甲' }, { type: 'task', id: 't', title: '任务甲' }], undo: { status: 'available' } },
    { id: 'other', at, actor: '其他', summary: '无关历史', targets: [{ type: 'todo', id: 'n' }], undo: { status: 'available' } },
    { id: 'old', at, actor: '我', summary: '添加节点', targets: [{ type: 'node', id: 'n' }], undo: { status: 'undone', undoneBy: '我', undoneAt: at } },
    { id: 'blocked', at, actor: '我', summary: '不可撤销变更', targets: [{ type: 'node', id: 'n' }], undo: { status: 'unavailable', reason: '关联记录已有更新' } },
  ];
  let count = 0, reject;
  const f = fixture('PbChangeHistory', { board: { changes }, targetType: 'node', targetId: 'n', onUndoChange: id => { assert.equal(id, 'new'); count++; return new Promise((_, fail) => { reject = fail; }); } });
  assert.deepEqual(nodes(f.tree).filter(row => row.props['data-change-id']).map(row => row.props['data-change-id']), ['new', 'old', 'blocked']);
  assert.match(text(f.tree), /Lead.*10[-/]19/); assert.match(text(f.tree), /已撤销/); assert.match(text(f.tree), /关联记录已有更新/);
  const undo = button(f.tree, '撤销此变更').props.onClick; const pending = undo(); await undo(); assert.equal(count, 1);
  reject(Object.assign(new Error('目标已被后续编辑，不能撤销'), { code: 'UNDO_CONFLICT' })); await pending;
  assert.match(text(find(f.render(), row => row.props.role === 'alert')), /版本冲突.*不能撤销/);
});

test('节点产物标记当前采用、原预览不变，决策行可被导航定位', () => {
  const node = { id: 'n', kind: 'figure', title: '图1' }, artifact = { path: 'a.png', label: '主图' }, opened = [];
  const board = { nodes: [node], edges: [], notes: [], changes: [], tasks: [{ id: 't', nodeId: 'n', title: '任务', status: 'todo', artifacts: [artifact], primaryArtifactPath: artifact.path }], todos: [], decisions: [{ id: 'decision-1', nodeId: 'n', question: '下一步？', status: 'open' }] };
  const props = { board, node, workspacePath: '/workspace', tab: 'artifacts', runCommand() {}, executionFor() {}, threadUi: { selectedFor() {} }, onOpenArtifact: row => opened.push(row) };
  const f = fixture('PbNodeInspector', props);
  assert.match(text(f.tree), /当前采用/);
  find(f.tree, row => row.props['data-artifact-path'] === artifact.path).props.onClick(event());
  assert.equal(opened[0].path, artifact.path);
  f.render({ ...props, tab: 'history' });
  assert.equal(text(find(f.tree, row => row.props['data-decision-id'] === 'decision-1')), '下一步？待决策');
});

// 调用真实服务端三方校验；组件测试同时验证发送的草稿起点与服务端接受/拒绝结果。
const validateBase = (board, action, input) => BoardService.prototype.checkFieldBase.call(null, board, action, input);

test('交付编辑期间SSE多次更新同字段，base保持编辑起点，真实三方校验拒绝覆盖并保留草稿', async () => {
  let current = { id: 'a', acceptance: '原标准', delivery: { summary: '原结论', review: 'none' } };
  const calls = [], runCommand = async (action, input) => { calls.push(plain(input)); validateBase({ tasks: [current] }, action, input); return { board: { tasks: [current] } }; };
  const f = deliveryFixture(current, runCommand); f.change('交付结论', '本地长草稿');
  for (const summary of ['盘上新结论一', '盘上新结论二']) {
    current = { ...current, acceptance: '远端更新了其他字段', delivery: { ...current.delivery, summary } };
    f.render({ item: current, targetType: 'task', runCommand }); await f.submit();
    assert.equal(calls.at(-1).base.delivery.summary, '原结论');
    assert.equal(field(f.render(), '交付结论').props.value, '本地长草稿');
    assert.match(text(find(f.tree, row => row.props.role === 'alert')), /版本冲突.*草稿已保留/);
    assert.equal(current.delivery.summary, summary);
  }
});

test('SSE只更新其他字段时编辑可合并，未编辑字段采用新base且不会一并写回', async () => {
  let current = { id: 'a', acceptance: '原标准', delivery: { summary: '原结论', review: 'none' } };
  const calls = [], runCommand = async (action, input) => {
    calls.push(plain(input)); validateBase({ tasks: [current] }, action, input);
    const patch = input.task; current = { ...current, ...patch, delivery: { ...current.delivery, ...patch.delivery } };
    return { board: { tasks: [current] } };
  };
  const f = deliveryFixture(current, runCommand); f.change('交付结论', '本地新结论');
  current = { ...current, acceptance: '远端新标准', delivery: { ...current.delivery, review: 'pending' } };
  f.render({ item: current, targetType: 'task', runCommand }); await f.submit();
  assert.deepEqual(calls[0], { task: { id: 'a', delivery: { summary: '本地新结论' } }, base: { delivery: { summary: '原结论' } } });
  assert.equal(current.acceptance, '远端新标准'); assert.equal(current.delivery.review, 'pending'); assert.equal(current.delivery.summary, '本地新结论');
  assert.equal(nodes(f.render()).some(row => row.props.role === 'alert'), false);
  f.change('验收标准', '新的显式标准'); await f.submit();
  assert.deepEqual(calls[1], { task: { id: 'a', acceptance: '新的显式标准' }, base: { acceptance: '远端新标准' } });
});

test('保存期间继续编辑同字段，下一次base使用本次实际提交结果，不越过更晚SSE修改', async () => {
  let resolve; const calls = [];
  const runCommand = async (action, input) => {
    calls.push(plain(input));
    if (calls.length === 1) return new Promise(done => { resolve = done; });
    validateBase({ tasks: [{ id: 'a', delivery: { summary: '更晚远端更新' } }] }, action, input);
    return { board: {} };
  };
  const f = deliveryFixture({ id: 'a', delivery: { summary: '旧结论' } }, runCommand);
  f.change('交付结论', '第一版'); const saving = f.submit(); f.change('交付结论', '继续输入的第二版');
  f.render({ item: { id: 'a', delivery: { summary: '更晚远端更新' } }, targetType: 'task', runCommand });
  resolve({ board: { tasks: [{ id: 'a', delivery: { summary: '更晚远端更新' } }] }, committedBoard: { tasks: [{ id: 'a', delivery: { summary: '第一版' } }] } }); await saving; f.render(); await f.submit();
  assert.deepEqual(calls[1].base, { delivery: { summary: '第一版' } });
  assert.equal(field(f.render(), '交付结论').props.value, '继续输入的第二版');
  assert.match(text(f.tree), /版本冲突/);
});

test('保存期间新编辑的其他字段保留自己的起点，保存成功不会把它悄悄重设为远端值', async () => {
  let resolve; const calls = [];
  const runCommand = async (action, input) => {
    calls.push(plain(input));
    if (calls.length === 1) return new Promise(done => { resolve = done; });
    validateBase({ tasks: [{ id: 'a', acceptance: '远端标准', delivery: { summary: '已提交结论' } }] }, action, input);
    return { board: {} };
  };
  const f = deliveryFixture({ id: 'a', acceptance: '原标准', delivery: { summary: '旧结论' } }, runCommand);
  f.change('交付结论', '已提交结论'); const saving = f.submit(); f.change('验收标准', '本地后续标准');
  const current = { id: 'a', acceptance: '远端标准', delivery: { summary: '已提交结论' } };
  f.render({ item: current, targetType: 'task', runCommand }); resolve({ board: { tasks: [current] } }); await saving; f.render(); await f.submit();
  assert.deepEqual(calls[1], { task: { id: 'a', acceptance: '本地后续标准' }, base: { acceptance: '原标准' } });
  assert.equal(field(f.render(), '验收标准').props.value, '本地后续标准'); assert.match(text(f.tree), /版本冲突/);
});

test('节点概览草稿在SSE同字段变化后携带原base，其他字段更新可正常合并', async () => {
  for (const sameField of [false, true]) {
    let node = { id: 'n', title: '原节点名', summary: '原概览', kind: 'figure' };
    let board = { nodes: [node], edges: [], notes: [], changes: [], tasks: [], todos: [], decisions: [] };
    const calls = [], runCommand = async (action, input) => {
      calls.push(plain(input)); validateBase(board, action, input);
      node = { ...node, ...input.node }; board = { ...board, nodes: [node] }; return { board };
    };
    const props = () => ({ board, node, runCommand, executionFor() {}, threadUi: { selectedFor() {} } });
    const f = fixture('PbNodeInspector', props());
    find(f.tree, row => row.props['aria-label'] === '概览').props.onChange({ target: { value: '本地概览草稿' } }); f.render();
    node = { ...node, title: '远端新节点名', ...(sameField ? { summary: '远端新概览' } : {}) }; board = { ...board, nodes: [node] };
    f.render(props()); await find(f.tree, row => row.type === 'form' && row.props.className === 'pb-sec pb-overview-editor').props.onSubmit(event()); f.render();
    assert.deepEqual(calls[0], { node: { id: 'n', summary: '本地概览草稿' }, base: { summary: '原概览' } });
    assert.equal(node.title, '远端新节点名');
    assert.equal(find(f.tree, row => row.props['aria-label'] === '概览').props.value, '本地概览草稿');
    if (sameField) { assert.equal(node.summary, '远端新概览'); assert.match(text(f.tree), /版本冲突.*草稿已保留/); }
    else { assert.equal(node.summary, '本地概览草稿'); assert.equal(nodes(f.tree).some(row => row.props.role === 'alert'), false); }
  }
});
