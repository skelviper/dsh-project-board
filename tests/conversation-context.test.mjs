// 真实注册接口配合内存 ctx/agent；不读取用户会话，不调用模型，不建立磁盘看板。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbSessionConversationContext } from '../board-model.js';
import { installBoardConversationContext } from '../conversation-context.mjs';

const KIND = 'project-board-task-context';
let messageId = 0;
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const createUserMessage = value => freeze(structuredClone({ ...value, role: 'user', id: `memory-${++messageId}` }));
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const textOf = message => message.content.map(block => block.text || '').join('\n');
const contexts = decision => decision.messages.filter(message => message.source.kind === KIND);
const oneContext = decision => { const rows = contexts(decision); assert.equal(rows.length, 1); return rows[0]; };
const noContexts = decision => assert.equal(contexts(decision).length, 0);

function boardFixture() {
  return {
    workspacePath: '/memory/project', revision: 1,
    nodes: [{ id: 'node-1', title: '关联节点', summary: '固定节点概览' }],
    tasks: [
      { id: 'task-a', nodeId: 'node-1', title: '本次任务', status: 'doing', acceptance: '首个验收要求\n保留中间要求\n末尾验收要求', writeScopes: ['allowed/file.js'], threads: [{ sessionId: 'session-a' }] },
      { id: 'unrelated', nodeId: 'node-1', title: '无关任务', status: 'todo', acceptance: '不要提供的无关要求', threads: [{ sessionId: 'session-b' }] },
    ],
    todos: [],
    notes: [{ id: 'global', targetType: 'board', targetId: '', text: '无关的长看板备注'.repeat(300) }],
  };
}

async function fixture(t, { board = boardFixture(), id = 'session-a', history = [], reader, loader } = {}) {
  let currentBoard = board;
  const hooks = new Set(), disposers = new Set(), warnings = [];
  const counts = { reads: 0, derives: 0, creates: 0, loads: 0 };
  const session = {
    header: { cwd: '/memory/project' }, history: structuredClone(history),
    deriveMessages() { ++counts.derives; return this.history.slice(); },
    eventAt() { throw new Error('禁用已弃用的 eventAt'); },
    snapshotEvents() { throw new Error('禁用已弃用的 snapshotEvents'); },
    get surface() { throw new Error('必须使用 deriveMessages'); },
  };
  const agent = {
    id, session,
    get ctx() { throw new Error('不能注册 agent.ctx 常驻 context'); },
    get inbox() { throw new Error('不应改动 inbox'); },
    followup() { throw new Error('不应启动后续模型调用'); },
  };
  const ctx = {
    on(name, callback) { assert.equal(name, 'agent/pre-step'); hooks.add(callback); return () => hooks.delete(callback); },
    effect(execute, label) {
      assert.equal(label, 'project-board conversation context');
      const cleanup = execute(); let active = true;
      const dispose = () => { if (active) { active = false; cleanup(); disposers.delete(dispose); } };
      disposers.add(dispose); return dispose;
    },
    logger: { warn: text => warnings.push(text) },
  };
  const options = {
    readBoardForAgent: async passed => { assert.equal(passed, agent); ++counts.reads; return reader ? reader(passed) : currentBoard; },
    runtimeModule: async specifier => {
      assert.equal(specifier, '@deepseek-ai/dsh-llm'); ++counts.loads;
      if (loader) return loader(specifier);
      return { createUserMessage: value => { ++counts.creates; return createUserMessage(value); } };
    },
  };
  let dispose = await installBoardConversationContext(ctx, options);
  t.after(() => { for (const cleanup of [...disposers]) cleanup(); });
  return {
    agent, session, ctx, counts, warnings, hooks,
    get board() { return currentBoard; }, setBoard(value) { currentBoard = value; },
    dispose: () => dispose(),
    async reload() { dispose(); dispose = await installBoardConversationContext(ctx, options); },
    async run({ claimed = [user('用户本次要求')], step = 1, decision = { kind: 'enter', messages: claimed }, signal = new AbortController().signal, next, commit = true } = {}) {
      const listeners = [...hooks]; let at = 0;
      const advance = () => at < listeners.length
        ? listeners[at++]({ agent, messages: claimed, step, turn: 1, signal }, advance)
        : next ? next() : Promise.resolve(decision);
      const result = await advance();
      if (commit && result.kind === 'enter') session.history.push(...result.messages);
      return result;
    },
  };
}

