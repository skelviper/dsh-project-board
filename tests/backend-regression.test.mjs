// 后端回归只使用内存看板与假的 Agent Team，不访问真实看板或创建团队任务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardService } from '../service.mjs';
import { BoardStore } from '../store.mjs';
import { normalizeBoard } from '../schema.mjs';

const workspacePath = '/tmp/dsh-board-backend-memory';
class MemoryStore extends BoardStore {
  constructor(board) {
    super();
    this.board = structuredClone(board);
    this.writes = 0;
  }
  async read() { return { exists: true, board: structuredClone(this.board), mtimeMs: 0 }; }
  async write(_workspace, board) {
    this.writes += 1;
    this.board = structuredClone(board);
  }
}
function makeFixture(overrides = {}) {
  const board = normalizeBoard({
    revision: 10,
    nodes: [{ id: 'n1', title: 'First' }, { id: 'n2', title: 'Second' }],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', kind: 'depends' }],
    tasks: [
      { id: 't1', nodeId: 'n1', title: 'Parent', threads: [{ sessionId: 'task-session' }] },
      { id: 't2', nodeId: 'n2', title: 'Dependent', blockedBy: ['t1'] },
    ],
    todos: [
      { id: 'd1', taskId: 't1', title: 'One', threads: [{ sessionId: 'todo-session' }] },
      { id: 'd2', taskId: 't1', title: 'Two' },
    ],
    notes: [
      { id: 'm-node', targetType: 'node', targetId: 'n1', text: 'Node note' },
      { id: 'm-task', targetType: 'task', targetId: 't1', text: 'Task note' },
      { id: 'm-todo', targetType: 'todo', targetId: 'd1', text: 'Todo note' },
      { id: 'm-board', targetType: 'board', text: 'Board note' },
    ],
    ...overrides,
  }, { workspacePath });
  const createdTasks = [];
  const notifications = [];
  const store = new MemoryStore(board);
  store.onChange((event) => notifications.push(event));
  const ctx = {
    workspaceRegistry: { list: () => [{ id: 'test-ws', path: workspacePath, title: 'Review' }] },
    agents: { get: () => ({ id: 'lead' }) },
    agentTeams: {
      tryMembership: () => ({ role: 'lead' }),
      createTask: async (_agent, input) => {
        createdTasks.push(input);
        return { id: String(createdTasks.length), status: 'pending', revision: 1 };
      },
    },
  };
  const service = new BoardService({ ctx, store });
  const command = (action, input, options = {}) => service.command({ workspacePath, action, input, ...options });
  const dispatch = (items, options = {}) => service.dispatch({ workspacePath, leadSessionId: 'lead', items, ...options });
  return { service, store, command, dispatch, createdTasks, notifications };
}

for (const [entity, id, key, code] of [
  ['task', 't1', 'nodeId', 'NODE_NOT_FOUND'],
  ['todo', 'd1', 'taskId', 'TASK_NOT_FOUND'],
  ['edge', 'e1', 'to', 'NODE_NOT_FOUND'],
]) {
  test(`invalid ${entity} reference rejects without changing data or committing`, async () => {
    const { service, command, store, notifications } = makeFixture();
    const before = structuredClone(store.board);
    for (const value of ['missing', '', ' ', null, undefined]) {
      const input = { [entity]: { id, [key]: value } };
      const inMemory = structuredClone(before);
      assert.throws(() => service.applyCommand(inMemory, `upsert_${entity}`, input, 'test'), { code });
      assert.deepEqual(inMemory, before, 'validation must precede mutation');
      await assert.rejects(() => command(`upsert_${entity}`, input, { commandId: 'invalid-upsert', expectedRevision: 10 }), { code });
      assert.deepEqual(store.board, before);
    }
    assert.equal(store.writes, 0);
    assert.deepEqual(notifications, []);
  });
}

test('new tasks, todos and edges also reject invalid parents or endpoints', async () => {
  const { command, store } = makeFixture();
  const before = structuredClone(store.board);
  for (const [entity, data, code] of [
    ['task', { id: 'new-task', nodeId: 'missing' }, 'NODE_NOT_FOUND'],
    ['task', { title: 'Missing node' }, 'NODE_NOT_FOUND'],
    ['todo', { id: 'new-todo', taskId: 'missing' }, 'TASK_NOT_FOUND'],
    ['edge', { id: 'new-edge', from: 'missing', to: 'n2' }, 'NODE_NOT_FOUND'],
    ['edge', { from: 'n1', to: 'missing' }, 'NODE_NOT_FOUND'],
    ['edge', { from: 'n1', to: 'n1' }, 'INVALID_INPUT'],
  ]) {
    await assert.rejects(() => command(`upsert_${entity}`, { [entity]: data }), { code });
    assert.deepEqual(store.board, before);
  }
  assert.equal(store.writes, 0);
});

