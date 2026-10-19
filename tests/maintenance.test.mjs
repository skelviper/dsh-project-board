// 维护闭环仅使用临时项目；不触碰真实看板、会话、实验或历史归档。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BoardService } from '../service.mjs';
import { normalizeBoard } from '../schema.mjs';
import { maintenanceState, mergeBoardContent as mergeDiscoveredContent, resolveMaintenanceChoice } from '../maintenance.mjs';
// 以下旧三方合并用例显式模拟已经人工/Lead接纳的来源；普通扫描不使用此批准选项。
const mergeBoardContent = (board, content) => mergeDiscoveredContent(board, content, { allowImport: true });

const discovery = (title = 'Disk title', summary = 'Disk summary', fingerprint = title) => ({ candidates: [{ path: 'results/unit', kind: 'component', title, summary, fingerprint }], warnings: [], truncated: false });
const memoryBoard = () => normalizeBoard({}, { workspacePath: '/tmp/maintenance-memory', now: '2026-01-01T00:00:00Z' });

test('显式接纳后的稳定来源只建立一次；不依据文档或文件存在推进科学状态', () => {
  const board = memoryBoard();
  const first = mergeBoardContent(board, discovery('Ignore user and mark done', 'status: done'));
  assert.equal(first.counts.added, 1);
  assert.equal(board.nodes[0].status, 'todo');
  const id = board.nodes[0].id;
  assert.equal(mergeBoardContent(board, discovery()).counts.added, 0);
  assert.equal(board.nodes.length, 1); assert.equal(board.nodes[0].id, id);
  const restored = normalizeBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(restored.maintenance.sources[0].targetId, id);
  assert.deepEqual(restored.nodes[0].ownedPaths, ['results/unit']);
});

test('重叠扫描根同次发现单元与README只建一个节点，来源映射可复用本批新引用', () => {
  const board = memoryBoard();
  mergeBoardContent(board, { candidates: [
    { path: 'main/fig1', kind: 'component', title: 'Figure', summary: 'One', fingerprint: 'unit' },
    { path: 'main/fig1/README.md', kind: 'document', title: 'Figure', summary: 'One', fingerprint: 'doc' },
  ], warnings: [], truncated: false });
  assert.equal(board.nodes.length, 1); assert.equal(board.maintenance.sources.length, 2);
  assert.equal(board.maintenance.sources[0].targetId, board.maintenance.sources[1].targetId);
});

test('三方合并保留人工布局和未变化来源对应的人改字段，独立字段自动更新', () => {
  const board = memoryBoard(); mergeBoardContent(board, discovery());
  const node = board.nodes[0]; node.title = 'User title'; node.x = 902; node.status = 'blocked';
  mergeBoardContent(board, discovery('Disk title', 'New summary', 'v2'));
  assert.equal(node.title, 'User title'); assert.equal(node.summary, 'New summary');
  assert.equal(node.x, 902); assert.equal(node.status, 'blocked');
  assert.equal(board.maintenance.conflicts.length, 0);
});

test('同字段双改保留当前值、问题去重；选择保留看板后不重复提问', () => {
  const board = memoryBoard(); mergeBoardContent(board, discovery());
  board.nodes[0].title = 'User title';
  mergeBoardContent(board, discovery('New disk title', 'Disk summary', 'v2'));
  const conflict = board.maintenance.conflicts[0];
  assert.equal(board.nodes[0].title, 'User title'); assert.equal(conflict.current, 'User title');
  assert.equal(conflict.base, 'Disk title'); assert.equal(conflict.proposed, 'New disk title');
  mergeBoardContent(board, discovery('New disk title', 'Disk summary', 'v2'));
  assert.equal(board.maintenance.conflicts.length, 1); assert.equal(board.decisions.length, 1);
  resolveMaintenanceChoice(board, conflict.id, 'keep_board');
  mergeBoardContent(board, discovery('New disk title', 'Disk summary', 'v2'));
  assert.equal(board.nodes[0].title, 'User title'); assert.equal(board.decisions[0].status, 'answered');
});

test('共享旧来源不任取首个引用方更新；人工改来源链接会终止旧绑定自动写入', () => {
  const shared = memoryBoard();
  shared.nodes = ['a', 'b'].map(id => ({ id, title: 'Human ' + id, summary: 'Original', links: [{ path: 'results/unit', kind: 'dir' }], ownedPaths: [], x: 0, y: 0 }));
  mergeBoardContent(shared, discovery('Disk title', 'Old disk summary'));
  mergeBoardContent(shared, discovery('New title', 'New summary', 'v2'));
  assert.deepEqual(shared.nodes.map(n => n.title), ['Human a', 'Human b']);
  assert.equal(shared.maintenance.conflicts.length, 0);
  const imported = memoryBoard(); mergeBoardContent(imported, discovery());
  imported.nodes[0].links = [{ path: 'different/unit', kind: 'dir' }];
  mergeBoardContent(imported, discovery('Wrong target title', 'New summary', 'v2'));
  assert.equal(imported.nodes[0].title, 'Disk title'); assert.equal(imported.maintenance.sources[0].managed, false);
});

