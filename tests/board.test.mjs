import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, normalizeBoard, boardDigest } from '../schema.mjs';
import { BoardService } from '../service.mjs';
import { transcriptFromSnapshot } from '../thread.mjs';

const wsRoot = async () => {
  const root = await fs.mkdtemp('/tmp/dsh-board-test-');
  await fs.mkdir(path.join(root, 'board'), { recursive: true });
  return root;
};

function makeCtx(root) {
  return { workspaceRegistry: { list: () => [{ id: 'ws-1', path: root, title: 'test' }] } };
}

// 所有命令只使用独立的临时 workspace，测试不会访问真实看板。
async function makeBoard(task = {}, todo = {}) {
  const root = await wsRoot();
  const service = new BoardService({ ctx: makeCtx(root) });
  const command = (action, input, options = {}) => service.command({ workspacePath: root, action, input, actor: 'test', ...options });
  await command('create_board', { title: 'T' });
  await command('upsert_node', { node: { id: 'n1', title: 'N' } });
  await command('upsert_task', { task: { id: 't1', nodeId: 'n1', title: 'Task', ...task } });
  await command('upsert_todo', { todo: { id: 'd1', taskId: 't1', title: 'Todo', ...todo } });
  return { root, service, command };
}

test('normalizeBoard drops dangling edges/tasks/todos and clamps limits', () => {
  const board = normalizeBoard({
    nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    edges: [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'a', to: 'missing' }],
    tasks: [{ id: 't1', nodeId: 'a', title: 'T' }, { id: 't2', nodeId: 'missing', title: 'bad' }],
    todos: [{ id: 'd1', taskId: 't1', title: 'D' }, { id: 'd2', taskId: 'missing', title: 'bad' }],
  }, { workspacePath: '/tmp/x', title: 'x' });
  assert.equal(board.edges.length, 1);
  assert.equal(board.tasks.length, 1);
  assert.equal(board.todos.length, 1);
  assert.equal(board.workspacePath, '/tmp/x');
});

