import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../client-src/entry.js', import.meta.url), 'utf8');
const CHAT = 'conversation.view';
const TEXT = 'conversation.user.text.node';
function nativeEntry(field, value, registrant) {
  return {
    component: function NativeComponent() { throw new Error('适配器不能直接执行原组件的 hooks'); },
    options: { [field]: value, priority: 100, order: 2 },
    children: { 'native.child': { kind: 'single', scope: 'session' } },
    store: { native: true }, inject: () => ({ native: true }), locale: 'native.locale', registrant,
  };
}
function fixture(initial = {}) {
  let currentContext = null;
  const contextKey = {};
  const warnings = [];
  const registry = new Map(Object.entries(initial));
  const subscribers = new Map();
  const effects = [];
  const api = vm.runInNewContext(`(function () { ${source.replace('return pbClientEntry;', 'return { pbInstallNativeFilePreview };')} })()`, {
    React: { useContext(key) { assert.equal(key, contextKey); return currentContext; } },
    PbFilePreviewContext: contextKey,
    h: (type, props) => ({ type, props }),
    console: { warn: (...args) => warnings.push(args) },
  });
  const ctx = {
    effect(setup) { const dispose = setup(); effects.push(dispose); return dispose; },
    slots: {
      entries: key => registry.get(key) || [],
      subscribe(key, callback) {
        if (!subscribers.has(key)) subscribers.set(key, new Set());
        subscribers.get(key).add(callback);
        return () => subscribers.get(key).delete(callback);
      },
      register() { throw new Error('适配器不得重新声明原生子槽'); },
      entriesOfSlot() { throw new Error('应使用完整 entries 跟踪原生注册'); },
    },
  };
  return {
    install: () => api.pbInstallNativeFilePreview(ctx),
    render(entry, props, openFile = null) { currentContext = openFile; return entry.component(props); },
    publish(key, entries) { registry.set(key, entries); for (const callback of subscribers.get(key) || []) callback(); },
    subscriberCount: () => [...subscribers.values()].reduce((sum, callbacks) => sum + callbacks.size, 0),
    warnings,
  };
}

test('保留原生 entry 身份、store、注入和子槽渲染权限，仅覆盖看板 openFile', async () => {
  const chat = nativeEntry('id', 'chat', '@deepseek-ai/dsh-client-ui-chat');
  const original = { ...chat };
  const f = fixture({ [CHAT]: [chat] });
  const dispose = f.install();
  const calls = [];
  const renderSlot = (name, props) => { assert(chat.children[name]); return props; };
  const props = { sessionId: 'same-session', openFile() { throw new Error('不能调用主侧栏'); }, renderSlot, useChat: () => {}, t: () => {} };
  const localOpen = async (...args) => { calls.push(args); };
  const result = f.render(chat, props, localOpen);
  assert.equal(result.type, original.component);
  assert.equal(result.props.openFile, localOpen);
  for (const key of ['sessionId', 'renderSlot', 'useChat', 't']) assert.equal(result.props[key], props[key]);
  for (const key of ['children', 'store', 'inject', 'locale', 'options', 'registrant']) assert.equal(chat[key], original[key]);
  const options = { line: 73 };
  await result.props.openFile('report.md', options);
  assert.equal(calls[0][0], 'report.md'); assert.equal(calls[0][1], options);
  assert.equal(result.props.renderSlot('native.child', options), options);
  dispose();
  assert.equal(chat.component, original.component);
});

test('相同 session 的主会话保持原回调，看板实例各自使用自己的 Context', async () => {
  const chat = nativeEntry('id', 'chat', 'Kb');
  const f = fixture({ [CHAT]: [chat] });
  const dispose = f.install();
  const calls = [];
  const props = { sessionId: 'same-session', openFile: async path => calls.push(['native', path]) };
  const first = async path => calls.push(['board-a', path]);
  const second = async path => calls.push(['board-b', path]);
  assert.equal(f.render(chat, props).props, props);
  await f.render(chat, props, first).props.openFile('a.png');
  await f.render(chat, props, second).props.openFile('b.png');
  await f.render(chat, props).props.openFile('main.png');
  assert.deepEqual(calls, [['board-a', 'a.png'], ['board-b', 'b.png'], ['native', 'main.png']]);
  dispose();
});

test('压缩构建同为 Kb registrant 时按槽语义匹配，其他 id/key 保持原样', () => {
  const file = nativeEntry('key', 'file', 'Kb');
  const folder = nativeEntry('key', 'folder', 'Kb');
  const other = nativeEntry('id', 'tools', 'Kb');
  const originalFile = file.component, originalFolder = folder.component, originalOther = other.component;
  const f = fixture({ [TEXT]: [file, folder], [CHAT]: [other] });
  const dispose = f.install();
  const localOpen = async () => {};
  const result = f.render(file, { node: { data: { path: 'file.txt' } } }, localOpen);
  assert.equal(result.type, originalFile);
  assert.equal(result.props.openFile, localOpen);
  assert.equal(folder.component, originalFolder);
  assert.equal(other.component, originalOther);
  dispose();
});

test('支持原生注册晚到、卸载和重新注册；卸载适配器后不再拦截', () => {
  const f = fixture();
  const dispose = f.install();
  const first = nativeEntry('id', 'chat', 'Kb'), originalFirst = first.component;
  f.publish(CHAT, [first]);
  const firstWrapper = first.component;
  assert.notEqual(firstWrapper, originalFirst);
  f.publish(CHAT, [first]);
  assert.equal(first.component, firstWrapper);
  f.publish(CHAT, []);
  assert.equal(first.component, originalFirst);
  const next = nativeEntry('id', 'chat', 'Kb'), originalNext = next.component;
  f.publish(CHAT, [next]);
  assert.notEqual(next.component, originalNext);
  dispose(); dispose();
  assert.equal(next.component, originalNext);
  assert.equal(f.subscriberCount(), 0);
  const later = nativeEntry('id', 'chat', 'Kb'), originalLater = later.component;
  f.publish(CHAT, [later]);
  assert.equal(later.component, originalLater);
});

test('热更交叠不叠加本插件包装器，旧 effect 清理不覆盖新包装器', () => {
  const chat = nativeEntry('id', 'chat', 'Kb'), original = chat.component;
  const f = fixture({ [CHAT]: [chat] });
  const disposeFirst = f.install();
  const firstWrapper = chat.component;
  const disposeSecond = f.install();
  const secondWrapper = chat.component;
  assert.notEqual(secondWrapper, firstWrapper);
  assert.equal(f.render(chat, {}).type, original);
  disposeFirst();
  assert.equal(chat.component, secondWrapper);
  disposeSecond();
  assert.equal(chat.component, original);
  assert.equal(f.subscriberCount(), 0);
});

test('清理时保留其他代码后写的 component；只读 entry 不触发强行修改', () => {
  const chat = nativeEntry('id', 'chat', 'Kb');
  const frozen = Object.freeze(nativeEntry('key', 'file', 'Kb'));
  const frozenOriginal = frozen.component;
  const f = fixture({ [CHAT]: [chat], [TEXT]: [frozen] });
  const dispose = f.install();
  const external = () => {};
  chat.component = external;
  f.publish(CHAT, [chat]);
  assert.equal(chat.component, external);
  dispose();
  assert.equal(chat.component, external);
  assert.equal(frozen.component, frozenOriginal);
  assert.equal(f.warnings.length, 2);
});