test('安装与打开无副作用；真实 next() 之后首发独立机器 snapshot，保留用户原消息', async t => {
  const f = await fixture(t);
  assert.equal(f.hooks.size, 1); assert.equal(f.counts.reads, 0); assert.equal(f.session.history.length, 0);
  const original = user('继续已有历史中的工作');
  let completedNext = false;
  const decision = await f.run({ claimed: [original], next: async () => { completedNext = true; return { kind: 'enter', messages: [original], startsRequestSeries: true }; } });
  assert.equal(completedNext, true); assert.equal(decision.messages[0], original); assert.equal(decision.startsRequestSeries, true);
  const context = oneContext(decision), expected = pbSessionConversationContext(f.board, f.agent.id);
  assert.equal(context.role, 'user'); assert.equal(context.source.kind, KIND); assert.equal(context.source.update, 'full');
  assert.equal(context.source.form, 'snapshot'); assert.deepEqual(context.source.sections, [{ name: KIND, text: expected }]);
  assert.equal(textOf(context), expected); assert.match(expected, /首个验收要求/); assert.match(expected, /allowed\/file\.js/);
  assert.doesNotMatch(expected, /不要提供的无关要求|无关的长看板备注/);
  assert.ok(Object.isFrozen(context)); assert.equal(f.counts.creates, 1);
});

test('旧会话保持已有历史和附件；只注入必要背景，不替换任何用户内容', async t => {
  const image = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '已确认的旧决定' }, { type: 'image', data: 'memory-only' }] });
  const f = await fixture(t, { history: [image] });
  const original = structuredClone(f.session.history);
  const context = oneContext(await f.run());
  assert.deepEqual(f.session.history.slice(0, 1), original); assert.match(textOf(context), /沿用本会话的历史、图片和已有决定/);
});

test('后续轮次、同轮后续步骤、无关看板 revision 变化均不重发背景', async t => {
  const f = await fixture(t); oneContext(await f.run());
  noContexts(await f.run()); noContexts(await f.run({ step: 2, claimed: [] }));
  f.board.revision += 1; f.board.tasks[1].acceptance = '无关的变化'; f.board.notes[0].text += '更多无关文字';
  noContexts(await f.run()); assert.equal(f.counts.creates, 1);
});

test('要求在多处修改时仅发变更行，明确删除旧要求，不重复中间要求或节点背景', async t => {
  const f = await fixture(t); oneContext(await f.run());
  f.board.tasks[0].acceptance = '新的首个要求\n保留中间要求\n新的末尾要求';
  const context = oneContext(await f.run());
  assert.equal(context.source.update, 'delta'); assert.equal(context.source.form, 'notice'); assert.ok(context.source.summary.length <= 120);
  const body = textOf(context);
  assert.match(body, /- 要求与验收: 首个验收要求/); assert.match(body, /\+ 要求与验收: 新的首个要求/);
  assert.match(body, /- 末尾验收要求/); assert.match(body, /\+ 新的末尾要求/); assert.match(body, /已删除或被替换/);
  assert.doesNotMatch(body, /保留中间要求|固定节点概览|workspace:/);
  assert.notEqual(context.source.baseDigest, context.source.digest); noContexts(await f.run());
});

test('删除验收、文件范围和备注时只提供显式删除，之后重载不重复', async t => {
  const f = await fixture(t); f.board.notes.push({ id: 'task-note', targetType: 'task', targetId: 'task-a', text: '需要移除的备注' });
  oneContext(await f.run()); delete f.board.tasks[0].acceptance; delete f.board.tasks[0].writeScopes; f.board.notes.pop();
  const context = oneContext(await f.run()), body = textOf(context);
  assert.equal(context.source.update, 'delta'); assert.match(body, /- 要求与验收:/); assert.match(body, /- 文件范围:/); assert.match(body, /- 条目备注: 需要移除的备注/);
  assert.doesNotMatch(body, /\+ /); await f.reload(); noContexts(await f.run());
});

test('首发和多条增量经过插件卸载及冷 session 恢复后仍可恢复基线', async t => {
  const f = await fixture(t); oneContext(await f.run());
  f.board.tasks[0].status = 'blocked'; assert.equal(oneContext(await f.run()).source.update, 'delta');
  f.board.tasks[0].acceptance = '恢复前的新要求'; assert.equal(oneContext(await f.run()).source.update, 'delta');
  await f.reload(); assert.equal(f.hooks.size, 1); noContexts(await f.run());
  const cold = await fixture(t, { board: structuredClone(f.board), history: JSON.parse(JSON.stringify(f.session.history)) });
  noContexts(await cold.run()); cold.board.tasks[0].status = 'doing';
  assert.equal(oneContext(await cold.run()).source.update, 'delta');
});