test('tasks and todos share thread migration, deduplication and stable metadata', () => {
  const legacyThread = { sessionId: 's-legacy', title: '旧会话', createdAt: '2026-01-01T00:00:00.000Z' };
  const legacy = normalizeBoard({
    nodes: [{ id: 'n', title: 'N' }],
    tasks: [{ id: 't', nodeId: 'n', title: 'T', status: 'todo', thread: legacyThread }],
    todos: [{ id: 'd', taskId: 't', title: 'D', status: 'blocked', thread: legacyThread }],
  }, { workspacePath: '/tmp/x', title: 'x', now: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(legacy.tasks[0].threads.map((row) => row.sessionId), ['s-legacy']);
  assert.deepEqual(legacy.tasks[0].threads, legacy.todos[0].threads);
  assert.equal(legacy.tasks[0].threads[0].createdAt, legacyThread.createdAt);
  assert.equal(legacy.tasks[0].status, 'todo');
  assert.equal(legacy.todos[0].status, 'blocked');
  assert.equal(Object.hasOwn(legacy.tasks[0], 'thread'), false);
  assert.equal(Object.hasOwn(legacy.todos[0], 'thread'), false);

  const mixed = {
    threads: [null, { sessionId: ' ' }, { sessionId: ' s1 ', title: '保留' }, { sessionId: 's1', title: '重复' }, { sessionId: 's2' }],
    thread: { sessionId: 's1', title: '旧重复' },
  };
  const deduped = normalizeBoard({
    nodes: [{ id: 'n', title: 'N' }],
    tasks: [{ id: 't', nodeId: 'n', ...mixed }],
    todos: [{ id: 'd', taskId: 't', ...mixed }],
  }, { workspacePath: '/tmp/x', now: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(deduped.tasks[0].threads.map((row) => row.sessionId), ['s1', 's2']);
  assert.deepEqual(deduped.tasks[0].threads, deduped.todos[0].threads);
  assert.equal(deduped.tasks[0].threads[0].title, '保留');
  const reloaded = normalizeBoard(deduped, { now: '2026-02-01T00:00:00.000Z' });
  assert.deepEqual(reloaded.tasks[0].threads, deduped.tasks[0].threads);
  assert.deepEqual(reloaded.todos[0].threads, deduped.todos[0].threads);
});

test('task and todo bindings append idempotently and preserve every existing status', async () => {
  const { command } = await makeBoard();
  const oldThread = { sessionId: 'session-a', title: '原会话', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  for (const kind of ['task', 'todo']) {
    const id = kind === 'task' ? 't1' : 'd1';
    const selector = { [`${kind}Id`]: id };
    const rows = kind === 'task' ? 'tasks' : 'todos';
    for (const status of ['todo', 'doing', 'blocked', 'done', 'dropped']) {
      await command(`upsert_${kind}`, { [kind]: { id, status, threads: [oldThread] } });
      const appended = await command('bind_thread', { ...selector, sessionId: 'session-b', title: '新会话' });
      assert.deepEqual(appended.board[rows][0].threads.map((row) => row.sessionId), ['session-a', 'session-b']);
      assert.equal(appended.board[rows][0].status, status);
      const rebound = await command('bind_thread', { ...selector, sessionId: 'session-a', title: '不应覆盖' });
      assert.deepEqual(rebound.board[rows][0], appended.board[rows][0]);
      assert.deepEqual(rebound.board[rows][0].threads[0], oldThread);
      const removed = await command('unbind_thread', { ...selector, sessionId: 'session-b' });
      assert.deepEqual(removed.board[rows][0].threads, [oldThread]);
      assert.equal(removed.board[rows][0].status, status);
      const missing = await command('unbind_thread', { ...selector, sessionId: 'not-bound' });
      assert.deepEqual(missing.board[rows][0].threads, [oldThread]);
      assert.equal(missing.board[rows][0].status, status);
    }
  }
});

test('legacy todo-only unbind clears its threads and preserves task bindings and statuses', async () => {
  const { command } = await makeBoard(
    { status: 'todo', threads: [{ sessionId: 'task-session' }] },
    { status: 'blocked', threads: [{ sessionId: 'todo-a' }, { sessionId: 'todo-b' }] },
  );
  const one = await command('unbind_thread', { todoId: 'd1', sessionId: 'todo-a' });
  assert.deepEqual(one.board.todos[0].threads.map((row) => row.sessionId), ['todo-b']);
  const cleared = await command('unbind_thread', { todoId: 'd1' });
  assert.deepEqual(cleared.board.todos[0].threads, []);
  assert.equal(cleared.board.todos[0].status, 'blocked');
  assert.deepEqual(cleared.board.tasks[0].threads.map((row) => row.sessionId), ['task-session']);
  assert.equal(cleared.board.tasks[0].status, 'todo');
});

test('upsert_task and upsert_todo persist threads and preserve them during partial merges', async () => {
  const { root, service, command } = await makeBoard(
    { status: 'blocked', threads: [{ sessionId: 'task-a' }], thread: { sessionId: 'task-legacy' } },
    { status: 'done', threads: [{ sessionId: 'todo-a' }], thread: { sessionId: 'todo-legacy' } },
  );
  const initial = (await service.read(root)).board;
  assert.deepEqual(initial.tasks[0].threads.map((row) => row.sessionId), ['task-a', 'task-legacy']);
  assert.deepEqual(initial.todos[0].threads.map((row) => row.sessionId), ['todo-a', 'todo-legacy']);
  await command('upsert_task', { task: { id: 't1', title: '改名任务' } });
  await command('upsert_todo', { todo: { id: 'd1', acceptance: '新增验收条件' } });
  const merged = (await service.read(root)).board;
  assert.deepEqual(merged.tasks[0].threads, initial.tasks[0].threads);
  assert.deepEqual(merged.todos[0].threads, initial.todos[0].threads);
  assert.equal(merged.tasks[0].status, 'blocked');
  assert.equal(merged.todos[0].status, 'done');
  await command('upsert_task', { task: { id: 't1', threads: [...merged.tasks[0].threads, { sessionId: 'task-b' }] } });
  await command('upsert_todo', { todo: { id: 'd1', threads: [...merged.todos[0].threads, { sessionId: 'todo-b' }] } });
  await command('upsert_task', { task: { id: 't1', thread: { sessionId: 'task-legacy-update' } } });
  await command('upsert_todo', { todo: { id: 'd1', thread: { sessionId: 'todo-legacy-update' } } });
  const reopened = new BoardService({ ctx: makeCtx(root) });
  const persisted = (await reopened.read(root)).board;
  assert.deepEqual(persisted.tasks[0].threads.map((row) => row.sessionId), ['task-a', 'task-legacy', 'task-b', 'task-legacy-update']);
  assert.deepEqual(persisted.todos[0].threads.map((row) => row.sessionId), ['todo-a', 'todo-legacy', 'todo-b', 'todo-legacy-update']);
  const disk = JSON.parse(await fs.readFile(path.join(root, 'board', 'project-board.json'), 'utf8'));
  assert.deepEqual(disk.tasks[0].threads, persisted.tasks[0].threads);
  assert.deepEqual(disk.todos[0].threads, persisted.todos[0].threads);
  assert.equal(Object.hasOwn(disk.tasks[0], 'thread'), false);
  assert.equal(Object.hasOwn(disk.todos[0], 'thread'), false);
});

test('thread commands require exactly one target, keep not-found errors and enforce revision CAS', async () => {
  const { root, service, command } = await makeBoard();
  const before = (await service.read(root)).board;
  for (const action of ['bind_thread', 'unbind_thread']) {
    for (const input of [
      { sessionId: 's' },
      { taskId: 't1', todoId: 'd1', sessionId: 's' },
      { taskId: 't1', todoId: '', sessionId: 's' },
      { taskId: '', sessionId: 's' },
      { todoId: null, sessionId: 's' },
      { taskId: 't1' },
      { taskId: 't1', sessionId: ' ' },
      { todoId: 'd1', sessionId: '' },
      { todoId: 'd1', sessionId: null },
    ]) {
      await assert.rejects(() => command(action, input), (error) => error.code === 'INVALID_INPUT');
    }
    await assert.rejects(() => command(action, { taskId: 'missing', sessionId: 's' }), (error) => error.code === 'TASK_NOT_FOUND' && error.status === 404);
    await assert.rejects(() => command(action, { todoId: 'missing', sessionId: 's' }), (error) => error.code === 'TODO_NOT_FOUND' && error.status === 404);
    await assert.rejects(() => command(action, { taskId: 't1', sessionId: 's' }, { expectedRevision: before.revision - 1 }), (error) => error.code === 'STALE_REVISION' && error.status === 409);
  }
  await assert.rejects(() => command('bind_thread', { todoId: 'd1' }), (error) => error.code === 'INVALID_INPUT');
  assert.deepEqual((await service.read(root)).board, before);
  const bound = await command('bind_thread', { taskId: 't1', sessionId: 's' }, { expectedRevision: before.revision, commandId: 'task-bind' });
  const replayed = await command('bind_thread', { taskId: 't1', sessionId: 's' }, { expectedRevision: before.revision, commandId: 'task-bind' });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.board, bound.board);
});

test('full thread lists reject additions without evicting existing task or todo sessions', async () => {
  const threads = Array.from({ length: LIMITS.threads }, (_, i) => ({ sessionId: `session-${i}` }));
  const { root, service, command } = await makeBoard({ threads }, { threads });
  for (const selector of [{ taskId: 't1' }, { todoId: 'd1' }]) {
    await command('bind_thread', { ...selector, sessionId: 'session-0' });
    const before = (await service.read(root)).board;
    await assert.rejects(() => command('bind_thread', { ...selector, sessionId: 'new-session' }), (error) => error.code === 'THREAD_LIMIT_REACHED');
    assert.deepEqual((await service.read(root)).board, before);
  }
});

test('BoardService enforces revision CAS, command idempotency and cascade deletes', async () => {
  const root = await wsRoot();
  const service = new BoardService({ ctx: makeCtx(root) });
  const created = await service.command({ workspacePath: root, action: 'create_board', input: { title: 'T' }, actor: 'test' });
  assert.equal(created.board.revision, 1);
  const node = await service.command({ workspacePath: root, action: 'upsert_node', input: { node: { id: 'n1', kind: 'theme', title: 'N' } }, actor: 'test' });
  assert.equal(node.board.revision, 2);
  await assert.rejects(
    () => service.command({ workspacePath: root, expectedRevision: 1, action: 'upsert_node', input: { node: { id: 'n2', title: 'N2' } }, actor: 'test' }),
    (error) => error.code === 'STALE_REVISION',
  );
  const task = await service.command({ workspacePath: root, action: 'upsert_task', input: { task: { id: 't1', nodeId: 'n1', title: 'Task' } }, actor: 'test' });
  const todo = await service.command({ workspacePath: root, action: 'upsert_todo', input: { todo: { id: 'd1', taskId: 't1', title: 'Todo' } }, actor: 'test' });
  assert.equal(todo.board.todos.length, 1);
  const replay = await service.command({ workspacePath: root, commandId: 'cmd-1', action: 'add_note', input: { text: 'note' }, actor: 'test' });
  const replay2 = await service.command({ workspacePath: root, commandId: 'cmd-1', action: 'add_note', input: { text: 'note' }, actor: 'test' });
  assert.equal(replay.board.revision, replay2.board.revision);
  assert.equal(replay2.board.notes.length, 1);
  const deleted = await service.command({ workspacePath: root, action: 'delete_node', input: { id: 'n1' }, actor: 'test' });
  assert.equal(deleted.board.tasks.length, 0);
  assert.equal(deleted.board.todos.length, 0);
  assert(task.board.revision > 2);
});

test('boardDigest is bounded and mentions themes, running todos and open decisions', () => {
  const board = normalizeBoard({
    nodes: [{ id: 'th', kind: 'theme', title: 'main' }, { id: 'f1', kind: 'figure', title: 'Fig1' }],
    edges: [{ id: 'e', from: 'th', to: 'f1', kind: 'contains' }],
    tasks: [{ id: 't', nodeId: 'f1', title: 'Task' }],
    todos: [{ id: 'd', taskId: 't', title: 'Todo', status: 'doing' }],
    decisions: [{ id: 'q', nodeId: 'f1', question: 'Q?', status: 'open' }],
  }, { workspacePath: '/tmp/x', title: 'x' });
  const digest = boardDigest(board, { workspacePath: '/tmp/x', teamTasks: [] });
  assert(digest.includes('main'));
  assert(digest.includes('Fig1'));
  assert(digest.includes('Todo'));
  assert(digest.includes('Q?'));
  assert(digest.length < 4000);
});

test('boardDigest recognizes every task and todo thread, all matching items and inactive statuses', () => {
  const threads = (...ids) => ids.map((sessionId) => ({ sessionId }));
  const board = normalizeBoard({
    nodes: [{ id: 'n', title: 'Node' }],
    tasks: [
      { id: 't1', nodeId: 'n', title: 'Task 1', status: 'todo', threads: threads('task-first', 'shared', 'task-last') },
      { id: 't2', nodeId: 'n', title: 'Task 2', status: 'done', threads: threads('shared') },
    ],
    todos: [
      { id: 'd1', taskId: 't1', title: 'Todo 1', status: 'blocked', threads: threads('todo-first', 'shared', 'todo-last') },
      { id: 'd2', taskId: 't2', title: 'Todo 2', status: 'todo', threads: threads('shared') },
    ],
    notes: [{ text: '较长备注'.repeat(2000), targetType: 'board' }],
  }, { workspacePath: '/tmp/x' });
  const summary = boardDigest(board, { workspacePath: '/tmp/x' });
  assert(summary.includes('2 个任务 / 2 个待办，共 5 个会话'));
  assert(summary.length <= 4000);
  const expected = new Map([
    ['task-first', ['task t1']], ['task-last', ['task t1']],
    ['todo-first', ['todo d1']], ['todo-last', ['todo d1']],
    ['shared', ['task t1', 'task t2', 'todo d1', 'todo d2']],
    ['unbound', []],
  ]);
  for (const [sessionId, bindings] of expected) {
    const digest = boardDigest(board, { workspacePath: '/tmp/x', sessionId });
    for (const binding of ['task t1', 'task t2', 'todo d1', 'todo d2']) {
      assert.equal(digest.includes(`（${binding}，状态 `), bindings.includes(binding), `${sessionId}: ${binding}`);
    }
    assert(digest.length <= 4000);
  }
});

test('BoardService.digestFor passes the agent session to shared task and todo binding context', async () => {
  const { root, service } = await makeBoard(
    { threads: [{ sessionId: 'first-task' }, { sessionId: 'shared' }] },
    { threads: [{ sessionId: 'first-todo' }, { sessionId: 'shared' }] },
  );
  const { digest } = await service.digestFor({ id: 'shared', session: { header: { cwd: root } } });
  assert(digest.includes('（task t1，状态 todo）'));
  assert(digest.includes('（todo d1，状态 todo）'));
});

test('transcript excludes synthetic user context and keeps real prompts/tool calls', () => {
  const snapshot = {
    session: { id: 's1' },
    events: [
      { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真实提问' }] } },
      { seq: 2, time: 2, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '合成上下文' }] } },
      { seq: 3, time: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回复' }] } } },
      { seq: 4, time: 4, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
      { seq: 5, time: 5, type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
    ],
  };
  const transcript = transcriptFromSnapshot(snapshot, { limit: 20 });
  assert.deepEqual(transcript.entries.map((entry) => entry.kind), ['user', 'assistant', 'tool-call', 'tool-result']);
  assert.equal(transcript.entries[0].text, '真实提问');
  assert(!transcript.entries.some((entry) => entry.text === '合成上下文'));
});
