// 独立临时目录中的跨项目集成；不访问用户看板或真实会话。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-board-portable-'));
  t.after(async () => {
    assert.ok(path.basename(dir).startsWith('dsh-board-portable-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const plugin = path.join(dir, '插件 with spaces');
  await fs.mkdir(path.join(plugin, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true });
  await fs.copyFile(new URL('host.mjs', root), path.join(plugin, 'host.mjs'));
  await fs.writeFile(path.join(plugin, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
  // 只模拟DSH工具注册外壳；HTTP、工具处理器和磁盘存储均使用真实插件代码。
  await fs.writeFile(path.join(plugin, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'), 'export const defineTool = definition => definition;');
  const workspaces = ['App A', '文档 B'].map((title, index) => ({ id: String(index), title, path: path.join(dir, title) }));
  for (const ws of workspaces) await fs.mkdir(ws.path);
  const routes = new Map(), tools = new Map();
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    workspaceRegistry: { list: () => workspaces },
    agents: { list: () => [] },
    agentTeams: { tryMembership: () => null },
    effect: (callback) => callback(),
    on: () => () => {},
  };
  await (await import(pathToFileURL(path.join(plugin, 'host.mjs')).href)).apply(ctx);
  const agent = { id: 'agent-a', session: { header: { cwd: path.join(workspaces[0].path, 'src') } } };
  const call = (name, args) => tools.get(name).execute(args, { agent });
  for (const ws of workspaces) await call('project_board_update', { workspacePath: ws.path, action: 'create_board', input: { title: ws.title } });
  return { dir, workspaces, routes, call };
}

test('independent projects isolate identical node IDs and command IDs, including explicit digest reads', async (t) => {
  const { workspaces: [a, b], call } = await fixture(t);
  for (const [ws, kind] of [[a, 'component'], [b, 'document']]) {
    await call('project_board_update', { workspacePath: ws.path, commandId: 'same-command', action: 'upsert_node', input: { node: { id: 'same-node', title: ws.title + ' private node', kind } } });
  }
  const bDigest = await call('project_board_get', { workspacePath: b.path, view: 'digest' });
  assert.equal(bDigest.workspacePath, b.path);
  assert.match(bDigest.digest, /文档 B private node/);
  assert.doesNotMatch(bDigest.digest, /App A private node/);
  const aDigest = await call('project_board_get', { view: 'digest' });
  assert.match(aDigest.digest, /App A private node/);
  assert.doesNotMatch(aDigest.digest, /文档 B private node/);
  for (const ws of [a, b]) {
    const { board } = await call('project_board_get', { workspacePath: ws.path, view: 'board' });
    assert.equal(board.nodes.length, 1);
    assert.equal(board.nodes[0].title, ws.title + ' private node');
    assert.equal(board.workspacePath, ws.path);
  }
  await call('project_board_update', { workspacePath: a.path, action: 'upsert_node', input: { node: { id: 'release', kind: 'milestone', title: 'Ship release' } } });
  assert.equal((await call('project_board_get', { workspacePath: a.path, view: 'board' })).board.nodes[1].kind, 'milestone');
});

test('artifact routes reject parent-directory symlink escapes and unregistered workspaces', async (t) => {
  const { dir, workspaces: [a], routes } = await fixture(t);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside sentinel');
  await fs.symlink(outside, path.join(a.path, 'linked'), 'dir');
  await fs.writeFile(path.join(a.path, 'allowed.txt'), 'inside sentinel');
  const request = async (workspacePath, relative) => routes.get('/api/project-board/artifact')(new Request('http://localhost/api/project-board/artifact?' + new URLSearchParams({ workspacePath, path: relative })));
  const blocked = await request(a.path, 'linked/secret.txt');
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'PATH_OUTSIDE_WORKSPACE');
  const allowed = await request(a.path, 'allowed.txt');
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'inside sentinel');
  assert.equal((await request(outside, 'secret.txt')).status, 404);
});

test('build scripts work in paths with spaces and Unicode and produce reproducible release entries', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-board-portable-'));
  t.after(async () => {
    assert.ok(path.basename(dir).startsWith('dsh-board-portable-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const target = path.join(dir, '源码 with spaces');
  await fs.mkdir(target);
  for (const name of ['package.json', 'build-host.mjs', 'build-client.mjs', 'schema.mjs', 'store.mjs', 'service.mjs', 'thread.mjs', 'index.mjs']) await fs.copyFile(new URL(name, root), path.join(target, name));
  await fs.cp(new URL('client-src/', root), path.join(target, 'client-src'), { recursive: true });
  for (const name of ['build-host.mjs', 'build-client.mjs']) {
    const result = spawnSync(process.execPath, [path.join(target, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const name of ['entry.mjs', 'host.mjs', 'client.js']) assert.equal(await fs.readFile(path.join(target, name), 'utf8'), await fs.readFile(new URL(name, root), 'utf8'));
});
