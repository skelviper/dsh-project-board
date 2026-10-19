// 发布边界回归：仅使用临时项目、模拟DSH服务和实际生成宿主，不读真实看板。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transcriptFromSnapshot } from '../thread.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-release-boundary-'));
  t.after(async () => {
    assert.match(path.basename(dir), /^pb-release-boundary-/);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const plugin = path.join(dir, 'plugin');
  for (const [name, code] of [
    ['dsh-tools', 'export const defineTool = value => value;'],
    ['dsh-llm', 'let id=0; export const createUserMessage = value => ({...value, role:"user", id:"fixture-message-"+(++id)});'],
  ]) {
    const pkg = path.join(plugin, 'node_modules', '@deepseek-ai', name);
    await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    await fs.writeFile(path.join(pkg, 'index.js'), code);
  }
  await fs.copyFile(new URL('../host.mjs', import.meta.url), path.join(plugin, 'host.mjs'));
  const a = path.join(dir, 'A'), b = path.join(dir, 'B');
  for (const root of [a, b]) {
    await fs.mkdir(path.join(root, 'results'), { recursive: true });
    await fs.writeFile(path.join(root, 'results', 'report.md'), '# Synthetic report\n');
  }
  let policy = { mode: 'workspace-write', workspaceRoot: a }, history = [];
  const routes = new Map(), tools = new Map(), hooks = new Map(), warnings = [];
  const calls = { policy: 0 };
  const agent = { id: 'caller', session: { header: { cwd: a }, deriveMessages: () => history } };
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    workspaceRegistry: { list: () => [{ id: 'a', path: a, title: 'A' }, { id: 'b', path: b, title: 'B' }] },
    agents: { list: () => [] }, agentTeams: { tryMembership: () => null }, jobs: { list: () => [] },
    sandboxPolicy: { resolve(request) { assert.equal(request.session, agent.session); ++calls.policy; return policy; } },
    logger: { warn: value => warnings.push(value) },
    effect: callback => callback(), on(event, callback) { hooks.set(event, callback); return () => {}; },
  };
  await (await import(pathToFileURL(path.join(plugin, 'host.mjs')).href)).apply(ctx);
  const command = async (root, action, input) => {
    const response = await routes.get('/api/project-board/command')(new Request('http://localhost/api/project-board/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspacePath: root, action, input }),
    }));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  for (const root of [a, b]) {
    await command(root, 'create_board', {});
    await command(root, 'upsert_node', { node: { id: 'n', kind: 'component', title: 'Synthetic work', status: 'done', ownedPaths: ['results/report.md'] } });
  }
  const call = (name, args) => tools.get(name).execute(args, { agent });
  const boardPath = root => path.join(root, 'board', 'project-board.json');
  return { dir, a, b, ctx, agent, hooks, warnings, calls, command, call, boardPath,
    setPolicy: value => { policy = value; }, setHistory: value => { history = value; } };
}

async function unchanged(root, f, callback, code) {
  const file = f.boardPath(root), before = await fs.readFile(file, 'utf8');
  await assert.rejects(callback, { code });
  assert.equal(await fs.readFile(file, 'utf8'), before, '拒绝前不能提交看板或删除标记');
  assert.equal(await fs.readFile(path.join(root, 'results', 'report.md'), 'utf8'), '# Synthetic report\n');
}

test('actual update tool cannot archive a different registered workspace, even in full-access mode', async t => {
  const f = await fixture(t); f.setPolicy({ mode: 'danger-full-access', workspaceRoot: f.a });
  for (const action of ['delete_node', 'delete_task', 'delete_todo', 'undo_change']) {
    await unchanged(f.b, f, () => f.call('project_board_update', { workspacePath: f.b, action, input: { id: 'n' } }), 'ARCHIVE_WORKSPACE_MISMATCH');
  }
});