test('edge updates validate both merged endpoints and reject self edges', async () => {
  const { command, store } = makeFixture();
  const before = structuredClone(store.board);
  for (const [patch, code] of [
    [{ from: 'missing' }, 'NODE_NOT_FOUND'],
    [{ from: 'n2' }, 'INVALID_INPUT'],
    [{ to: ' n1 ' }, 'INVALID_INPUT'],
  ]) {
    await assert.rejects(() => command('upsert_edge', { edge: { id: 'e1', ...patch } }), { code });
    assert.deepEqual(store.board, before);
  }
});

test('valid partial updates and reparenting preserve children and thread metadata', async () => {
  const { command, store } = makeFixture();
  const before = structuredClone(store.board);
  await command('upsert_task', { task: { id: 't1', title: 'Renamed' } });
  await command('upsert_todo', { todo: { id: 'd1', status: 'blocked' } });
  await command('upsert_edge', { edge: { id: 'e1', label: 'Updated' } });
  assert.equal(store.board.tasks[0].nodeId, 'n1');
  assert.equal(store.board.todos[0].taskId, 't1');
  assert.equal(store.board.edges[0].label, 'Updated');
  await command('upsert_task', { task: { id: 't1', nodeId: ' n2 ' } });
  await command('upsert_todo', { todo: { id: 'd1', taskId: ' t2 ' } });
  await command('upsert_edge', { edge: { id: 'e1', from: ' n2 ', to: ' n1 ' } });
  assert.equal(store.board.tasks[0].nodeId, 'n2');
  assert.equal(store.board.todos[0].taskId, 't2');
  assert.equal(store.board.todos[1].taskId, 't1');
  assert.deepEqual(store.board.tasks[0].threads, before.tasks[0].threads);
  assert.deepEqual(store.board.todos[0].threads, before.todos[0].threads);
  assert.deepEqual(store.board.notes, before.notes);
  assert.deepEqual(store.board.edges.map(({ from, to }) => [from, to]), [['n2', 'n1']]);
});

for (const kind of ['task', 'node']) {
  test(`delete_${kind} clears removed dependencies and descendant notes while preserving survivors`, async () => {
    const base = makeFixture().store.board;
    const { command } = makeFixture({
      tasks: [
        base.tasks[0],
        { ...base.tasks[1], blockedBy: ['t1', 't3', 't4'], threads: [{ sessionId: 'surviving-task' }] },
        { id: 't3', nodeId: 'n1', title: 'Sibling' },
        { id: 't4', nodeId: 'n2', title: 'Survivor', blockedBy: ['t1'] },
      ],
      todos: [...base.todos, { id: 'd3', taskId: 't3' }, { id: 'd4', taskId: 't2', threads: [{ sessionId: 'surviving-todo' }] }],
      notes: [
        ...base.notes,
        { id: 'm-t3', targetType: 'task', targetId: 't3', text: 'Sibling task note' },
        { id: 'm-d3', targetType: 'todo', targetId: 'd3', text: 'Sibling todo note' },
        { id: 'm-t2', targetType: 'task', targetId: 't2', text: 'Surviving task note' },
        { id: 'm-d4', targetType: 'todo', targetId: 'd4', text: 'Surviving todo note' },
      ],
      decisions: [{ id: 'q1', nodeId: 'n1', question: 'Deleted node?' }, { id: 'q2', nodeId: 'n2', question: 'Surviving node?' }],
    });
    const { board } = await command(`delete_${kind}`, { id: kind === 'node' ? 'n1' : 't1' });
    const removedNode = kind === 'node';
    assert.deepEqual(board.tasks.map(t => t.id), removedNode ? ['t2', 't4'] : ['t2', 't3', 't4']);
    assert.deepEqual(board.todos.map(t => t.id), removedNode ? ['d4'] : ['d3', 'd4']);
    assert.deepEqual(board.tasks.find(t => t.id === 't2').blockedBy, removedNode ? ['t4'] : ['t3', 't4']);
    assert.deepEqual(board.tasks.find(t => t.id === 't4').blockedBy, []);
    assert.deepEqual(board.notes.map(n => n.id), removedNode ? ['m-board', 'm-t2', 'm-d4'] : ['m-node', 'm-board', 'm-t3', 'm-d3', 'm-t2', 'm-d4']);
    assert.deepEqual(board.tasks.find(t => t.id === 't2').threads.map(t => t.sessionId), ['surviving-task']);
    assert.deepEqual(board.todos.find(t => t.id === 'd4').threads.map(t => t.sessionId), ['surviving-todo']);
    assert.equal(board.nodes.length, removedNode ? 1 : 2);
    assert.equal(board.edges.length, removedNode ? 0 : 1);
    assert.deepEqual(board.decisions.map(d => d.id), removedNode ? ['q2'] : ['q1', 'q2']);
  });
}

