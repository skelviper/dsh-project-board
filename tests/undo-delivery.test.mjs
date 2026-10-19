import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeBoard, LIMITS } from '../schema.mjs';
import { BoardService } from '../service.mjs';

// 命令往返 JSON 模拟持久化，不接触真实 workspace；另有一个临时文件集成检查。
class MemoryStore {
  constructor(board) { this.text = JSON.stringify(board); this.writes = 0; }
  async read() { return { exists: true, board: normalizeBoard(JSON.parse(this.text)) }; }
  async write(_root, board) { this.text = JSON.stringify(board); this.writes += 1; }
  async mutate(_root, fn) { return fn(); }
  notify() {}
}
function fixture() {
  const board = normalizeBoard({
    nodes: [{ id: 'root', kind: 'theme' }, { id: 'n1', title: '节点一', x: 1, y: 2 }, { id: 'n2', title: '节点二', x: 20, y: 30 }],
    edges: [{ id: 'e1', from: 'root', to: 'n1', kind: 'contains' }, { id: 'e2', from: 'n1', to: 'n2', kind: 'depends' }],
    tasks: [
      { id: 't1', nodeId: 'n1', title: '任务一', acceptance: '原验收标准' },
      { id: 't2', nodeId: 'n2', title: '任务二', blockedBy: ['t1'] },
      { id: 't3', nodeId: 'n2', title: '无关任务' },
    ],
    todos: [{ id: 'd1', taskId: 't1', title: '待办一', status: 'todo' }, { id: 'd2', taskId: 't1', title: '待办二', status: 'done' }],
    notes: [{ id: 'm1', targetType: 'task', targetId: 't1', text: '任务备注正文' }, { id: 'm2', targetType: 'todo', targetId: 'd1', text: '待办备注正文' }],
    decisions: [{ id: 'q1', nodeId: 'n1', question: '待决策' }],
  }, { workspacePath: '/tmp/pb-undo-memory', now: '2026-01-01T00:00:00Z' });
  const store = new MemoryStore(board);
  const ctx = { workspaceRegistry: { list: () => [{ id: 'ws', path: board.workspacePath, title: 'test' }] } };
  const service = new BoardService({ store, ctx });
  const command = (action, input, options = {}) => service.command({ workspacePath: board.workspacePath, action, input, actor: 'test-user', ...options });
  return { board, store, ctx, service, command, read: async () => (await store.read()).board };
}

const pick = (board, collection, id) => board[collection].find(row => row.id === id);

test('旧交付数据不猜结论、验收字段原样保留；结果与进度互相独立', () => {
  const { board } = fixture();
  assert.equal(board.tasks[0].acceptance, '原验收标准');
  assert.deepEqual(board.tasks[0].delivery, { summary: '', outcome: 'unspecified', review: 'none', submittedAt: '' });
  assert.equal(board.todos[1].status, 'done');
  assert.equal(board.todos[1].delivery.outcome, 'unspecified');
  const loaded = normalizeBoard({ ...board, tasks: [{ ...board.tasks[0], status: 'todo', delivery: { summary: '不支持', outcome: 'not_supported', review: 'accepted', submittedAt: '' } }] });
  assert.equal(loaded.tasks[0].status, 'todo');
  assert.equal(loaded.tasks[0].delivery.outcome, 'not_supported');
});

test('交付部分更新与日期清除跨读取保存，不清空验收或其他交付字段', async () => {
  const { command, read } = fixture();
  await command('upsert_task', { task: { id: 't1', primaryArtifactPath: 'reports/result.md', delivery: { summary: '已交付完整证据', outcome: 'not_triggered', review: 'pending', submittedAt: '2026-01-02T08:00:00+08:00' } } });
  await command('upsert_task', { task: { id: 't1', delivery: { review: 'accepted', submittedAt: '' } } });
  const task = pick(await read(), 'tasks', 't1');
  assert.equal(task.primaryArtifactPath, 'reports/result.md');
  assert.equal(task.acceptance, '原验收标准');
  assert.deepEqual(task.delivery, { summary: '已交付完整证据', outcome: 'not_triggered', review: 'accepted', submittedAt: '' });
  assert.equal(task.status, 'todo');
});

