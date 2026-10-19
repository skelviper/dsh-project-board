// 任务和待办共用原位会话菜单；弹层挂在 body，避免被任务卡片和滚动区裁切。
function pbThreadsOf(item) {
  if (Array.isArray(item?.threads)) return item.threads;
  return item?.thread?.sessionId ? [item.thread] : [];
}

function pbThreadTitle(row, index, sessionsSnapshot) {
  const summary = sessionsSnapshot?.byId?.[row.sessionId];
  return row.title || (!summary?.blank && summary?.title) || `会话 ${index + 1}`;
}

function PbConversationMenu({ item, parentTask, targetType, sessionsSnapshot, selectedSessionId, onSelect, onCreate, onRemove, compact = false }) {
  const { threads, inherited } = pbConversationThreads(item, parentTask);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [position, setPosition] = React.useState({ left: 0, top: 0, maxHeight: 400 });
  const anchorRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const menuOpenerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const label = targetType === 'task' ? '任务会话' : '待办会话';
  const currentIndex = threads.findIndex((row) => row.sessionId === selectedSessionId);
  const current = currentIndex >= 0 ? threads[currentIndex] : null;

  const placeMenu = React.useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(328, window.innerWidth - 16);
    const height = Math.min(408, (menuRef.current?.scrollHeight || 130), window.innerHeight - 16);
    const top = rect.bottom + 6 + height <= window.innerHeight - 8
      ? rect.bottom + 6 : Math.max(8, rect.top - 6 - height);
    setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top, width, maxHeight: window.innerHeight - top - 8 });
  }, []);

  React.useLayoutEffect(() => { if (open) placeMenu(); }, [open, threads.length, error, placeMenu]);
  React.useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!anchorRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); (menuOpenerRef.current || triggerRef.current)?.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = [...(menuRef.current?.querySelectorAll('[role="menuitemradio"], [role="menuitem"]') || [])].filter((button) => !button.disabled);
        if (!buttons.length) return;
        event.preventDefault(); event.stopPropagation();
        const at = buttons.indexOf(document.activeElement);
        const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next].focus();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
    };
  }, [open, placeMenu]);

  async function act(action, closeAfter = true) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); if (closeAfter) setOpen(false); }
    catch (err) { setError(err.message || '操作失败'); setOpen(true); }
    finally { setBusy(false); }
  }

  function toggleMenu(event) {
    menuOpenerRef.current = event.currentTarget;
    setError(''); setOpen((value) => !value);
  }

  const menu = open ? createPortal(h('div', {
    ref: menuRef, className: 'pb-thread-menu', role: 'menu', 'aria-label': label,
    style: position, onClick: (event) => event.stopPropagation(),
  },
    h('div', { className: 'pb-thread-menu-heading' }, inherited ? label + ' · 来自所属任务' : label),
    threads.length ? threads.map((row, index) => h('div', { key: row.sessionId, className: 'pb-thread-menu-line' },
      h('button', {
        type: 'button', className: 'pb-thread-menu-choice', role: 'menuitemradio',
        'aria-checked': row.sessionId === selectedSessionId, 'data-session-id': row.sessionId,
        disabled: busy, onClick: () => act(() => onSelect(row.sessionId)),
      },
        h(PbIcon, { name: 'chat', size: 13 }),
        h('span', { className: 'pb-thread-menu-text' },
          h('span', { className: 'pb-thread-menu-title' }, pbThreadTitle(row, index, sessionsSnapshot)),
          h('span', { className: 'pb-thread-menu-sub' }, pbFormatTime(row.createdAt))),
        row.sessionId === selectedSessionId ? h(PbIcon, { name: 'check', size: 13 }) : null),
      !inherited ? h('button', {
        type: 'button', className: 'pb-thread-menu-remove', title: '移除会话关联', 'aria-label': `移除会话关联：${pbThreadTitle(row, index, sessionsSnapshot)}`,
        disabled: busy, onClick: () => act(() => onRemove(row.sessionId), false),
      }, h(PbIcon, { name: 'trash', size: 13 })) : null
    )) : h('div', { className: 'pb-thread-menu-empty' }, '还没有会话'),
    h('button', { type: 'button', role: 'menuitem', className: 'pb-thread-menu-create', disabled: busy, onClick: () => act(onCreate) },
      h(PbIcon, { name: 'plus', size: 13 }), busy ? '处理中…' : '新建会话'),
    error ? h('div', { className: 'pb-thread-menu-error', role: 'alert' }, error) : null
  ), document.body) : null;

  return h('span', { ref: anchorRef, className: 'pb-conversation-anchor', onClick: (event) => event.stopPropagation(), 'data-thread-target': `${targetType}:${item.id}` },
    h('button', {
      ref: triggerRef, type: 'button', className: 'pb-conversation-trigger' + (open ? ' open' : ''), disabled: busy,
      title: threads.length === 1 ? (inherited ? '打开所属任务会话' : '打开已有会话') : label,
      'aria-label': label, 'aria-haspopup': threads.length === 1 ? undefined : 'menu', 'aria-expanded': threads.length === 1 ? undefined : open,
      onClick: (event) => {
        if (threads.length === 1) return act(() => onSelect(threads[0].sessionId));
        toggleMenu(event);
      },
    }, h(PbIcon, { name: 'chat', size: 12 }),
      h('span', null, compact || !current ? '会话' : pbThreadTitle(current, currentIndex, sessionsSnapshot))),
    h('button', {
      type: 'button', className: 'pb-conversation-options' + (open ? ' open' : ''), disabled: busy,
      title: '选择或管理会话', 'aria-label': '管理' + label, 'aria-haspopup': 'menu', 'aria-expanded': open,
      onClick: toggleMenu,
    }, h(PbIcon, { name: 'chevronDown', size: 11 })),
    menu);
}

