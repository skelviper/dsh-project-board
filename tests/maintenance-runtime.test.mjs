// 真实插件路由/工具注册与通知调用链；会话和LLM仅内存替身，磁盘限临时项目。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function fixture(t, { nested = false, flushResults = [true] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-maintenance-runtime-'));
  t.after(async () => { assert.match(path.basename(dir), /^pb-maintenance-runtime-/); await fs.rm(dir, { recursive: true, force: true }); });
  const plugin = path.join(dir, 'plugin');
  for (const [name, code] of [
    ['dsh-tools', 'export const defineTool = value => value;'],
    ['dsh-llm', 'let id=0; export const createUserMessage = value => ({...value, role:"user", id:"fixture-message-"+(++id)});'],
  ]) {
    const pkg = path.join(plugin, 'node_modules', '@deepseek-ai', name); await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    await fs.writeFile(path.join(pkg, 'index.js'), code);
  }
  await fs.copyFile(new URL('../host.mjs', import.meta.url), path.join(plugin, 'host.mjs'));
  const a = path.join(dir, 'A'), b = nested ? path.join(a, 'nested') : path.join(dir, 'B');
  await fs.mkdir(a); await fs.mkdir(b);
  const routes = new Map(), tools = new Map(), events = [], messages = [], counts = { resolves: 0, flushes: 0 };
  let cwd = a;
  const session = { header: { get cwd() { return cwd; } } };
  const agent = { id: 'bound-lead', session, inbox: { nextTurn: [], nextStep: [] }, followup(message) { messages.push(message); events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }); } };
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    workspaceRegistry: { list: () => [{ id: 'a', path: a, title: 'A' }, { id: 'b', path: b, title: 'B' }] },
    agents: { list: () => [] }, agentTeams: { tryMembership: () => null }, jobs: { list: () => [] },
    sessionController: {
      inspect: async () => ({ meta: { cwd }, inheritedEventCount: 0, events: structuredClone(events) }),
      resolveAgent: async () => { ++counts.resolves; return { agent }; },
    },
    sessions: { flush: async () => { const result = flushResults[Math.min(counts.flushes, flushResults.length - 1)]; ++counts.flushes; return result; } },
    effect: fn => fn(), on: () => () => {},
  };
  await (await import(pathToFileURL(path.join(plugin, 'host.mjs')).href)).apply(ctx);
  const post = (route, body) => routes.get(route)(new Request('http://localhost' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const command = (action, input) => post('/api/project-board/command', { workspacePath: a, action, input });
  assert.equal((await command('create_board', {})).status, 200);
  assert.equal((await command('bind_assistant', { sessionId: 'bound-lead' })).status, 200);
  return { a, b, routes, tools, counts, messages, post, setCwd: value => { cwd = value; } };
}

test('真实宿主注册维护路由与工具，flush失败后的同ID重试只补持久化而不再次enqueue', async t => {
  const f = await fixture(t, { flushResults: [false, true] });
  assert.equal(f.routes.size, 8); assert.equal(f.tools.size, 4);
  const body = { workspacePath: f.a, operation: 'notify', commandId: 'notify-once', message: 'A new report' };
  const first = await f.post('/api/project-board/maintenance', body);
  assert.equal(first.status, 503); assert.equal((await first.json()).error.code, 'WAKE_PERSISTENCE');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].source.kind, 'project-board-maintenance');
  assert.deepEqual(f.messages[0].source.requestIds, ['notify-once']);
  const second = await f.post('/api/project-board/maintenance', body);
  assert.equal(second.status, 200); assert.equal(f.messages.length, 1); assert.equal(f.counts.flushes, 2);
  const third = await f.post('/api/project-board/maintenance', body);
  assert.equal(third.status, 200); assert.equal(f.messages.length, 1); assert.equal(f.counts.flushes, 2);
});

test('部分已投递ID与新通知合批时，只去重已有ID，新附言仍被实际投递', async t => {
  const f = await fixture(t, { flushResults: [false, true] });
  const a = { workspacePath: f.a, operation: 'notify', commandId: 'notice-a', message: 'Report A' };
  assert.equal((await f.post('/api/project-board/maintenance', a)).status, 503);
  // 有界的文档发现让两个请求处于同一扫描批次，而不是依赖模型或计时器。
  await fs.mkdir(path.join(f.a, 'docs'));
  for (let i = 0; i < 30; ++i) await fs.writeFile(path.join(f.a, 'docs', `note-${i}.md`), `# Note ${i}\n\nTemporary metadata.\n`);
  assert.equal((await f.post('/api/project-board/maintenance', {workspacePath:f.a,operation:'configure',roots:['docs']})).status, 200);
  const b = { workspacePath: f.a, operation: 'notify', commandId: 'notice-b', message: 'Unique report B' };
  const replies = await Promise.all([f.post('/api/project-board/maintenance', a), f.post('/api/project-board/maintenance', b)]);
  const values = await Promise.all(replies.map(async r => { assert.equal(r.status, 200); return r.json(); }));
  assert.ok(values.some(v => v.coalesced), '请求合批才覆盖部分ID已投递情境');
  assert.equal(f.messages.length, 2);
  assert.deepEqual(f.messages[1].source.requestIds, ['notice-b']);
  assert.match(f.messages[1].content[0].text, /Unique report B/);
});

test('独立嵌套workspace的助手绑定在冷恢复前拒绝，不能以前缀误唤醒别的项目', async t => {
  const f = await fixture(t, { nested: true }); f.setCwd(f.b);
  const response = await f.post('/api/project-board/maintenance', { workspacePath: f.a, operation: 'notify', commandId: 'wrong-owner' });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'ASSISTANT_WORKSPACE_MISMATCH');
  assert.equal(f.counts.resolves, 0); assert.equal(f.messages.length, 0);
});

test('维护工具限当前会话所属workspace，跨项目通知在进入维护前拒绝', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tools.get('project_board_maintain').execute({ workspacePath: f.b, operation: 'notify' }, { agent: { id: 'caller', session: { header: { cwd: f.a } } } }), { code: 'MAINTENANCE_WORKSPACE_MISMATCH' });
  assert.equal(f.counts.resolves, 0); assert.equal(f.messages.length, 0);
});
