import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../client-src/entry.js', import.meta.url), 'utf8');
const { pbOpenSession } = vm.runInNewContext(`(function () { ${source.replace('return pbClientEntry;', 'return { pbOpenSession };')} })()`);

test('打开完整会话等待已选 ID 加载，随后精确导航而不创建会话', async () => {
  const calls = [];
  let finish;
  const ready = new Promise((resolve) => { finish = resolve; });
  const ctx = {
    sessions: {
      retain(id) { calls.push(['retain', id]); return { sessionId: id, ready, release: () => calls.push(['release', id]) }; },
      create() { throw new Error('导航不应创建会话'); },
    },
    uiWorkspace: { openSession: (id) => calls.push(['open', id]) },
  };
  const opening = pbOpenSession(ctx, 'selected-existing-session');
  assert.deepEqual(calls, [['retain', 'selected-existing-session']]);
  finish({ session: {} });
  assert.equal(await opening, 'selected-existing-session');
  assert.deepEqual(calls, [['retain', 'selected-existing-session'], ['open', 'selected-existing-session'], ['release', 'selected-existing-session']]);
});

test('会话读取失败会抛出错误，不导航或回退到新会话', async () => {
  const calls = [];
  const ctx = {
    sessions: { retain: (id) => ({ sessionId: id, ready: Promise.reject(new Error('session missing')), release: () => calls.push('release') }) },
    uiWorkspace: { openSession: () => calls.push('open') },
  };
  await assert.rejects(() => pbOpenSession(ctx, 'missing-session'), /session missing/);
  assert.deepEqual(calls, ['release']);
  await assert.rejects(() => pbOpenSession(ctx, ''), /请选择/);
});

test('绑定会话不在首屏目录时先刷新目录，再打开原 ID', async () => {
  const calls = [];
  const snapshot = { byId: {} };
  const ctx = {
    sessions: {
      list: { getSnapshot: () => snapshot },
      refresh: async () => { calls.push('refresh'); snapshot.byId['older-bound-session'] = { id: 'older-bound-session' }; },
      retain(id) {
        assert(snapshot.byId[id]);
        calls.push(['retain', id]);
        return { sessionId: id, ready: Promise.resolve({ session: {} }), release: () => calls.push('release') };
      },
      create() { throw new Error('刷新目录不应创建会话'); },
    },
    uiWorkspace: { openSession: (id) => calls.push(['open', id]) },
  };
  assert.equal(await pbOpenSession(ctx, 'older-bound-session'), 'older-bound-session');
  assert.deepEqual(calls, ['refresh', ['retain', 'older-bound-session'], ['open', 'older-bound-session'], 'release']);
});

test('等待会话期间切换项目，释放引用但不跳转旧项目', async () => {
  const calls = []; let current = true; let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const ctx = {
    sessions: { retain: id => { calls.push('retain'); return { sessionId: id, ready, release: () => calls.push('release') }; } },
    uiWorkspace: { openSession: () => calls.push('open') },
  };
  const opening = pbOpenSession(ctx, 'old-session', () => current);
  current = false; finish({});
  await assert.rejects(opening, /项目已切换/);
  assert.deepEqual(calls, ['retain', 'release']);
  await assert.rejects(pbOpenSession(ctx, 'old-session', () => false), /项目已切换/);
  assert.deepEqual(calls, ['retain', 'release']);
});