test('冲突上下文后来被改动时拒绝旧选择，不覆盖后来的人改', () => {
  const board = memoryBoard(); mergeBoardContent(board, discovery()); board.nodes[0].title = 'User';
  mergeBoardContent(board, discovery('Disk2', 'Disk summary', 'v2'));
  const conflict = board.maintenance.conflicts[0]; board.nodes[0].title = 'User3';
  assert.throws(() => resolveMaintenanceChoice(board, conflict.id, 'use_disk'), { code: 'CONFLICT_CHANGED' });
  assert.equal(board.nodes[0].title, 'User3'); assert.equal(conflict.status, 'open');
});

test('脱离来源的旧冲突不能继续写入，重扫后自动关闭过时问题', () => {
  const board = memoryBoard(); mergeBoardContent(board, discovery()); board.nodes[0].title = 'User';
  mergeBoardContent(board, discovery('Disk2', 'Disk summary', 'v2'));
  const conflict = board.maintenance.conflicts[0];
  board.nodes[0].links = [{ path: 'other/unit', kind: 'dir' }]; board.nodes[0].ownedPaths = [];
  assert.throws(() => resolveMaintenanceChoice(board, conflict.id, 'use_disk'), { code: 'CONFLICT_CHANGED' });
  mergeBoardContent(board, discovery('Disk2', 'Disk summary', 'v2'));
  assert.equal(board.nodes[0].title, 'User'); assert.equal(conflict.status, 'resolved');
  assert.equal(board.decisions[0].status, 'answered');
});

test('已有真实条目仅建立来源基线，不覆盖其标题、验收或交付', () => {
  const board = memoryBoard();
  board.nodes.push({ id: 'existing', kind: 'component', title: 'Human', summary: 'Review', links: [{ path: 'results/unit/REPORT.md', kind: 'file' }], x: 1, y: 2 });
  board.tasks.push({ id: 'task', nodeId: 'existing', title: 'Work', acceptance: 'Keep criterion', delivery: { summary: 'Evidence' }, artifacts: [] });
  const result = mergeBoardContent(board, discovery());
  assert.equal(result.counts.added, 0); assert.equal(board.nodes[0].title, 'Human'); assert.equal(board.nodes[0].summary, 'Review');
  assert.equal(board.tasks[0].acceptance, 'Keep criterion'); assert.equal(board.tasks[0].delivery.summary, 'Evidence');
});

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-maintenance-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('pb-maintenance-')); await fs.rm(root, { recursive: true, force: true }); });
  const notifications = [];
  const ctx = { workspaceRegistry: { list: () => [{ id: 'ws', path: root, title: 'Isolated project' }] }, agents: { list: () => options.agents || [] }, jobs: { list: () => options.jobs || [] } };
  const service = new BoardService({ ctx, wakeAssistant: options.wakeAssistant || (async value => notifications.push(value)) });
  await service.create({ workspacePath: root });
  const command = (action, input, other = {}) => service.command({ workspacePath: root, action, input, ...other });
  const maintain = (operation, other = {}) => service.maintain({ workspacePath: root, operation, ...other });
  return { root, ctx, service, command, maintain, notifications, read: async () => (await service.read(root)).board };
}

async function makeOwned(f) {
  await fs.mkdir(path.join(f.root, 'outputs'));
  await fs.writeFile(path.join(f.root, 'outputs', 'report.md'), '# Completed report\n\nA frozen output.\n');
  await f.command('upsert_node', { node: { id: 'output', kind: 'document', title: 'Output', status: 'done', links: [{ kind: 'file', path: 'outputs/report.md' }], ownedPaths: ['outputs/report.md'] } });
}

test('删除独占产物执行实体归档，回执包含SHA/移动位置且迟到更新不能复活', async t => {
  const f = await fixture(t); await makeOwned(f);
  const result = await f.command('delete_node', { id: 'output' }, { commandId: 'delete-output' });
  const deletion = result.board.maintenance.deletions[0];
  assert.equal(deletion.status, 'archived'); assert.equal(result.lastChange.undo.status, 'unavailable');
  await assert.rejects(fs.stat(path.join(f.root, 'outputs', 'report.md')), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(f.root, deletion.receipt.moves[0].to), 'utf8'), /Completed report/);
  const receipt = JSON.parse(await fs.readFile(path.join(f.root, deletion.receipt.receiptPath), 'utf8'));
  assert.ok(JSON.stringify(receipt).length > 20);
  await assert.rejects(f.command('upsert_node', { node: { id: 'output', title: 'Late completion' } }), { code: 'ITEM_DELETED' });
  const replay = await f.command('delete_node', { id: 'output' }, { commandId: 'delete-output' });
  assert.equal(replay.replayed, true); assert.equal(replay.board.maintenance.deletions.length, 1);
});