test('压缩移除 full 而保留最新 delta/source 时必须补发当前完整背景', async t => {
  const f = await fixture(t); const full = oneContext(await f.run());
  f.board.tasks[0].acceptance = '压缩前的最新要求'; const delta = oneContext(await f.run());
  assert.ok(delta.source.projection.includes('压缩前的最新要求'));
  f.session.history = f.session.history.filter(message => message.id !== full.id);
  await f.reload(); const repaired = oneContext(await f.run());
  assert.equal(repaired.source.update, 'full'); assert.equal(textOf(repaired), pbSessionConversationContext(f.board, f.agent.id));
  assert.match(textOf(repaired), /保留|本次任务/); noContexts(await f.run());
});

test('压缩清空上下文、保留元数据但正文被投影、丢失中间 delta 均补发 full', async t => {
  for (const mode of ['all', 'projected-full', 'projected-delta', 'missing-delta']) {
    const f = await fixture(t); const full = oneContext(await f.run());
    f.board.tasks[0].status = 'blocked'; const firstDelta = oneContext(await f.run());
    f.board.tasks[0].acceptance = '链末尾要求'; const lastDelta = oneContext(await f.run());
    if (mode === 'all') f.session.history = [user('压缩摘要')];
    if (mode === 'projected-full' || mode === 'projected-delta') {
      const target = mode === 'projected-full' ? full : lastDelta;
      f.session.history = f.session.history.map(message => message.id === target.id ? { ...message, content: [{ type: 'text', text: '正文已压缩' }] } : message);
    }
    if (mode === 'missing-delta') f.session.history = f.session.history.filter(message => message.id !== firstDelta.id);
    assert.equal(oneContext(await f.run()).source.update, 'full', mode); noContexts(await f.run());
  }
});

test('next 拒绝或剔除首步全部输入时不读取背景；下一次允许时仍首发', async t => {
  const f = await fixture(t), rejected = { kind: 'reject' }, empty = { kind: 'enter', messages: [] };
  assert.equal(await f.run({ decision: rejected }), rejected); assert.equal(await f.run({ decision: empty }), empty);
  assert.equal(f.counts.reads, 0); assert.equal(f.counts.derives, 0); assert.equal(f.counts.creates, 0);
  assert.equal(oneContext(await f.run()).source.update, 'full');
});

test('拒绝时不吞更新；准入后取消但未提交的 full/delta 也不推进持久基线', async t => {
  const f = await fixture(t);
  assert.equal(oneContext(await f.run({ commit: false })).source.update, 'full');
  assert.equal(oneContext(await f.run()).source.update, 'full');
  f.board.tasks[0].acceptance = '不能丢失的变更';
  assert.deepEqual(await f.run({ decision: { kind: 'reject' } }), { kind: 'reject' });
  assert.equal(oneContext(await f.run({ commit: false })).source.update, 'delta');
  assert.equal(oneContext(await f.run()).source.update, 'delta'); noContexts(await f.run());
});

test('只分析真实 decision.messages；下游已提供背景时不添加相同消息，其他上下文顺序保留', async t => {
  const f = await fixture(t), real = user('真实用户输入');
  const initial = await f.run({ claimed: [real], commit: false }), full = oneContext(initial);
  const other = createUserMessage({ content: [{ type: 'text', text: '其他插件内容' }], source: { kind: 'other-context' } });
  const decision = { kind: 'enter', messages: [real, full, other] };
  const unchanged = await f.run({ claimed: [real], decision });
  assert.equal(unchanged, decision); assert.equal(f.counts.creates, 1);
  f.board.tasks[0].status = 'blocked';
  const updated = await f.run({ claimed: [real], decision: { kind: 'enter', messages: [real, other], startsRequestSeries: true } });
  assert.equal(updated.messages[0], real); assert.equal(updated.messages[2], other); assert.equal(oneContext(updated).source.update, 'delta');
});