test('布局撤销保留后来编辑的标题和无关节点位置，刷新后历史仍可撤销', async () => {
  const { command, read, store, ctx } = fixture();
  const change = await command('save_positions', { positions: [{ id: 'n1', x: 100, y: 200 }] });
  assert.equal(change.lastChange.undo.status, 'available');
  await command('upsert_node', { node: { id: 'n1', title: '后来的标题' } });
  await command('save_positions', { positions: [{ id: 'n2', x: 300, y: 400 }] });
  const freshService = new BoardService({ store, ctx });
  await freshService.command({ workspacePath: '/tmp/pb-undo-memory', action: 'undo_change', input: { changeId: change.changeId }, actor: 'second-user' });
  const board = await read();
  assert.equal(pick(board, 'nodes', 'n1').x, 1);
  assert.equal(pick(board, 'nodes', 'n1').y, 2);
  assert.equal(pick(board, 'nodes', 'n1').title, '后来的标题');
  assert.equal(pick(board, 'nodes', 'n2').x, 300);
  assert.equal(board.changes.find(row => row.id === change.changeId).undo.undoneBy, 'second-user');
  assert.equal(board.changes[0].action, 'undo_change');
  assert.equal(board.changes[0].undo.status, 'unavailable');
});

test('受影响字段后来改变时原子拒绝，不回写或增加revision', async () => {
  const { command, store, read } = fixture();
  const change = await command('save_positions', { positions: [{ id: 'n1', x: 100, y: 200 }] });
  await command('save_positions', { positions: [{ id: 'n1', x: 101, y: 200 }] });
  const before = store.text, writes = store.writes;
  await assert.rejects(command('undo_change', { changeId: change.changeId }), error => error.code === 'UNDO_CONFLICT' && error.status === 409);
  assert.equal(store.text, before);
  assert.equal(store.writes, writes);
  assert.equal(pick(await read(), 'nodes', 'n1').x, 101);
});

test('删除任务撤销恢复待办、完整备注、依赖，保留幸存任务后来编辑', async () => {
  const { command, read } = fixture();
  const change = await command('delete_task', { id: 't1' });
  assert.equal(change.board.todos.length, 0);
  assert.equal(change.board.notes.length, 0);
  assert.deepEqual(pick(change.board, 'tasks', 't2').blockedBy, []);
  for (const target of ['task:t1', 'todo:d1', 'todo:d2', 'node:n1', 'node:root']) assert.ok(change.lastChange.targets.some(row => `${row.type}:${row.id}` === target), target);
  await command('upsert_task', { task: { id: 't2', title: '后来的幸存任务标题' } });
  await command('undo_change', { changeId: change.changeId });
  const board = await read();
  assert.equal(pick(board, 'tasks', 't1').acceptance, '原验收标准');
  assert.equal(board.todos.length, 2);
  assert.equal(pick(board, 'todos', 'd2').status, 'done');
  assert.equal(pick(board, 'notes', 'm1').text, '任务备注正文');
  assert.equal(pick(board, 'notes', 'm2').text, '待办备注正文');
  assert.deepEqual(pick(board, 'tasks', 't2').blockedBy, ['t1']);
  assert.equal(pick(board, 'tasks', 't2').title, '后来的幸存任务标题');
});

test('删除任务后依赖成员改动时拒绝恢复，不覆盖后来的依赖', async () => {
  const { command, read } = fixture();
  const change = await command('delete_task', { id: 't1' });
  await command('upsert_task', { task: { id: 't2', blockedBy: ['t3'] } });
  await assert.rejects(command('undo_change', { changeId: change.changeId }), { code: 'UNDO_CONFLICT' });
  assert.deepEqual(pick(await read(), 'tasks', 't2').blockedBy, ['t3']);
});

test('撤销新建任务拒绝删除后来新增的待办或依赖', async () => {
  const { command, read } = fixture();
  const change = await command('upsert_task', { task: { id: 'new-task', nodeId: 'n1', title: '新任务' } });
  await command('upsert_todo', { todo: { id: 'new-todo', taskId: 'new-task', title: '新增待办' } });
  await assert.rejects(command('undo_change', { changeId: change.changeId }), { code: 'UNDO_CONFLICT' });
  assert.ok(pick(await read(), 'todos', 'new-todo'));
});

test('删除节点撤销恢复连线、任务、待办、备注及决策', async () => {
  const { command, read } = fixture();
  const change = await command('delete_node', { id: 'n1' });
  await command('upsert_task', { task: { id: 't3', owner: 'other' } });
  await command('undo_change', { changeId: change.changeId });
  const board = await read();
  assert.equal(board.nodes.length, 3);
  assert.equal(board.edges.length, 2);
  assert.equal(board.tasks.length, 3);
  assert.equal(board.todos.length, 2);
  assert.equal(board.notes.length, 2);
  assert.equal(board.decisions.length, 1);
  assert.equal(pick(board, 'tasks', 't3').owner, 'other');
});