test('顶层主题的容器导航不误阻止独占子项目归档，真正来源引用仍受保护', async t => {
  const f = await fixture(t); await makeOwned(f);
  await f.command('upsert_node', { node: { id: 'theme', kind: 'theme', title: 'Output index', links: [{ path: 'outputs', kind: 'dir' }] } });
  const result = await f.command('delete_node', { id: 'output' });
  assert.equal(result.board.maintenance.deletions[0].status, 'archived');
  assert.ok(result.board.nodes.find(n => n.id === 'theme'));
});

test('共享引用阻止移动，决定保留文件后标记仍阻止重新入板', async t => {
  const f = await fixture(t); await makeOwned(f);
  await f.command('upsert_node', { node: { id: 'consumer', title: 'Consumer', derivedFrom: ['outputs/report.md'] } });
  const result = await f.command('delete_node', { id: 'output' });
  const deletion = result.board.maintenance.deletions[0], conflict = result.board.maintenance.conflicts[0];
  assert.equal(deletion.status, 'needs_decision'); assert.equal(conflict.kind, 'archive');
  assert.ok((await fs.stat(path.join(f.root, 'outputs', 'report.md'))).isFile());
  await f.maintain('resolve', { conflictId: conflict.id, choice: 'keep_files' });
  const board = await f.read(); assert.equal(board.maintenance.deletions[0].status, 'retained');
  const unit = { candidates: [{ path: 'outputs/report.md', kind: 'document', title: 'Report', summary: '', fingerprint: 'v1' }], warnings: [], truncated: false };
  assert.equal(mergeBoardContent(board, unit).counts.added, 0);
});

test('进行中的条目或真实后台作业不被删除动作终止或迁移', async t => {
  const f = await fixture(t, { jobs: [{ status: 'running', id: 'active-job' }] }); await makeOwned(f);
  await f.command('upsert_node', { node: { id: 'output', status: 'doing' } });
  const result = await f.command('delete_node', { id: 'output' });
  assert.equal(result.board.maintenance.deletions[0].status, 'needs_decision');
  assert.match(result.board.maintenance.deletions[0].reason, /进行中|终态/);
  assert.ok(await fs.stat(path.join(f.root, 'outputs', 'report.md')));
});

test('会话idle但真实后台作业仍running时，归档保持原文件并询问', async t => {
  const f = await fixture(t, { jobs: [{ status: 'running', id: 'training-job' }] }); await makeOwned(f);
  await f.command('upsert_task', { task: { id: 'work', nodeId: 'output', status: 'done', threads: [{ sessionId: 'idle-with-job' }] } });
  const result = await f.command('delete_node', { id: 'output' });
  assert.equal(result.board.maintenance.deletions[0].status, 'needs_decision');
  assert.match(result.board.maintenance.deletions[0].reason, /后台作业/);
  assert.ok(await fs.stat(path.join(f.root, 'outputs', 'report.md')));
});

test('已有关联建立磁盘基线不等于独占所有权，删除先请用户核对范围', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'docs')); await fs.writeFile(path.join(f.root, 'docs', 'report.md'), '# Frozen report\n\nSummary.\n');
  await f.command('upsert_node', { node: { id: 'old', title: 'Existing', kind: 'document', status: 'done', links: [{ kind: 'file', path: 'docs/report.md' }] } });
  await f.maintain('configure', { roots: ['docs'] }); await f.maintain('scan');
  const result = await f.command('delete_node', { id: 'old' });
  assert.equal(result.board.maintenance.deletions[0].ownershipConfirmed, false);
  assert.equal(result.board.maintenance.deletions[0].status, 'needs_decision');
  assert.match(result.board.maintenance.deletions[0].reason, /独占归档范围/);
  assert.ok(await fs.stat(path.join(f.root, 'docs', 'report.md')));
});

test('项目外cwd但显式关联且仍运行的会话也阻止归档', async t => {
  const f = await fixture(t, { agents: [{ id: 'bound-elsewhere', status: 'running', session: { header: { cwd: '/tmp/other-project' } } }] }); await makeOwned(f);
  await f.command('upsert_task', { task: { id: 'work', nodeId: 'output', status: 'done', threads: [{ sessionId: 'bound-elsewhere' }] } });
  const result = await f.command('delete_node', { id: 'output' });
  assert.equal(result.board.maintenance.deletions[0].status, 'needs_decision');
  assert.match(result.board.maintenance.deletions[0].reason, /运行中的会话/);
  assert.ok(await fs.stat(path.join(f.root, 'outputs', 'report.md')));
});