test('无看板和无关联均不首发；全部解绑时仅发送一次 clear，重新绑定重新 full', async t => {
  const f = await fixture(t, { board: null }); noContexts(await f.run());
  f.setBoard(boardFixture()); f.board.tasks[0].threads = []; noContexts(await f.run());
  f.board.tasks[0].threads = [{ sessionId: 'session-a' }]; assert.equal(oneContext(await f.run()).source.update, 'full');
  f.board.tasks[0].threads = []; const clear = oneContext(await f.run());
  assert.equal(clear.source.update, 'clear'); assert.equal(clear.source.form, 'notice'); assert.ok(clear.source.summary.length <= 120);
  assert.match(textOf(clear), /解除全部任务\/待办关联/); assert.equal(clear.source.projection, '');
  await f.reload(); noContexts(await f.run());
  f.board.tasks[0].threads = [{ sessionId: 'session-a' }]; assert.equal(oneContext(await f.run()).source.update, 'full');
  f.setBoard(null); assert.equal(oneContext(await f.run()).source.update, 'clear'); noContexts(await f.run());
});

test('clear 正文被压缩但旧背景仍在时，不能因空 projection 元数据漏掉解绑通知', async t => {
  const f = await fixture(t); oneContext(await f.run());
  f.board.tasks[0].threads = []; const clear = oneContext(await f.run());
  f.session.history = f.session.history.map(message => message.id === clear.id ? { ...message, content: [{ type: 'text', text: '旧解绑正文已被压缩' }] } : message);
  await f.reload(); assert.equal(oneContext(await f.run()).source.update, 'clear'); noContexts(await f.run());
});

test('任务和待办多重绑定逐项解除，只有最后一项解绑才 clear，旧单 thread 格式兼容', async t => {
  const f = await fixture(t); delete f.board.tasks[0].threads; f.board.tasks[0].thread = { sessionId: 'session-a' };
  f.board.todos = [{ id: 'todo-1', taskId: 'task-a', title: '关联待办', acceptance: '待办专属要求', threads: [{ sessionId: 'session-a' }] }];
  assert.match(textOf(oneContext(await f.run())), /待办专属要求/);
  delete f.board.tasks[0].thread; noContexts(await f.run());
  f.board.todos[0].threads = []; assert.equal(oneContext(await f.run()).source.update, 'clear');
  f.board.todos[0].threads = [{ sessionId: 'session-a' }]; assert.equal(oneContext(await f.run()).source.update, 'full');
});

test('绑定直接替换时撤销旧任务信息；不同会话的基线相互隔离', async t => {
  const f = await fixture(t); oneContext(await f.run());
  f.board.tasks[0].threads = []; f.board.tasks[1].threads = [{ sessionId: 'session-a' }];
  const context = oneContext(await f.run()); assert.equal(context.source.update, 'delta');
  assert.match(textOf(context), /- 任务: 本次任务/); assert.match(textOf(context), /\+ 任务: 无关任务/);
  const other = await fixture(t, { board: f.board, id: 'session-b' }); noContexts(await other.run());
  other.board.tasks[0].threads = [{ sessionId: 'session-b' }]; assert.equal(oneContext(await other.run()).source.update, 'full');
});

test('同步 provider 和异步 provider 都受支持；读取异常不当作解绑且之后可以重试', async t => {
  const f = await fixture(t); oneContext(await f.run());
  let failure = true;
  const g = await fixture(t, { board: f.board, history: f.session.history, reader: () => { if (failure) throw new Error('temporary read error'); return f.board; } });
  noContexts(await g.run()); assert.equal(g.warnings.length, 1);
  f.board.tasks[0].acceptance = '读取恢复后的新要求'; failure = false;
  assert.equal(oneContext(await g.run()).source.update, 'delta');
  const hooks = new Set(); let supplied;
  const ctx = { on: (name, fn) => { hooks.add(fn); return () => hooks.delete(fn); }, effect: fn => fn() };
  const dispose = await installBoardConversationContext(ctx, {
    readBoardForAgent: agent => { supplied = agent; return boardFixture(); },
    runtimeModule: async () => ({ createUserMessage }),
  });
  const signal = new AbortController().signal, message = user('同步 provider');
  const admitted = await [...hooks][0]({ agent: f.agent, messages: [message], step: 1, signal }, async () => ({ kind: 'enter', messages: [message] }));
  assert.equal(supplied, f.agent); noContexts(admitted); dispose();
});