test('删除连线可撤销，但端点已被删除时拒绝复活悬空连线', async () => {
  const { command, read } = fixture();
  const first = await command('delete_edge', { id: 'e2' });
  await command('undo_change', { changeId: first.changeId });
  assert.ok(pick(await read(), 'edges', 'e2'));
  const second = await command('delete_edge', { id: 'e2' });
  await command('delete_node', { id: 'n2' });
  await assert.rejects(command('undo_change', { changeId: second.changeId }), { code: 'UNDO_CONFLICT' });
  assert.equal(pick(await read(), 'edges', 'e2'), undefined);
});

test('删除标记拒绝同ID重建；外部同ID新代次也不能接上旧连线', async () => {
  const { command, read, store } = fixture();
  const change = await command('delete_edge', { id: 'e2' });
  await command('delete_node', { id: 'n2' });
  await assert.rejects(command('upsert_node', { node: { id: 'n2', title: '同ID新节点' } }), { code: 'ITEM_DELETED' });
  // 模拟非API外部写入新代次，继续验证撤销的身份guard而非绕过生产删除标记。
  const external = await read(); external.nodes.push({ id: 'n2', title: '外部新代次', createdAt: '2026-02-01T00:00:00Z' });
  await store.write('', external);
  await assert.rejects(command('undo_change', { changeId: change.changeId }), { code: 'UNDO_CONFLICT' });
  assert.equal(pick(await read(), 'edges', 'e2'), undefined);
});

test('待办状态和交付摘要撤销保留后来独立修改的审核字段', async () => {
  const { command, read } = fixture();
  const change = await command('upsert_todo', { todo: { id: 'd1', status: 'done', delivery: { summary: '新摘要', outcome: 'supported' } } });
  await command('upsert_todo', { todo: { id: 'd1', delivery: { review: 'accepted' } } });
  await command('undo_change', { changeId: change.changeId });
  const todo = pick(await read(), 'todos', 'd1');
  assert.equal(todo.status, 'todo');
  assert.deepEqual(todo.delivery, { summary: '', outcome: 'unspecified', review: 'accepted', submittedAt: '' });
});