test('actual archive-capable tool entries fail closed for read-only or missing standing policy', async t => {
  const f = await fixture(t); f.setPolicy({ mode: 'read-only', workspaceRoot: f.a });
  await unchanged(f.a, f, () => f.call('project_board_update', { action: 'delete_node', input: { id: 'n' } }), 'ARCHIVE_WRITE_DENIED');
  for (const args of [{}, { operation: 'scan' }, { operation: 'notify' }, { operation: 'resolve', choice: 'retry_archive' }]) {
    await unchanged(f.a, f, () => f.call('project_board_maintain', args), 'ARCHIVE_WRITE_DENIED');
  }
  f.ctx.sandboxPolicy = undefined;
  await unchanged(f.a, f, () => f.call('project_board_update', { action: 'delete_node', input: { id: 'n' } }), 'ARCHIVE_WRITE_DENIED');
  assert.ok(f.calls.policy >= 5);
});

test('workspace-write uses the original session boundary and permitted same-project archive still works', async t => {
  const f = await fixture(t), narrow = path.join(f.a, 'narrow');
  await fs.mkdir(narrow); f.agent.session.header.cwd = narrow;
  f.setPolicy({ mode: 'workspace-write', workspaceRoot: narrow });
  await unchanged(f.a, f, () => f.call('project_board_update', { action: 'delete_node', input: { id: 'n' } }), 'ARCHIVE_WRITE_DENIED');
  f.agent.session.header.cwd = f.a; f.setPolicy({ mode: 'workspace-write', workspaceRoot: f.a });
  const result = await f.call('project_board_update', { action: 'delete_node', input: { id: 'n' } });
  assert.equal(result.board.nodes.length, 0);
  assert.equal(result.board.maintenance.deletions[0].status, 'archived');
  await assert.rejects(fs.stat(path.join(f.a, 'results', 'report.md')), { code: 'ENOENT' });
});

test('real context reader preserves the previous association on corrupt JSON and clears only on missing board', async t => {
  const f = await fixture(t);
  await f.command(f.a, 'upsert_task', { task: { id: 't', nodeId: 'n', title: 'Linked task', threads: [{ sessionId: 'caller' }] } });
  const hook = f.hooks.get('agent/pre-step'), signal = new AbortController().signal;
  const prompt = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue current work' }] };
  const first = await hook({ agent: f.agent, messages: [prompt], step: 1, signal }, async () => ({ kind: 'enter', messages: [prompt] }));
  assert.equal(first.messages[1].source.update, 'full');
  f.setHistory(first.messages);
  const board = f.boardPath(f.a);
  await fs.writeFile(board, '{');
  const later = new Date(Date.now() + 2000); await fs.utimes(board, later, later);
  const next = { kind: 'enter', messages: [prompt] };
  const failedRead = await hook({ agent: f.agent, messages: [prompt], step: 2, signal }, async () => next);
  assert.equal(failedRead, next);
  assert.equal(failedRead.messages.length, 1);
  assert.equal(f.warnings.length, 1);
  assert.equal(path.relative(f.dir, board), path.join('A', 'board', 'project-board.json'));
  await fs.unlink(board);
  const missing = await hook({ agent: f.agent, messages: [prompt], step: 3, signal }, async () => next);
  assert.equal(missing.messages[1].source.update, 'clear');
});

test('task context cannot re-admit offered input removed by downstream pre-step middleware', async t => {
  const f = await fixture(t);
  await f.command(f.a, 'upsert_task', { task: { id: 't', nodeId: 'n', title: 'Linked task', threads: [{ sessionId: 'caller' }] } });
  const prompt = { role: 'user', content: [{ type: 'text', text: 'Offered input' }] };
  const excluded = { kind: 'enter', messages: [] };
  const result = await f.hooks.get('agent/pre-step')({ agent: f.agent, messages: [prompt], step: 2, signal: new AbortController().signal }, async () => excluded);
  assert.equal(result, excluded); assert.equal(result.messages.length, 0);
});

test('compact transcripts distinguish maintenance notices from real user input and omit task background', () => {
  const result = transcriptFromSnapshot({ session: { id: 'synthetic' }, events: [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Real request' }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'project-board-maintenance' }, content: [{ type: 'text', text: 'Machine maintenance notice' }] } },
    { seq: 3, type: 'user/message', data: { source: { kind: 'project-board-task-context' }, content: [{ type: 'text', text: 'Synthetic task context' }] } },
  ] });
  assert.deepEqual(result.entries.map(row => row.kind), ['user', 'note']);
  assert.equal(result.entries[1].sourceKind, 'project-board-maintenance');
});
