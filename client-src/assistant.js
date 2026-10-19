// 看板 Lead 复用同一个原生 Session 的历史和输入区，支持附件与原生模型菜单。
function BoardAssistant({ board, workspacePath, workspaceFiles, workspaceInfo, runCommand, createSession, onOpenSession, acquireConversationSession, SessionProvider, renderSlot, isCurrentWorkspace }) {
  const sessionId = board.assistant?.sessionId;
  const [error, setError] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const autoTried = React.useRef('');
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const contextRef = React.useRef(null);
  if (!contextRef.current || contextRef.current.path !== workspacePath) contextRef.current = { path: workspacePath, pendingSession: null };
  const context = contextRef.current;
  if (context.board !== board) { context.board = board; context.boundSessionId = sessionId; }
  const isActive = () => mounted.current && contextRef.current === context && isCurrentWorkspace?.() !== false;
  function assertActive() { if (!isActive()) throw new Error('项目已切换，请在当前项目重试'); }

  async function ensureSession() {
    assertActive();
    if (context.boundSessionId) return context.boundSessionId;
    if (context.pendingSession) return context.pendingSession;
    if (!workspaceInfo?.workspaceId) throw new Error('当前项目还没有注册为 workspace');
    setCreating(true); setError('');
    const operation = (async () => {
      const requestedId = 'session-' + pbUuid();
      const created = await createSession(workspaceInfo.workspaceId, requestedId);
      assertActive();
      const id = typeof created === 'string' && created ? created : requestedId;
      const response = await runCommand('bind_assistant', { sessionId: id }, { throwOnError: true });
      assertActive();
      if (response?.board?.assistant?.sessionId !== id) throw new Error('看板 Lead 会话绑定失败，请重试');
      context.boundSessionId = id;
      return id;
    })();
    context.pendingSession = operation;
    try { return await operation; }
    finally {
      if (context.pendingSession === operation) context.pendingSession = null;
      if (isActive()) setCreating(false);
    }
  }

  function prepareSession() {
    return ensureSession().catch((err) => { if (isActive()) setError('创建看板 Lead 会话失败：' + err.message); });
  }

  React.useEffect(() => {
    if (sessionId || !workspaceInfo?.workspaceId || autoTried.current === workspacePath) return;
    autoTried.current = workspacePath;
    void prepareSession();
  }, [sessionId, workspacePath, workspaceInfo?.workspaceId]);

  return h('div', { className: 'pb-assistant' },
    h('div', { className: 'pb-assistant-head' },
      h('div', null,
        h('div', { className: 'pb-assistant-title' }, '看板 Lead'),
        h('div', { className: 'pb-assistant-sub' }, 'Agent Team Lead · 用自然语言调整这张看板')),
      h('span', { className: 'pb-spacer' }),
      sessionId ? h('button', { className: 'pb-btn small', onClick: async () => {
        if (!isActive()) return;
        try { await onOpenSession(sessionId); }
        catch (err) { if (isActive()) setError('打开完整会话失败：' + err.message); }
      } }, '完整会话') : null),
    error ? h('div', { className: 'pb-conversation-error', role: 'alert' }, error,
      !sessionId ? h('button', { className: 'pb-btn small', disabled: creating, onClick: prepareSession }, '重试创建') : null) : null,
    sessionId ? h(PbEmbeddedConversation, { key: workspacePath + ':' + sessionId, sessionId, workspacePath, workspaceFiles, acquireConversationSession, SessionProvider, renderSlot })
      : h('div', { className: 'pb-empty' }, creating ? '正在为这个看板创建 Lead 会话…' : '正在准备看板 Lead 会话…'));
}