test('命令和撤销重试幂等，重复撤销有明确错误', async () => {
  const { command, read } = fixture();
  const change = await command('delete_todo', { id: 'd1' }, { commandId: 'delete-once' });
  const replay = await command('delete_todo', { id: 'd1' }, { commandId: 'delete-once', expectedRevision: 0 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.changeId, change.changeId);
  const undo = await command('undo_change', { changeId: change.changeId }, { commandId: 'undo-once' });
  const again = await command('undo_change', { changeId: change.changeId }, { commandId: 'undo-once' });
  assert.equal(again.changeId, undo.changeId);
  assert.equal((await read()).changes.length, 2);
  await assert.rejects(command('undo_change', { changeId: change.changeId }), { code: 'UNDO_UNAVAILABLE' });
});

test('会话绑定及团队关联不可撤销，最近历史数量有界', async () => {
  const { command, read } = fixture();
  const bound = await command('bind_thread', { taskId: 't1', sessionId: 's1' });
  assert.equal(bound.lastChange.undo.status, 'unavailable');
  await assert.rejects(command('undo_change', { changeId: bound.changeId }), { code: 'UNDO_UNAVAILABLE' });
  const team = await command('upsert_task', { task: { id: 't1', team: { leadSessionId: 'lead', taskId: 'team-1' } } });
  assert.equal(team.lastChange.undo.status, 'unavailable');
  for (let i = 0; i < LIMITS.changes + 3; i += 1) await command('upsert_task', { task: { id: 't3', title: `标题 ${i}` } });
  const board = await read();
  assert.equal(board.changes.length, LIMITS.changes);
  assert.ok(Buffer.byteLength(JSON.stringify(board.changes)) <= LIMITS.changeBytes + LIMITS.changes);
});

test('任务移动历史归属包含旧新节点，撤销保留后来独立编辑', async () => {
  const { command, read } = fixture();
  const change = await command('upsert_task', { task: { id: 't1', nodeId: 'n2' } });
  for (const id of ['n1', 'n2', 'root']) assert.ok(change.lastChange.targets.some(row => row.type === 'node' && row.id === id));
  await command('upsert_task', { task: { id: 't1', owner: 'new-owner' } });
  await command('undo_change', { changeId: change.changeId });
  assert.equal(pick(await read(), 'tasks', 't1').nodeId, 'n1');
  assert.equal(pick(await read(), 'tasks', 't1').owner, 'new-owner');
});

test('同ID删除后普通回写被拒绝，外部新代次不接受早先字段撤销', async () => {
  const { command, read, store } = fixture();
  const change = await command('upsert_task', { task: { id: 't3', title: '新标题' } });
  await command('delete_task', { id: 't3' });
  await assert.rejects(command('upsert_task', { task: { id: 't3', nodeId: 'n2', title: '新标题' } }), { code: 'ITEM_DELETED' });
  const external = await read(); external.tasks.push({ id: 't3', nodeId: 'n2', title: '新标题', createdAt: '2026-02-01T00:00:00Z' });
  await store.write('', external);
  await assert.rejects(command('undo_change', { changeId: change.changeId }), { code: 'UNDO_CONFLICT' });
});

test('新建节点有后来连线时不可撤销；空节点新建可撤销', async () => {
  const { command, read } = fixture();
  const first = await command('upsert_node', { node: { id: 'new-node' } });
  await command('undo_change', { changeId: first.changeId });
  assert.equal(pick(await read(), 'nodes', 'new-node'), undefined);
  await assert.rejects(command('upsert_node', { node: { id: 'new-node' } }), { code: 'ITEM_DELETED' });
  const second = await command('upsert_node', { node: { id: 'next-node' } });
  await command('upsert_edge', { edge: { id: 'new-edge', from: 'n1', to: 'next-node' } });
  await assert.rejects(command('undo_change', { changeId: second.changeId }), { code: 'UNDO_CONFLICT' });
  assert.ok(pick(await read(), 'edges', 'new-edge'));
});

test('连线类型编辑撤销保留后来独立修改的标签', async () => {
  const { command, read } = fixture();
  const change = await command('upsert_edge', { edge: { id: 'e2', kind: 'produces' } });
  await command('upsert_edge', { edge: { id: 'e2', label: '后来的说明' } });
  await command('undo_change', { changeId: change.changeId });
  assert.equal(pick(await read(), 'edges', 'e2').kind, 'depends');
  assert.equal(pick(await read(), 'edges', 'e2').label, '后来的说明');
});

test('大规模删除保留完整操作结果但不持久化超限撤销正文', async () => {
  const { service, store, command } = fixture();
  const board = (await store.read()).board;
  board.notes = Array.from({ length: 80 }, (_, index) => ({ id: `large-${index}`, targetType: 'task', targetId: 't1', text: '长'.repeat(16000), createdAt: board.createdAt, author: 'test' }));
  await store.write('', board);
  const result = await command('delete_task', { id: 't1' });
  assert.equal(result.board.notes.length, 0);
  assert.equal(result.lastChange.undo.status, 'unavailable');
  assert.match(result.lastChange.undo.reason, /变更过大/);
  assert.deepEqual(result.lastChange.patches, []);
  assert.ok(Buffer.byteLength(store.text) < LIMITS.changeBytes);
  await assert.rejects(service.command({ workspacePath: board.workspacePath, action: 'undo_change', input: { changeId: result.changeId } }), { code: 'UNDO_UNAVAILABLE' });
});

test('损坏或危险的持久补丁不可执行', () => {
  const { board } = fixture();
  const normalized = normalizeBoard({ ...board, changes: [{ id: 'bad', actor: 'test', action: 'upsert_task', undo: { status: 'available' }, patches: [{ collection: 'tasks', id: 't1', path: ['__proto__', 'polluted'], beforeExists: false, afterExists: true, after: true }] }] });
  assert.equal(normalized.changes[0].undo.status, 'unavailable');
  assert.deepEqual(normalized.changes[0].patches, []);
});

test('真实存储刷新后仍能撤销；测试文件限独立临时workspace', async (t) => {
  const root = await fs.mkdtemp('/tmp/dsh-board-undo-');
  assert.ok(path.resolve(root).startsWith('/tmp/dsh-board-undo-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(resolved, root);
    assert.ok(resolved.startsWith('/tmp/dsh-board-undo-'));
    await fs.rm(resolved, { recursive: true });
  });
  const ctx = { workspaceRegistry: { list: () => [{ id: 'ws', path: root, title: 'test' }] } };
  const service = new BoardService({ ctx });
  await service.command({ workspacePath: root, action: 'create_board', input: {} });
  await service.command({ workspacePath: root, action: 'upsert_node', input: { node: { id: 'n1', title: '初始标题' } } });
  const changed = await service.command({ workspacePath: root, action: 'upsert_node', input: { node: { id: 'n1', title: '新标题' } } });
  const fresh = new BoardService({ ctx });
  const result = await fresh.command({ workspacePath: root, action: 'undo_change', input: { changeId: changed.changeId } });
  assert.equal(result.board.nodes[0].title, '初始标题');
  assert.equal((await fresh.read(root)).board.changes.find(row => row.id === changed.changeId).undo.status, 'undone');
});