test('dispatch two sibling todos creates and binds two independent team tasks', async () => {
  const { dispatch, createdTasks } = makeFixture();
  const result = await dispatch([{ todoId: 'd1' }, { todoId: 'd2' }]);
  assert.equal(createdTasks.length, 2);
  assert.deepEqual(result.created, [
    { taskId: 't1', todoId: 'd1', teamTaskId: '1' },
    { taskId: 't1', todoId: 'd2', teamTaskId: '2' },
  ]);
  assert.equal(result.board.tasks[0].team, undefined);
  assert.deepEqual(result.board.todos.map(d => d.team.taskId), ['1', '2']);
  assert.deepEqual(result.board.todos.map(d => d.status), ['doing', 'doing']);
  assert.deepEqual(result.board.todos[0].threads.map(t => t.sessionId), ['todo-session']);
});

for (const parentFirst of [true, false]) {
  test(`dispatch parent and children independently with parent ${parentFirst ? 'first' : 'last'}`, async () => {
    const { dispatch, createdTasks } = makeFixture();
    const items = [{ todoId: 'd1' }, { todoId: 'd2' }];
    if (parentFirst) items.unshift({ taskId: 't1' });
    else items.push({ taskId: 't1' });
    const result = await dispatch([...items, ...items]);
    assert.equal(createdTasks.length, 3, 'duplicates are scoped to the exact task or todo');
    assert.equal(result.created.length, 3);
    assert.equal(new Set([result.board.tasks[0].team.taskId, ...result.board.todos.map(d => d.team.taskId)]).size, 3);
    const repeated = await dispatch(items);
    assert.equal(createdTasks.length, 3);
    assert.deepEqual(repeated.created, []);
    assert.deepEqual(repeated.board.tasks, result.board.tasks);
    assert.deepEqual(repeated.board.todos, result.board.todos);
  });
}

test('dispatching a sibling later keeps existing bindings and completed todo status', async () => {
  const base = makeFixture().store.board;
  const { dispatch, createdTasks } = makeFixture({ todos: [base.todos[0], { ...base.todos[1], status: 'done' }] });
  const first = await dispatch([{ todoId: 'd1' }]);
  const second = await dispatch([{ todoId: 'd2' }]);
  assert.equal(createdTasks.length, 2);
  assert.deepEqual(second.board.todos[0], first.board.todos[0]);
  assert.equal(second.board.todos[1].status, 'done');
  assert.equal(second.board.todos[1].team.taskId, '2');
  assert.equal(second.board.tasks[0].team, undefined);
});

test('control: concurrent commands with the same CAS revision commit exactly once', async () => {
  const { command, store, notifications } = makeFixture();
  const results = await Promise.allSettled([
    command('rename_board', { title: 'First' }, { expectedRevision: 10 }),
    command('rename_board', { title: 'Second' }, { expectedRevision: 10 }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'STALE_REVISION');
  assert.equal(store.board.revision, 11);
  assert.equal(store.writes, 1);
  assert.equal(notifications.length, 1);
});

test('control: append/replay/selective unbind preserve existing sessions and status', async () => {
  const { command } = makeFixture();
  const first = await command('bind_thread', { todoId: 'd1', sessionId: 'second' }, { commandId: 'bind-second', expectedRevision: 10 });
  const replay = await command('bind_thread', { todoId: 'd1', sessionId: 'second' }, { commandId: 'bind-second', expectedRevision: 10 });
  assert.equal(replay.replayed, true);
  assert.deepEqual(first.board, replay.board);
  const result = await command('unbind_thread', { todoId: 'd1', sessionId: 'second' });
  assert.deepEqual(result.board.todos[0].threads.map(t => t.sessionId), ['todo-session']);
  assert.equal(result.board.todos[0].status, 'todo');
  assert.deepEqual(result.board.tasks[0].threads.map(t => t.sessionId), ['task-session']);
});
