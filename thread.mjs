// Compact transcript builder for a todo's bound DSH session.
// Reads the durable session log through ctx.sessionQuery and extracts only the
// presentation-relevant events (user prompts, assistant text, tool calls/results).

const MAX_TEXT = 4000;
const MAX_ARGUMENTS = 1200;

function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text);
    if (block.type === 'image') parts.push('[图片]');
    if (block.type === 'file' && block.name) parts.push(`[文件 ${block.name}]`);
  }
  return parts.join('\n').trim();
}

function clip(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Convert one SessionLogSnapshot into a bounded transcript for the UI. */
export function transcriptFromSnapshot(snapshot, { limit = 200, startSeq = 0 } = {}) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const rows = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (Number.isFinite(startSeq) && Number.isFinite(event.seq) && event.seq < startSeq) continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const base = { seq: event.seq, time: event.time, type: event.type };
    if (event.type === 'user/message') {
      const sourceKind = data.source && typeof data.source === 'object' ? data.source.kind : undefined;
      // 维护通知保留机器来源，不能在紧凑记录中冒充真实用户提问。
      if (sourceKind !== 'user' && sourceKind !== 'goal' && sourceKind !== 'project-board-maintenance') continue;
      const text = textOf(data.content);
      if (text) rows.push(sourceKind === 'project-board-maintenance'
        ? { ...base, kind: 'note', sourceKind, text: clip(text, MAX_TEXT) }
        : { ...base, kind: 'user', text: clip(text, MAX_TEXT) });
    } else if (event.type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      const text = textOf(message.content);
      if (text) rows.push({ ...base, kind: 'assistant', text: clip(text, MAX_TEXT) });
      if (data.interrupted) rows.push({ ...base, kind: 'note', text: '（本轮回复被中断）' });
    } else if (event.type === 'tool/call') {
      rows.push({
        ...base,
        kind: 'tool-call',
        name: typeof data.name === 'string' ? data.name : 'tool',
        callId: typeof data.callId === 'string' ? data.callId : undefined,
        arguments: clip(typeof data.arguments === 'string' ? data.arguments : '', MAX_ARGUMENTS),
      });
    } else if (event.type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      rows.push({
        ...base,
        kind: 'tool-result',
        callId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
        isError: Boolean(message.isError || data.error),
        text: clip(textOf(message.content), MAX_TEXT),
        errorReason: data.error && typeof data.error.reason === 'string' ? clip(data.error.reason, 600) : '',
      });
    } else if (event.type === 'turn/end') {
      const reason = data.reason;
      if (reason && (reason.kind === 'aborted' || reason.kind === 'error')) {
        rows.push({ ...base, kind: 'note', text: `（回合异常结束：${reason.kind}）` });
      }
    }
  }
  const bounded = rows.slice(-Math.max(1, Math.min(1000, limit)));
  return {
    sessionId: snapshot?.session?.id,
    title: snapshot?.session?.title,
    cwd: snapshot?.session?.cwd,
    totalEvents: events.length,
    entries: bounded,
  };
}

/** Read one session log and return its compact transcript. */
export async function readThread(ctx, sessionId, options = {}) {
  if (!ctx.sessionQuery) throw new Error('session query is unavailable');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId is required');
  const snapshot = await readSnapshot(ctx, sessionId, options.signal);
  return transcriptFromSnapshot(snapshot, options);
}

async function readSnapshot(ctx, sessionId, signal) {
  const query = ctx.sessionQuery;
  if (typeof query.observeSession === 'function') {
    const observation = await query.observeSession(sessionId, { projectionMode: 'none', signal });
    try {
      const inherited = Number(observation.inheritedEventCount) || 0;
      return {
        session: observation.header,
        inheritedEventCount: inherited,
        events: Array.isArray(observation.events) ? observation.events.slice(inherited) : [],
      };
    } finally {
      try { observation[Symbol.dispose]?.(); } catch { /* ignore */ }
    }
  }
  return query.readSession(sessionId);
}