// 只在看板内接管原生文件预览，主会话保持自身的侧边栏行为。
const PbFilePreviewContext = React.createContext(null);

// 以 DSH 的公开 Factory 渲染原生会话；历史、草稿、附件和队列都属于同一 Session。
function PbBoardConversationView(props) {
  return props.renderSlot('conversation.session', { view: 'chat' });
}

function PbNativeConversationSlot(props) {
  const session = props.useSession((value) => value);
  return props.renderFactorySlot('conversation.content', {
    variant: 'embedded', phase: session.openState === 'loading' ? 'settling' : 'active', hero: false,
  }, { slots: { views: PbBoardConversationView } });
}

function PbEmbeddedConversation({ sessionId, workspacePath, workspaceFiles, initialPrompt, acquireConversationSession, initializeDraft, SessionProvider, renderSlot }) {
  const [loaded, setLoaded] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const openFile = React.useCallback(async (path, options) => {
    setPreview({ sessionId, workspacePath, row: { path, kind: 'file', line: options?.line } });
  }, [sessionId, workspacePath]);
  const [retry, setRetry] = React.useState(0);
  const promptRef = React.useRef(initialPrompt);
  promptRef.current = initialPrompt;
  React.useEffect(() => {
    if (!sessionId) return undefined;
    let active = true;
    let reference;
    setLoaded(null);
    (async () => {
      try {
        reference = await acquireConversationSession(sessionId);
        if (!active) { reference.release(); return; }
        const binding = await reference.ready;
        if (!active) return;
        // 默认保留已有原生文字、引用和附件；只为空草稿补充任务背景。
        if (promptRef.current) initializeDraft(binding, promptRef.current);
        setLoaded({ sessionId, reference });
      } catch (error) {
        if (active) setLoaded({ sessionId, error: error.message || String(error) });
      }
    })();
    return () => { active = false; reference?.release(); };
  }, [sessionId, acquireConversationSession, initializeDraft, retry]);

  if (!sessionId) return null;
  const current = loaded?.sessionId === sessionId ? loaded : null;
  return h('div', { className: 'pb-native-conversation', 'data-native-session-id': sessionId },
    current?.error ? h('div', { className: 'pb-conversation-error', role: 'alert' }, '读取会话失败：' + current.error,
      h('button', { type: 'button', className: 'pb-btn small', onClick: () => setRetry((value) => value + 1) }, '重试载入'))
      : current?.reference ? h(PbFilePreviewContext.Provider, { value: openFile },
        h(SessionProvider, { session: current.reference }, renderSlot('project-board.conversation', {})))
      : h('div', { className: 'pb-empty' }, '正在载入会话…'),
    preview?.sessionId === sessionId && preview.workspacePath === workspacePath ? h(PbArtifactViewer, {
      key: workspacePath + ':' + sessionId + ':' + preview.row.path + ':' + (preview.row.line || 1),
      workspacePath, sessionId, workspaceFiles, row: preview.row, onClose: () => setPreview(null),
    }) : null);
}

