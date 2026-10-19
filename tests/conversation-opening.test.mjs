import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await Promise.all(['state.js', 'explorer.js', 'inspector.js', 'conversations.js'].map(name => fs.readFile(new URL('../client-src/' + name, import.meta.url), 'utf8')))).join('\n');
function harness(component, props) {
  const cells = []; let index = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: () => ({ Provider: 'provider' }),
    useState(initial) { const at = index++; cells[at] ||= { value: typeof initial === 'function' ? initial() : initial }; return [cells[at].value, value => { cells[at].value = typeof value === 'function' ? value(cells[at].value) : value; }]; },
    useRef(initial) { return cells[index++] ||= { current: initial }; },
    useCallback: callback => callback, useMemo: factory => factory(), useEffect() {}, useLayoutEffect() {},
  };
  const api = vm.runInNewContext(source + '\n({ PbConversationMenu, PbConversationDrawer, pbConversationThreads, pbThreadsOf });', {
    React, createPortal: node => node, document: { body: {} },
    PbIcon: function PbIcon() {}, PbQuickAdd: function PbQuickAdd() {},
    pbTaskConversationContext: () => 'todo context', pbTaskConversationDraft: context => context,
  });
  return { api, render(next = props) { index = 0; return api[component](next); } };
}
function all(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(all) : [tree, ...all(tree.props?.children)]; }
const css = (tree, name) => all(tree).find(row => row.props?.className?.split(' ').includes(name));
const text = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : '';
const thread = sessionId => ({ sessionId });
function menu(own, inherited = []) {
  const calls = [];
  const props = { item: { id: 'todo', threads: own }, parentTask: { id: 'task', threads: inherited }, targetType: 'todo', selectedSessionId: own.at(-1)?.sessionId || inherited.at(-1)?.sessionId, compact: true,
    onSelect: id => calls.push(['select', id]), onCreate: () => calls.push(['create']), onRemove: id => calls.push(['remove', id]),
  };
  return { ...harness('PbConversationMenu', props), props, calls };
}

test('只有一个已有会话时主按钮直接打开，绝不新建或展示创建菜单', async () => {
  const f = menu([thread('existing')]);
  await css(f.render(), 'pb-conversation-trigger').props.onClick({});
  assert.deepEqual(f.calls, [['select', 'existing']]);
  assert.equal(css(f.render(), 'pb-thread-menu'), undefined);
});

test('空待办打开所属任务原 ID；管理菜单标明来源且不允许移除父关联', async () => {
  const f = menu([], [thread('parent-session')]);
  const binding = f.api.pbConversationThreads(f.props.item, f.props.parentTask);
  assert.equal(binding.inherited, true);
  assert.equal(f.api.pbThreadsOf(f.props.item).length, 0);
  await css(f.render(), 'pb-conversation-trigger').props.onClick({});
  assert.deepEqual(f.calls, [['select', 'parent-session']]);
  css(f.render(), 'pb-conversation-options').props.onClick({ currentTarget: {} });
  const tree = f.render();
  assert.match(text(css(tree, 'pb-thread-menu-heading')), /来自所属任务/);
  assert.equal(css(tree, 'pb-thread-menu-remove'), undefined);
  assert.equal(css(tree, 'pb-thread-menu-choice').props['data-session-id'], 'parent-session');
});

test('自身绑定优先于所属任务；同 ID 仍属于自身关联，旧单线程格式兼容', () => {
  const f = menu([thread('same')], [thread('same'), thread('other')]);
  const own = f.api.pbConversationThreads(f.props.item, f.props.parentTask);
  assert.equal(own.inherited, false);
  assert.deepEqual(Array.from(own.threads, row => row.sessionId), ['same']);
  css(f.render(), 'pb-conversation-options').props.onClick({ currentTarget: {} });
  assert.ok(css(f.render(), 'pb-thread-menu-remove'));
  assert.equal(f.api.pbConversationThreads({ thread: thread('legacy') }, f.props.parentTask).threads[0].sessionId, 'legacy');
  assert.equal(f.api.pbConversationThreads({ threads: [] }, f.props.parentTask).inherited, true);
});

test('多个已有会话先供选择，只有点击具体记录才打开该 ID', async () => {
  const f = menu([thread('a'), thread('b')]);
  css(f.render(), 'pb-conversation-trigger').props.onClick({ currentTarget: {} });
  assert.deepEqual(f.calls, []);
  const choices = all(f.render()).filter(row => row.props?.className === 'pb-thread-menu-choice');
  assert.equal(choices.length, 2);
  await choices[0].props.onClick();
  assert.deepEqual(f.calls, [['select', 'a']]);
});

test('没有任何关联时只展示空状态，必须明确点击新建才创建', async () => {
  const f = menu([]);
  css(f.render(), 'pb-conversation-trigger').props.onClick({ currentTarget: {} });
  assert.deepEqual(f.calls, []);
  assert.match(text(css(f.render(), 'pb-thread-menu-empty')), /还没有会话/);
  await css(f.render(), 'pb-thread-menu-create').props.onClick();
  assert.deepEqual(f.calls, [['create']]);
});

test('已有会话打开失败时展示错误，保持原 ID 且不回退到新建', async () => {
  const f = menu([thread('existing')]);
  f.props.onSelect = () => { throw new Error('session missing'); };
  await css(f.render(), 'pb-conversation-trigger').props.onClick({});
  assert.match(text(css(f.render(), 'pb-thread-menu-error')), /session missing/);
  assert.equal(css(f.render(), 'pb-thread-menu-choice').props['data-session-id'], 'existing');
  assert.deepEqual(f.calls, []);
});

test('继承抽屉保留同一原生 Session，不向共享草稿插入待办背景', () => {
  const props = { board: { notes: [] }, workspacePath: '/workspace', item: { id: 'todo', title: 'Todo', status: 'done', threads: [] }, task: { id: 'task', title: 'Task', threads: [thread('parent-session')] }, targetType: 'todo', sessionId: 'parent-session' };
  const f = harness('PbConversationDrawer', props);
  const tree = f.render();
  const embedded = all(tree).find(row => row.type?.name === 'PbEmbeddedConversation');
  assert.equal(embedded.props.sessionId, 'parent-session');
  assert.equal(embedded.props.initialPrompt, undefined);
  const picker = all(tree).find(row => row.type?.name === 'PbConversationMenu');
  assert.equal(picker.props.parentTask, props.task);
  assert.equal(picker.props.selectedSessionId, 'parent-session');
  assert.match(text(tree), /所属任务会话/);
});