test('取消与卸载发生在异步 reader 或 next 期间时，不提交也不遗留 agent context', async t => {
  for (const mode of ['abort', 'dispose']) {
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { entered = resolve; });
    const f = await fixture(t, { reader: () => { entered(); return waiting; } });
    const controller = new AbortController(), pending = f.run({ signal: controller.signal });
    await reading;
    if (mode === 'abort') controller.abort(new Error('cancelled')); else f.dispose();
    release(boardFixture());
    if (mode === 'abort') await assert.rejects(pending, /cancelled/); else noContexts(await pending);
    assert.equal(f.counts.creates, 0);
    assert.equal(f.session.history.filter(message => message.source.kind === KIND).length, 0);
  }
  let releaseNext;
  const nextWait = new Promise(resolve => { releaseNext = resolve; });
  const g = await fixture(t), request = user('卸载中的用户输入');
  const inflight = g.run({ claimed: [request], next: () => nextWait });
  g.dispose(); assert.equal(g.hooks.size, 0); releaseNext({ kind: 'enter', messages: [request] });
  noContexts(await inflight); assert.equal(g.counts.creates, 0); noContexts(await g.run());
});

test('重复行、插入、删除、重排和空行的增量可完整还原当前必要背景', async t => {
  const f = await fixture(t); let previous = textOf(oneContext(await f.run()));
  for (const acceptance of ['甲\n乙\n甲\n丙\n丁', '甲\n甲\n新增\n丁\n乙', '新增开头\n甲\n甲\n新增\n丁\n乙\n新增结尾', '\n\n重复\n\n重复\n', '重复\n重复\n', '独立最终要求']) {
    f.board.tasks[0].acceptance = acceptance;
    const delta = oneContext(await f.run()); assert.equal(delta.source.update, 'delta');
    const rows = textOf(delta).split('\n'), lines = previous.split('\n'); let offset = 0;
    for (let at = 1; at < rows.length;) {
      const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(rows[at++]); assert.ok(match);
      const removed = [], added = [];
      while (at < rows.length && !rows[at].startsWith('@@ ')) {
        const row = rows[at++];
        if (row.startsWith('- ')) removed.push(row.slice(2)); else { assert.ok(row.startsWith('+ ')); added.push(row.slice(2)); }
      }
      const start = Number(match[1]) - 1 + offset;
      assert.equal(Number(match[2]), removed.length); assert.equal(Number(match[4]), added.length); assert.equal(Number(match[3]) - 1, start);
      assert.deepEqual(lines.slice(start, start + removed.length), removed); lines.splice(start, removed.length, ...added); offset += added.length - removed.length;
    }
    const expected = pbSessionConversationContext(f.board, f.agent.id);
    assert.equal(lines.join('\n'), expected); previous = expected; noContexts(await f.run());
  }
});

test('大投影有界；内容相同的超长尾部变化不重发，可见投影变化发送行差异', async t => {
  const f = await fixture(t); f.board.tasks[0].acceptance = '必要要求'.repeat(3000);
  const full = oneContext(await f.run()); assert.ok(textOf(full).length < 11000);
  f.board.tasks[0].acceptance += '超出投影范围的新尾部'; noContexts(await f.run());
  f.board.tasks[0].acceptance = '新增开头\n' + f.board.tasks[0].acceptance;
  const delta = oneContext(await f.run()); assert.equal(delta.source.update, 'delta'); assert.match(textOf(delta), /\+ 要求与验收: 新增开头/);
  assert.ok(textOf(delta).length < 22000);
});

test('只注册、无关联、reject、空首步和可见投影未变时均不解析 LLM 服务', async t => {
  const f = await fixture(t, { board: null }); assert.equal(f.counts.loads, 0);
  noContexts(await f.run()); assert.equal(f.counts.loads, 0);
  f.setBoard(boardFixture()); await f.run({ decision: { kind: 'reject' } });
  await f.run({ decision: { kind: 'enter', messages: [] } }); assert.equal(f.counts.loads, 0);
  oneContext(await f.run()); assert.equal(f.counts.loads, 1); noContexts(await f.run()); assert.equal(f.counts.loads, 1);
  await f.reload(); noContexts(await f.run()); assert.equal(f.counts.loads, 1);
  f.board.tasks[0].status = 'done'; assert.equal(oneContext(await f.run()).source.update, 'delta'); assert.equal(f.counts.loads, 2);
});

test('必要 provider 缺失立即报错；懒加载消息接口失败不推进基线且可重试', async t => {
  await assert.rejects(installBoardConversationContext({}, {}), /readBoardForAgent/);
  let broken = true;
  const f = await fixture(t, { loader: () => broken ? {} : { createUserMessage } });
  assert.equal(f.counts.loads, 0); await assert.rejects(f.run(), /createUserMessage/); assert.equal(f.session.history.length, 0);
  broken = false; assert.equal(oneContext(await f.run()).source.update, 'full'); assert.equal(f.counts.loads, 2);
});