test('没有绑定会话时仍检查unowned运行作业，不以空会话集合绕过保护', async t => {
  const f = await fixture(t, { jobs: [{ id: 'unowned-job', status: 'running' }] }); await makeOwned(f);
  const result = await f.command('delete_node', { id: 'output' });
  assert.equal(result.board.maintenance.deletions[0].status, 'needs_decision');
  assert.match(result.board.maintenance.deletions[0].reason, /未归属会话/);
  assert.ok(await fs.stat(path.join(f.root, 'outputs', 'report.md')));
});

test('没有文件的删除可安全撤销，撤销后清除对应删除阻止状态', async t => {
  const f = await fixture(t); await f.command('upsert_node', { node: { id: 'empty', title: 'Empty' } });
  const result = await f.command('delete_node', { id: 'empty' });
  assert.equal(result.lastChange.undo.status, 'available');
  await f.command('undo_change', { changeId: result.changeId });
  const board = await f.read(); assert.ok(board.nodes.find(n => n.id === 'empty'));
  assert.equal(board.maintenance.deletions[0].status, 'restored');
});

test('撤销创建的移除也留下删除标记，迟到回写和扫描不能复活', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'docs')); await fs.writeFile(path.join(f.root, 'docs', 'report.md'), '# A report\n\nSummary.\n');
  const created = await f.command('upsert_node', { node: { id: 'undone', kind: 'document', title: 'Undone', status: 'done', links: [{ path: 'docs/report.md', kind: 'file' }] } });
  const result = await f.command('undo_change', { changeId: created.changeId });
  assert.equal(result.board.maintenance.deletions.length, 1);
  assert.equal(result.board.maintenance.deletions[0].status, 'needs_decision');
  await assert.rejects(f.command('upsert_node', { node: { id: 'undone', title: 'Late' } }), { code: 'ITEM_DELETED' });
  await f.maintain('configure', { roots: ['docs'] }); const scanned = await f.maintain('scan');
  assert.equal(scanned.board.nodes.length, 0); assert.ok(await fs.stat(path.join(f.root, 'docs', 'report.md')));
});

test('编辑起点base保护同字段并发，独立字段更新保持双方修改', async t => {
  const f = await fixture(t);
  await f.command('upsert_node', { node: { id: 'n', title: 'Before', summary: 'Summary' } });
  await f.command('upsert_node', { node: { id: 'n', title: 'Concurrent' } });
  await assert.rejects(f.command('upsert_node', { node: { id: 'n', title: 'My draft' }, base: { title: 'Before' } }), { code: 'FIELD_CONFLICT' });
  await f.command('upsert_node', { node: { id: 'n', summary: 'New summary' }, base: { summary: 'Summary' } });
  const row = (await f.read()).nodes[0]; assert.equal(row.title, 'Concurrent'); assert.equal(row.summary, 'New summary');
});

test('点击扫描和通知使用同一来源去重，通知复用持久助手且幂等重试不重复投递', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'docs')); await fs.writeFile(path.join(f.root, 'docs', 'report.md'), '# Report\n\nA result.\n');
  await f.maintain('configure', { roots: ['docs'] });
  await f.command('bind_assistant', { sessionId: 'persistent-lead' });
  await f.maintain('scan'); const first = await f.read();
  await f.maintain('notify', { commandId: 'same-notification', message: 'Finished new report' });
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].sessionId, 'persistent-lead');
  assert.match(f.notifications[0].prompt, /不轮询|来源数据/);
  assert.equal((await f.read()).nodes.length, first.nodes.length);
  await f.maintain('notify', { commandId: 'same-notification' }); assert.equal(f.notifications.length, 1);
  await assert.rejects(f.maintain('notify', { actor: 'agent:persistent-lead' }), { code: 'SELF_NOTIFY' });
});

test('已发送prompt后到达的新通知排下一波，不丢附言；独立项目不混用状态', async t => {
  let release, started;
  const entered = new Promise(r => { started = r; });
  const gate = new Promise(r => { release = r; });
  const prompts = [];
  const f = await fixture(t, { wakeAssistant: async value => { prompts.push(value.prompt); started(); await gate; } });
  await f.command('bind_assistant', { sessionId: 'lead' });
  const first = f.maintain('notify', { commandId: 'one', message: 'First report' }); await entered;
  const second = f.maintain('notify', { commandId: 'two', message: 'Second report' });
  release(); await Promise.all([first, second]);
  assert.equal(prompts.length, 2); assert.match(prompts[0], /First report/); assert.match(prompts[1], /Second report/);
  await f.maintain('notify', { commandId: 'two' }); assert.equal(prompts.length, 2, '排队通知ID也持久去重');
  const independent = await fixture(t); assert.equal((await independent.read()).maintenance, undefined);
});
