import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../board-model.js', import.meta.url), 'utf8').replace(/^export /gm, '') + '\n' + ['state.js', 'inspector.js'].map(name => fs.readFileSync(new URL('../client-src/' + name, import.meta.url), 'utf8')).join('\n');
function fixture(onSubmit = async () => null) {
  const slots = []; let cursor = 0;
  const context = { React: {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: value => { const at = cursor++; if (!(at in slots)) slots[at] = value; return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }]; },
    useRef: value => { const at = cursor++; if (!(at in slots)) slots[at] = { current: value }; return slots[at]; },
  } };
  vm.createContext(context); vm.runInContext(source + '\nglobalThis.api = { PbQuickAdd, pbNodeProgress, pbIsSubmitKey };', context);
  const render = () => { cursor = 0; return context.api.PbQuickAdd({ placeholder: '新增任务', onSubmit }); };
  return { api: context.api, render, input: () => render().children[0].children[0], button: () => render().children[0].children[1], submit: () => render().props.onSubmit({ preventDefault() {} }) };
}

test('混合任务按末级条目计数，不漏掉无待办任务', () => {
  const { api } = fixture();
  const board = { nodes: [{ id: 'n' }], tasks: [{ id: 't1', nodeId: 'n', status: 'doing' }, { id: 't2', nodeId: 'n', status: 'todo' }], todos: [{ taskId: 't1', status: 'done' }] };
  const progress = api.pbNodeProgress(board, 'n');
  assert.deepEqual([progress.done, progress.total, progress.closed, progress.pct], [1, 2, 1, 50]);
  assert.equal(api.pbNodeProgress(board, 'empty'), null);
  board.todos = [];
  board.tasks[0].status = 'dropped';
  assert.equal(api.pbNodeProgress(board, 'n').total, 2);
  assert.equal(api.pbNodeProgress(board, 'n').done, 0);
  assert.equal(api.pbNodeProgress(board, 'n').closed, 1);
});

test('中文组合输入、兼容键码与长按回车均不提交', () => {
  const { api, input } = fixture();
  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    let prevented = false;
    const event = { key: 'Enter', nativeEvent, preventDefault() { prevented = true; } };
    assert.equal(api.pbIsSubmitKey(event), false);
    input().props.onKeyDown(event); assert.equal(prevented, true);
  }
  assert.equal(api.pbIsSubmitKey({ key: 'Enter', nativeEvent: {} }), true);
  assert.equal(api.pbIsSubmitKey({ key: 'Escape' }), false);
});

test('失败保留原草稿，并可再次提交', async () => {
  let calls = 0;
  const form = fixture(async title => { calls++; assert.equal(title, '任务甲'); return calls === 1 ? null : { board: {} }; });
  form.input().props.onChange({ target: { value: ' 任务甲 ' } });
  await form.submit(); assert.equal(form.input().props.value, ' 任务甲 ');
  await form.submit(); assert.equal(form.input().props.value, ''); assert.equal(calls, 2);
});

test('在途提交去重，并保留提交后继续输入的新内容', async () => {
  let resolve; let calls = 0;
  const form = fixture(() => { calls++; return new Promise(done => { resolve = done; }); });
  form.input().props.onChange({ target: { value: '任务甲' } });
  const first = form.submit(); await form.submit();
  assert.equal(calls, 1); assert.equal(form.button().props.disabled, true);
  form.input().props.onChange({ target: { value: '任务乙' } });
  resolve({ board: {} }); await first;
  assert.equal(form.input().props.value, '任务乙'); assert.equal(form.button().props.disabled, false);
});

test('异常给出可读错误，草稿仍可重试', async () => {
  const form = fixture(async () => { throw new Error('网络错误'); });
  form.input().props.onChange({ target: { value: '任务甲' } });
  await form.submit();
  assert.equal(form.render().children[1].props.role, 'alert');
  assert.equal(form.render().children[1].children[0], '网络错误');
  assert.equal(form.input().props.value, '任务甲'); assert.equal(form.button().props.disabled, false);
});