// 当前会话由父组件持有；原生输入框直接保留草稿和附件，完整会话仅导航到同一 ID。
function PbConversationDrawer({ board, workspacePath, workspaceFiles, item, task, node, targetType, sessionId, sessionsSnapshot, onClose, onOpenSession, onSelectThread, onCreateThread, onRemoveThread, runCommand, onOpenArtifact, acquireConversationSession, initializeDraft, SessionProvider, renderSlot }) {
  const [error, setError] = React.useState('');
  const [opening, setOpening] = React.useState(false);
  const label = targetType === 'task' ? '任务' : '待办';
  const context = pbTaskConversationContext(board, item, targetType);
  const notes = board.notes.filter((row) => row.targetType === targetType && row.targetId === item.id);
  const parentTask = targetType === 'todo' ? task : null;
  const { inherited } = pbConversationThreads(item, parentTask);

  async function openFullSession() {
    if (!sessionId || opening) return;
    setOpening(true); setError('');
    try { await onOpenSession(sessionId); }
    catch (err) { setError('打开完整会话失败：' + err.message); }
    finally { setOpening(false); }
  }

  const menuProps = {
    item, parentTask, targetType, sessionsSnapshot, selectedSessionId: sessionId,
    onSelect: (id) => onSelectThread(targetType, item.id, id),
    onCreate: () => onCreateThread(targetType, item.id),
    onRemove: (id) => onRemoveThread(targetType, item.id, id),
  };

  return h('section', { className: 'pb-drawer', 'aria-label': label + '会话', 'data-conversation-target': `${targetType}:${item.id}`, 'data-session-id': sessionId || '' },
    h('div', { className: 'pb-drawer-head' },
      h('div', { className: 'pb-conversation-heading' },
        h('h2', { className: 'pb-drawer-title' }, item.title),
        h('div', { className: 'pb-conversation-meta' },
          h('span', { className: 'pb-chip' }, label),
          h('span', { className: 'pb-chip' }, (PB_STATUS_META[item.status] || PB_STATUS_META.todo).label),
          inherited ? h('span', { className: 'pb-chip' }, '所属任务会话') : null,
          node ? h('span', { className: 'pb-chip' }, node.title) : null,
          targetType === 'todo' && task ? h('span', { className: 'pb-chip' }, task.title) : null),
        h('div', { className: 'pb-conversation-controls' }, h(PbConversationMenu, menuProps)),
        h('details', { className: 'pb-context' },
          h('summary', null, '已关联当前' + label + '上下文'),
          h('pre', null, context))),
      h('button', { type: 'button', className: 'pb-icon-btn', title: '返回任务列表', 'aria-label': '返回任务列表', onClick: onClose }, h(PbIcon, { name: 'close', size: 16 }))),
    sessionId ? h(PbEmbeddedConversation, {
      key: sessionId, sessionId, workspacePath, workspaceFiles, initialPrompt: inherited ? undefined : pbTaskConversationDraft(context),
      acquireConversationSession, initializeDraft, SessionProvider, renderSlot,
    }) : h('div', { className: 'pb-conversation-start' },
      h('div', { className: 'pb-empty' }, '新建会话后会带上当前' + label + '背景，可直接输入或上传文件。'),
      h('button', { type: 'button', className: 'pb-btn primary', onClick: () => onCreateThread(targetType, item.id).catch((err) => setError(err.message)) }, '新建会话')),
    h('div', { className: 'pb-drawer-foot' },
      error ? h('div', { className: 'pb-conversation-error', role: 'alert' }, error) : null,
      h('details', { className: 'pb-context' }, h('summary', null, '交付与验收' + (pbDeliveryLabel(item) ? ' · ' + pbDeliveryLabel(item) : '')), h(PbDeliveryEditor, { key: targetType + ':' + item.id, item, targetType, runCommand, onOpenArtifact })),
      h('div', { className: 'pb-drawer-actions' },
        h('button', { type: 'button', className: 'pb-btn', disabled: !sessionId || opening, onClick: openFullSession }, opening ? '正在打开…' : '打开完整会话'),
        h('button', { type: 'button', className: 'pb-btn', onClick: () => runCommand(targetType === 'task' ? 'upsert_task' : 'upsert_todo', { [targetType]: { id: item.id, status: item.status === 'done' ? 'todo' : 'done' } }) }, item.status === 'done' ? '重新打开' : '标记完成'),
        h('button', { type: 'button', className: 'pb-btn danger', onClick: () => { if (window.confirm(`删除这个${label}？${targetType === 'task' ? '关联待办会一并删除；' : ''}会话记录会保留。`)) void runCommand(targetType === 'task' ? 'delete_task' : 'delete_todo', { id: item.id }); } }, '删除' + label)),
      notes.length ? h('details', { className: 'pb-context pb-context-notes' },
        h('summary', null, '条目备注（' + notes.length + '）'),
        ...notes.map((row) => h('div', { key: row.id, className: 'pb-row' }, h('div', { className: 'pb-row-text' }, h(PbExpandableText, { text: row.text })),
          h('button', { type: 'button', className: 'pb-icon-btn', title: '删除备注', onClick: () => runCommand('delete_note', { id: row.id }) }, h(PbIcon, { name: 'trash', size: 12 }))))
      ) : null,
      h('details', { className: 'pb-context' }, h('summary', null, '条目变更历史'), h(PbChangeHistory, { key: targetType + ':' + item.id, board, targetType, targetId: item.id, onUndoChange: (changeId) => runCommand('undo_change', { changeId }, { throwOnError: true }) })),
      h(PbQuickAdd, { placeholder: '添加备注…（回车保存）', label: '加备注',
        onSubmit: (text) => runCommand('add_note', { targetType, targetId: item.id, text, author: '我' }) })));
}
