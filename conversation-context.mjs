// 关联任务背景只在真实步骤进入时写入机器消息；宿主卸载即移除 hook。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { pbSessionConversationContext } from './board-model.js';

const KIND = 'project-board-task-context';
const VERSION = 1;
const SECTION = 'project-board-task-context';
const CLEAR_TEXT = '当前会话已解除全部任务/待办关联，先前自动提供的任务背景不再作为当前关联要求。沿用会话历史与用户最新明确指令；解除关联本身不启动任何工作。';
const DELTA_HEADER = '关联任务背景更新（仅列变更）。以下为行差异：以“-”开头的行已删除或被替换，不再作为当前要求；以“+”开头的行为新增内容。未列出的必要背景沿用，以用户最新明确指令为准。';
const digest = text => createHash('sha256').update(text).digest('hex');

// 默认从宿主入口解析；Lead 可传入 index.mjs 已有的 runtimeModule，测试传内存 loader。
async function loadRuntimeModule(specifier) {
  for (const owner of [process.argv[1] && path.resolve(process.argv[1]), import.meta.url]) {
    if (!owner) continue;
    let resolved;
    try { resolved = createRequire(owner).resolve(specifier); } catch { continue; }
    return import(pathToFileURL(resolved).href);
  }
  throw new Error(`无法从宿主解析 ${specifier}`);
}

function positionsOf(lines) {
  const result = new Map();
  for (let i = 0; i < lines.length; ++i) {
    const positions = result.get(lines[i]);
    if (positions) positions.push(i); else result.set(lines[i], [i]);
  }
  return result;
}

function nextPosition(positions, from) {
  if (!positions) return -1;
  let lo = 0, hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] < from) lo = mid + 1; else hi = mid;
  }
  return lo < positions.length ? positions[lo] : -1;
}

// 贪心对齐共同的行，复杂度受有界投影限制；多个远隔修改不会带回中间未变全文。
function lineChanges(before, after) {
  const oldLines = before.split('\n'), newLines = after.split('\n');
  const oldPositions = positionsOf(oldLines), newPositions = positionsOf(newLines);
  const changes = [];
  let i = 0, j = 0, pending;
  const begin = () => pending ||= { oldStart: i + 1, newStart: j + 1, removed: [], added: [] };
  const flush = () => { if (pending) { changes.push(pending); pending = undefined; } };
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      flush(); ++i; ++j; continue;
    }
    if (i === oldLines.length) { begin().added.push(newLines[j++]); continue; }
    if (j === newLines.length) { begin().removed.push(oldLines[i++]); continue; }
    const nextNew = nextPosition(newPositions.get(oldLines[i]), j);
    const nextOld = nextPosition(oldPositions.get(newLines[j]), i);
    if (nextNew < 0 && nextOld < 0) {
      begin().removed.push(oldLines[i++]); begin().added.push(newLines[j++]);
    } else if (nextNew >= 0 && (nextOld < 0 || nextNew - j <= nextOld - i)) {
      const change = begin();
      while (j < nextNew) change.added.push(newLines[j++]);
    } else {
      const change = begin();
      while (i < nextOld) change.removed.push(oldLines[i++]);
    }
  }
  flush();
  return changes;
}

function deltaText(before, after) {
  const rows = [DELTA_HEADER];
  for (const change of lineChanges(before, after)) {
    rows.push(`@@ -${change.oldStart},${change.removed.length} +${change.newStart},${change.added.length} @@`);
    for (const line of change.removed) rows.push('- ' + line);
    for (const line of change.added) rows.push('+ ' + line);
  }
  return rows.join('\n');
}

function hasExactText(message, text) {
  return message.content?.length === 1 && message.content[0].type === 'text' && message.content[0].text === text;
}

