import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await Promise.all(['state.js', 'conversations.js', 'execution.js'].map(name => fs.readFile(new URL('../client-src/' + name, import.meta.url), 'utf8')))).join('\n');
const { pbItemExecution, pbThreadExecutionResult, pbExecutionVersion } = vm.runInNewContext(`(() => { ${source}; return { pbItemExecution, pbThreadExecutionResult, pbExecutionVersion }; })()`, { React: { createElement() {}, createContext: value => ({ value }) } });
const base = () => ({ tasks: [], todos: [] });
const task = { id: 'task', nodeId: 'fig1', status: 'doing', threads: [] };
const resolve = (board, item, sessions = { byId: {} }, statuses = new Map(), results = {}) => pbItemExecution(board, item, sessions, statuses, results);

test('任务 doing、已派发和 inactive 都不会单独变成运行中或可查看', () => {
  assert.equal(resolve(base(), task).kind, 'idle');
  const assigned = { ...task, team: { leadSessionId: 'lead', taskId: '1', status: 'in_progress' } };
  assert.equal(resolve(base(), assigned, { byId: { lead: { running: true } } }).kind, 'idle');
  const linked = { ...task, threads: [{ sessionId: 'a' }] };
  const sessions = { byId: { a: { running: false, updatedAt: 20 } } };
  assert.equal(resolve(base(), linked, sessions).label, '待核实');
  assert.notEqual(resolve(base(), linked, sessions, new Map(), { a: { version: pbExecutionVersion(sessions.byId.a), state: 'paused' } }).kind, 'ready');
});

test('子待办运行优先于已有产物；停止后有回复才提示可查看', () => {
  const board = { tasks: [task], todos: [{ id: 'todo', taskId: 'task', status: 'done', threads: [{ sessionId: 'a' }], artifacts: [{ path: 'result.png' }] }] };
  const sessions = { byId: { a: { running: true, updatedAt: 20 } } };
  assert.equal(resolve(board, task, sessions).kind, 'running');
  sessions.byId.a = { running: false, updatedAt: 21 };
  const results = { a: { version: pbExecutionVersion(sessions.byId.a), state: 'reply' } };
  assert.equal(resolve(board, task, sessions, new Map(), results).kind, 'ready');
  assert.equal(resolve(board, board.todos[0], sessions, new Map(), results).kind, 'ready');
  results.a.state = 'stopped';
  assert.equal(resolve(board, task, sessions, new Map(), results).kind, 'stopped');
});

test('无产物的空会话、未完成源码链接及过期回复不冒充本轮交付', () => {
  const linked = { ...task, status: 'todo', threads: [{ sessionId: 'a' }], artifacts: [{ path: 'source/' }] };
  const sessions = { byId: { a: { running: false, updatedAt: 30 } } };
  assert.notEqual(resolve(base(), linked, sessions, new Map(), { a: { version: '20:false', state: 'reply' } }).kind, 'ready');
  assert.notEqual(resolve(base(), linked, sessions, new Map(), { a: { version: pbExecutionVersion(sessions.byId.a), state: 'empty' } }).kind, 'ready');
  assert.equal(resolve(base(), { ...linked, status: 'done' }, sessions).kind, 'ready');
});

test('同一 Team 的其他运行会话不会让未领取任务显示运行中', () => {
  const claimed = { ...task, team: { leadSessionId: 'lead', taskId: '1', status: 'pending' } };
  const projection = { members: [{ id: 'worker', name: 'worker' }], tasks: [{ id: '1', status: 'pending' }] };
  const sessions = { byId: { lead: { running: true }, worker: { running: true } }, projectionsBySession: { lead: { values: { agentTeam: projection } } } };
  assert.notEqual(resolve(base(), claimed, sessions).kind, 'running');
  projection.tasks[0] = { id: '1', status: 'in_progress', ownerName: 'worker' };
  assert.equal(resolve(base(), claimed, sessions).kind, 'running');
  sessions.byId.worker.running = false;
  assert.notEqual(resolve(base(), claimed, sessions).kind, 'running');
  projection.tasks[0].status = 'completed';
  assert.equal(resolve(base(), claimed, sessions).kind, 'ready');
});

test('会话空闲时仍显示其后台作业运行；无主作业不污染条目', () => {
  const linked = { ...task, threads: [{ sessionId: 'a' }] };
  const sessions = { byId: { a: { running: false, updatedAt: 10 } } };
  const jobs = { rows: { a: [{ id: 'job', owner: 'a', status: 'running', startedAt: 11 }] } };
  assert.equal(pbItemExecution(base(), linked, sessions, new Map(), {}, jobs).kind, 'running');
  jobs.rows.a[0] = { id: 'job', owner: 'a', status: 'completed', finishedAt: 12 };
  assert.equal(pbItemExecution(base(), linked, sessions, new Map(), {}, jobs).kind, 'ready');
  jobs.rows.a[0] = { id: 'job', owner: 'a', status: 'failed', finishedAt: 12 };
  assert.equal(pbItemExecution(base(), linked, sessions, new Map(), {}, jobs).kind, 'stopped');
  jobs.rows.a[0] = { id: 'unowned', status: 'running' };
  assert.notEqual(pbItemExecution(base(), linked, sessions, new Map(), {}, jobs).kind, 'running');
});

test('待回答提示覆盖运行提示；异常终态与普通空闲分开', () => {
  const linked = { ...task, threads: [{ sessionId: 'a' }] };
  assert.equal(resolve(base(), linked, { byId: { a: { running: true } } }, new Map([['a', { running: true, pendingInteraction: { kind: 'question' } }]])).kind, 'waiting');
  assert.equal(pbThreadExecutionResult([{ kind: 'assistant', text: 'result' }]), 'reply');
  assert.equal(pbThreadExecutionResult([{ kind: 'assistant', text: 'partial' }, { kind: 'note', text: '（本轮回复被中断）' }]), 'stopped');
  assert.equal(pbThreadExecutionResult([{ kind: 'note', text: '（回合异常结束：error）' }]), 'stopped');
  assert.equal(pbThreadExecutionResult([{ kind: 'user', text: 'continue' }]), 'paused');
});