// source 的投影用于恢复比较；只有模型实际可见的 full + 连续 delta 才算可用背景。
// compaction/内容投影可能保留 source 却移除正文，因此不能只比较最新 source.digest。
function visibleState(messages) {
  let state;
  for (const message of messages) {
    const source = message.source;
    if (message.role !== 'user' || source?.kind !== KIND) continue;
    if (source.version !== VERSION || typeof source.projection !== 'string' || source.digest !== digest(source.projection)) {
      state = { text: null, visible: false }; continue;
    }
    const text = source.projection;
    let visible = false;
    if (source.update === 'full') {
      visible = text !== '' && source.form === 'snapshot'
        && source.sections?.length === 1 && source.sections[0].name === SECTION
        && source.sections[0].text === text && hasExactText(message, text);
    } else if (source.update === 'clear') {
      visible = text === '' && source.form === 'notice' && hasExactText(message, CLEAR_TEXT);
    } else if (source.update === 'delta' && state?.visible && state.text) {
      visible = source.form === 'notice' && source.baseDigest === digest(state.text)
        && hasExactText(message, deltaText(state.text, text));
    }
    state = { text, visible };
  }
  return state;
}

function messageFor(createUserMessage, text, previous) {
  const base = { kind: KIND, version: VERSION, projection: text, digest: digest(text) };
  if (!text) return createUserMessage({
    content: [{ type: 'text', text: CLEAR_TEXT }],
    source: { ...base, update: 'clear', form: 'notice', summary: '已解除当前会话的全部任务/待办关联' },
  });
  if (previous?.visible && previous.text) return createUserMessage({
    content: [{ type: 'text', text: deltaText(previous.text, text) }],
    source: { ...base, update: 'delta', baseDigest: digest(previous.text), form: 'notice', summary: '关联任务背景已更新：仅提供变更与删除内容' },
  });
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...base, update: 'full', form: 'snapshot', sections: [{ name: SECTION, text }] },
  });
}

/**
 * Lead 接线：await installBoardConversationContext(ctx, {
 *   readBoardForAgent: agent => readNormalizedBoardCacheForAgent(agent), runtimeModule,
 * });
 * readBoardForAgent(agent) 可同步/异步返回当前规范化 board 或 null；null 代表当前无看板。
 * 不自行读取文件、刷新看板、打开会话或唤醒模型。返回值是 ctx.effect 管理的卸载函数。
 * 已发基线只从 session.deriveMessages() 和此次实际 decision.messages 恢复，无进程缓存。
 */
export async function installBoardConversationContext(ctx, { readBoardForAgent, runtimeModule = loadRuntimeModule } = {}) {
  if (typeof readBoardForAgent !== 'function') throw new TypeError('readBoardForAgent 必须是函数');
  // 仅注册、拒绝进入或投影未变时不解析 LLM 服务，便于宿主按需挂载依赖。
  let messageFactory;
  const loadMessageFactory = () => messageFactory ||= Promise.resolve()
    .then(() => runtimeModule('@deepseek-ai/dsh-llm'))
    .then(module => {
      if (typeof module.createUserMessage !== 'function') throw new TypeError('runtime loader 必须提供 createUserMessage');
      return module.createUserMessage;
    })
    .catch(error => { messageFactory = undefined; throw error; });
  let disposed = false;
  return ctx.effect(() => {
    const off = ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      if (disposed || decision.kind === 'reject' || decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
      signal.throwIfAborted();
      let board;
      try { board = await readBoardForAgent(agent); } catch (error) {
        signal.throwIfAborted();
        ctx.logger?.warn?.(`project-board task context read failed: ${error?.message || error}`);
        return decision;
      }
      signal.throwIfAborted();
      if (disposed) return decision;
      const text = pbSessionConversationContext(board, agent.id);
      const previous = visibleState([...agent.session.deriveMessages(), ...decision.messages]);
      if ((!text && !previous) || (previous?.visible && previous.text === text)) return decision;
      const createUserMessage = await loadMessageFactory();
      signal.throwIfAborted();
      if (disposed) return decision;
      const desired = messageFor(createUserMessage, text, previous);
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message));
      return { ...decision, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired) };
    });
    return () => { disposed = true; if (typeof off === 'function') off(); };
  }, 'project-board conversation context');
}
