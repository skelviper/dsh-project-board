// Main project-board panel: workspace selection, board loading, canvas/inspector wiring.
const PB_STORAGE_KEY = 'dsh.project-board.workspace.v1';

function pbUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'cmd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function PbModal({ title, children, onClose, actions }) {
  return h('div', { className: 'pb-modal-mask', onPointerDown: (event) => { if (event.target === event.currentTarget) onClose?.(); } },
    h('div', { className: 'pb-modal', role: 'dialog', 'aria-label': title },
      h('h3', null, title),
      children,
      h('div', { className: 'pb-modal-actions' }, ...(actions || []))));
}

// 维护控件的输入和重试由独立 fragment 管理，主面板负责项目作用域与写入队列。
function PbMaintenancePanel(props) {
  return h(PbMaintenancePanelBody, props);
}

function ProjectBoardPanel(props) {
  const { workspacesSource, sessionsSource, sessionStatusSource, layout, uiWorkspace, sessions, createSession } = props;
  const workspacesSnap = useObservableSource(workspacesSource);
  const sessionsSnap = useObservableSource(sessionsSource);
  const sessionStatuses = useObservableSource(sessionStatusSource);
  const workspaceItems = workspacesSnap.items || [];

  const [boardInfo, setBoardInfo] = React.useState(null);
  const [workspacePath, setWorkspacePath] = React.useState(() => {
    if (PB_PENDING_WORKSPACE) { const pending = PB_PENDING_WORKSPACE; PB_PENDING_WORKSPACE = ''; return pending; }
    try { return localStorage.getItem(PB_STORAGE_KEY) || ''; } catch { return ''; }
  });
  const [board, setBoard] = React.useState(null);
  const threadResults = useBoardThreadResults(board, sessionsSnap);
  const jobsSnapshot = useBoardJobs(board, sessionsSnap, props.jobs);
  const executionFor = (item) => pbItemExecution(board, item, sessionsSnap, sessionStatuses, threadResults, jobsSnapshot);
  const [exists, setExists] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [selectedNodeId, setSelectedNodeId] = React.useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = React.useState(null);
  const [taskFocus, setTaskFocus] = React.useState(null);
  const [conversation, setConversation] = React.useState(null);
  const [artifact, setArtifact] = React.useState(null);
  const [threadSelections, setThreadSelections] = React.useState(() => {
    try { const saved = JSON.parse(localStorage.getItem('dsh.project-board.threadSelections.v1') || '{}'); return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}; } catch { return {}; }
  });
  const pendingThreads = React.useRef(new Map());
  const boardRef = React.useRef(board);
  const canvasLayout = React.useRef(null);
  const workspaceScope = React.useRef({ path: workspacePath, loadId: 0, pendingCommands: 0, commands: Promise.resolve() });
  const scope = workspaceScope.current;
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrentWorkspace = () => mounted.current && workspaceScope.current === scope;
  const guardWorkspace = (callback) => (...args) => { if (isCurrentWorkspace()) return callback(...args); };
  function assertCurrentWorkspace() {
    if (!isCurrentWorkspace()) throw new Error('项目已切换，请在当前项目重试');
  }
  function applyBoard(next, nextExists = true) {
    if (!isCurrentWorkspace()) return false;
    // GET、命令和派发共享同一个 revision 下限，旧快照不能覆盖新写入。
    if (boardRef.current && (!next || next.revision < boardRef.current.revision)) return false;
    boardRef.current = next;
    setBoard(next); setExists(nextExists);
    return true;
  }
  const bodyRef = React.useRef(null);
  const dockRef = React.useRef(null);
  const [bodyWidth, setBodyWidth] = React.useState(0);
  const [connectMode, setConnectMode] = React.useState(false);
  const [connectSource, setConnectSource] = React.useState(null);
  const [connectKind, setConnectKind] = React.useState('contains');
  const [connectPending, setConnectPending] = React.useState(false);
  const connectionInFlight = React.useRef(false);
  const [view, setView] = React.useState({ x: 40, y: 60, scale: 1 });
  const [viewport, setViewport] = React.useState({ width: 0, height: 0 });
  const [nodeModal, setNodeModal] = React.useState(null);
  const [notice, setNotice] = React.useState('');
  const [viewMode, setViewMode] = React.useState('canvas');
  const [filters, setFilters] = React.useState({ query: '', branch: '', status: '', kind: '', outcome: '' });
  const [viewed, setViewed] = React.useState(() => pbReadLocal('dsh.project-board.viewed.v1', {}));
  const searchRows = pbSearchRows(board, filters);
  const hasFilters = Object.values(filters).some(Boolean);
  const matchNodeIds = hasFilters ? new Set(searchRows.map((row) => row.nodeId)) : null;
  const inboxRows = pbInboxRows(board, sessionsSnap, sessionStatuses);
  const workspaceSeen = viewed?.[workspacePath] || {};
  const unreadCount = inboxRows.filter((row) => workspaceSeen[row.id] !== row.version).length;
  function markViewed(row) {
    setViewed((current) => {
      const next = { ...current, [workspacePath]: { ...(current?.[workspacePath] || {}), [row.id]: row.version } };
      pbWriteLocal('dsh.project-board.viewed.v1', next); return next;
    });
  }
  React.useEffect(() => {
    if (workspacePath && fittedRef.current === workspacePath && isCurrentWorkspace()) pbWriteLocal('dsh.project-board.view.v2:' + workspacePath, view);
  }, [workspacePath, view]);
  const [rightTab, setRightTab] = React.useState('assistant');
  const [inspectorTab, setInspectorTab] = React.useState('overview');
  const [dockWidth, setDockWidth] = React.useState(() => {
    try { const saved = localStorage.getItem('dsh.project-board.dockWidth.v1'); const stored = Number(saved); if (saved !== null && Number.isFinite(stored) && stored >= 0) return stored; } catch { /* 浏览器禁用持久化时使用默认值 */ }
    return 400;
  });
  const dockDrag = React.useRef(null);
  const clampDock = React.useCallback((width) => Math.max(0, Math.min(width, Math.max(0, (bodyRef.current?.getBoundingClientRect().width || window.innerWidth) - 7))), []);
  const renderedDockWidth = bodyWidth ? Math.min(dockWidth, Math.max(0, bodyWidth - 7)) : dockWidth;
  const onDockResizeStart = (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    dockDrag.current = {
      startX: event.clientX, startWidth: dockRef.current?.getBoundingClientRect().width || renderedDockWidth,
      cursor: document.body.style.cursor, userSelect: document.body.style.userSelect,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  };
  const onDockResizeMove = (event) => {
    if (!dockDrag.current) return;
    setDockWidth(clampDock(dockDrag.current.startWidth + dockDrag.current.startX - event.clientX));
  };
  const onDockResizeEnd = (event) => {
    if (!dockDrag.current) return;
    document.body.style.cursor = dockDrag.current.cursor;
    document.body.style.userSelect = dockDrag.current.userSelect;
    dockDrag.current = null;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* 已释放 */ }
  };
  React.useEffect(() => {
    try { localStorage.setItem('dsh.project-board.dockWidth.v1', String(dockWidth)); } catch { /* 可继续拖动 */ }
  }, [dockWidth]);
  React.useEffect(() => {
    try { localStorage.setItem('dsh.project-board.threadSelections.v1', JSON.stringify(threadSelections)); } catch { /* 可继续切换 */ }
  }, [threadSelections]);
  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const resize = new ResizeObserver(() => setBodyWidth(el.getBoundingClientRect().width));
    resize.observe(el); setBodyWidth(el.getBoundingClientRect().width);
    return () => resize.disconnect();
  }, [Boolean(board)]);
  React.useEffect(() => () => {
    if (dockDrag.current) {
      document.body.style.cursor = dockDrag.current.cursor;
      document.body.style.userSelect = dockDrag.current.userSelect;
    }
  }, []);
  const pendingOpen = React.useRef(null);
  const fittedRef = React.useRef('');
  const changeWorkspace = React.useCallback((path) => {
    if (!mounted.current || workspaceScope.current.path === path) return;
    // 在 React 下一次渲染前使旧闭包失效；A→B→A 也不能复用第一次 A 的请求。
    workspaceScope.current = { path, loadId: 0, pendingCommands: 0, commands: Promise.resolve() };
    boardRef.current = null;
    pendingThreads.current = new Map();
    fittedRef.current = '';
    setWorkspacePath(path); setBoard(null); setExists(false); setLoading(Boolean(path));
    setBusy(false); setError(''); setNotice('');
    setSelectedNodeId(null); setSelectedEdgeId(null); setTaskFocus(null);
    setConversation(null); setArtifact(null); setNodeModal(null);
    connectionInFlight.current = false;
    setConnectMode(false); setConnectSource(null); setConnectPending(false); setConnectKind('contains');
    setRightTab('assistant'); setInspectorTab('overview');
    setView(pbWorkspaceView(path) || { x: 40, y: 60, scale: 1 });
    setFilters({ query: '', branch: '', status: '', kind: '', outcome: '' });
    setViewMode('canvas');
  }, []);

  const workspace = workspaceItems.find((row) => row.path === workspacePath);
  const workspaceInfo = boardInfo?.workspaces?.find((row) => row.path === workspacePath);
  const selectedNode = board && selectedNodeId ? board.nodes.find((row) => row.id === selectedNodeId) : null;
  const conversationItem = conversation && board ? (conversation.targetType === 'task' ? board.tasks : board.todos).find((row) => row.id === conversation.targetId) : null;
  const conversationTask = conversationItem && board ? (conversation.targetType === 'task' ? conversationItem : board.tasks.find((row) => row.id === conversationItem.taskId)) : null;
  const conversationNode = conversationTask && board ? board.nodes.find((row) => row.id === conversationTask.nodeId) : null;

  function selectedFor(targetType, item) {
    const parentTask = targetType === 'todo' ? boardRef.current?.tasks.find((task) => task.id === item.taskId) : null;
    const { threads: rows } = pbConversationThreads(item, parentTask);
    const remembered = threadSelections[workspacePath + ':' + targetType + ':' + item.id];
    return rows.some((row) => row.sessionId === remembered) ? remembered : rows[rows.length - 1]?.sessionId || null;
  }

  function selectThread(targetType, targetId, sessionId) {
    if (!isCurrentWorkspace()) return;
    const item = (targetType === 'task' ? boardRef.current?.tasks : boardRef.current?.todos)?.find((row) => row.id === targetId);
    const parentTask = targetType === 'todo' ? boardRef.current?.tasks.find((task) => task.id === item?.taskId) : null;
    if (!pbConversationThreads(item, parentTask).threads.some((row) => row.sessionId === sessionId)) throw new Error('会话关联已更新，请重新选择');
    setThreadSelections((value) => ({ ...value, [workspacePath + ':' + targetType + ':' + targetId]: sessionId }));
    setConversation({ targetType, targetId });
  }

  async function createThread(targetType, targetId) {
    assertCurrentWorkspace();
    const key = workspacePath + ':' + targetType + ':' + targetId;
    const pending = pendingThreads.current;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      if (!workspaceInfo?.workspaceId) throw new Error('当前项目还没有注册为 workspace');
      const requestedId = 'session-' + pbUuid();
      const id = await createSession(workspaceInfo.workspaceId, requestedId);
      assertCurrentWorkspace();
      const sessionId = typeof id === 'string' && id ? id : requestedId;
      const response = await runCommand('bind_thread', { [targetType === 'task' ? 'taskId' : 'todoId']: targetId, sessionId }, { throwOnError: true });
      const item = (targetType === 'task' ? response.board.tasks : response.board.todos).find((row) => row.id === targetId);
      if (!pbThreadsOf(item).some((row) => row.sessionId === sessionId)) throw new Error('会话未绑定到当前条目，请重试');
      assertCurrentWorkspace();
      selectThread(targetType, targetId, sessionId);
      return sessionId;
    })();
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }

  async function removeThread(targetType, targetId, sessionId) {
    assertCurrentWorkspace();
    const current = (targetType === 'task' ? boardRef.current?.tasks : boardRef.current?.todos)?.find((row) => row.id === targetId);
    if (!pbThreadsOf(current).some((row) => row.sessionId === sessionId)) throw new Error('请在所属任务中管理该会话关联');
    const response = await runCommand('unbind_thread', { [targetType === 'task' ? 'taskId' : 'todoId']: targetId, sessionId }, { throwOnError: true });
    assertCurrentWorkspace();
    const item = (targetType === 'task' ? response.board.tasks : response.board.todos).find((row) => row.id === targetId);
    setThreadSelections((value) => {
      const key = workspacePath + ':' + targetType + ':' + targetId;
      const selected = value[key];
      if (selected && selected !== sessionId) return value;
      const parentTask = targetType === 'todo' ? response.board.tasks.find((task) => task.id === item?.taskId) : null;
      const { threads: rows } = pbConversationThreads(item, parentTask);
      return { ...value, [key]: rows[rows.length - 1]?.sessionId || null };
    });
  }

  const threadUi = { selectedFor, select: selectThread, create: createThread, remove: removeThread };

  const loadWorkspaceInfo = React.useCallback(async () => {
    try {
      const value = await pbFetchJson('/api/project-board/workspaces');
      setBoardInfo(value);
    } catch (err) {
      setError('读取 workspace 列表失败：' + err.message);
    }
  }, []);

  const loadBoard = React.useCallback(async (path, options = {}) => {
    if (!path || path !== scope.path || !isCurrentWorkspace()) return;
    const requestId = ++scope.loadId;
    const startingBoard = boardRef.current;
    const currentRequest = () => isCurrentWorkspace() && requestId === scope.loadId;
    setLoading(true);
    try {
      const value = await pbFetchJson('/api/project-board/state?' + pbWorkspaceQuery(path));
      if (!currentRequest() || !applyBoard(value.exists ? value.board : null, Boolean(value.exists))) return;
      if (options.keepSelection !== true) {
        setSelectedNodeId(null); setSelectedEdgeId(null); setTaskFocus(null); setConversation(null);
      }
      if (!options.keepError) setError('');
    } catch (err) {
      if (!currentRequest() || startingBoard !== boardRef.current) return;
      setError(err.code === 'WORKSPACE_NOT_REGISTERED' ? '这个目录还不是 DSH workspace：' + path : '读取看板失败：' + err.message);
    } finally { if (currentRequest()) setLoading(false); }
  }, [scope]);

  React.useEffect(() => { loadWorkspaceInfo(); }, [loadWorkspaceInfo]);

  React.useEffect(() => {
    if (!workspacePath && workspaceItems.length) {
      const stored = (() => { try { return localStorage.getItem(PB_STORAGE_KEY) || ''; } catch { return ''; } })();
      const preferred = workspaceItems.find((row) => row.path === stored) || workspaceItems.find((row) => boardInfo?.workspaces?.some((info) => info.path === row.path && info.hasBoard)) || workspaceItems[0];
      if (preferred) changeWorkspace(preferred.path);
    }
  }, [workspaceItems, workspacePath, boardInfo]);

  React.useEffect(() => {
    if (!workspacePath) return;
    try { localStorage.setItem(PB_STORAGE_KEY, workspacePath); } catch { /* ignore */ }
    loadBoard(workspacePath);
  }, [workspacePath, loadBoard]);

  React.useEffect(() => {
    if (!workspacePath) return undefined;
    let source;
    try {
      source = new EventSource('/api/project-board/events?' + pbWorkspaceQuery(workspacePath));
      let timer = null;
      source.addEventListener('board', () => {
        clearTimeout(timer);
        timer = setTimeout(() => loadBoard(workspacePath, { keepSelection: true }), 350);
      });
      return () => { clearTimeout(timer); source.close(); };
    } catch { return undefined; }
  }, [workspacePath, loadBoard]);

  React.useEffect(() => {
    if (board && viewport.width > 600 && viewport.height > 400 && fittedRef.current !== workspacePath) {
      fittedRef.current = workspacePath;
      const saved = pbWorkspaceView(workspacePath);
      if (saved) setView(saved); else fitView(board);
    }
  }, [board, viewport.width, viewport.height, workspacePath]);

  React.useEffect(() => {
    const onOpen = (event) => {
      const path = event.detail?.workspacePath;
      if (path && !connectionInFlight.current) { PB_PENDING_WORKSPACE = ''; pendingOpen.current = path; changeWorkspace(path); }
    };
    window.addEventListener(PB_EVENT, onOpen);
    if (PB_PENDING_WORKSPACE) { changeWorkspace(PB_PENDING_WORKSPACE); PB_PENDING_WORKSPACE = ''; }
    else if (pendingOpen.current) changeWorkspace(pendingOpen.current);
    return () => window.removeEventListener(PB_EVENT, onOpen);
  }, []);

  async function runCommand(action, input, options = {}) {
    if (!workspacePath || !isCurrentWorkspace()) {
      if (options.throwOnError) throw new Error('项目已切换，请在当前项目重试');
      return null;
    }
    ++scope.pendingCommands;
    setBusy(true); if (options.reportError !== false) setError('');
    // 同项目本地写入依次出队；revision 在真正发送时读取，避免快速拖动互相冲突。
    const operation = scope.commands.then(async () => {
      assertCurrentWorkspace();
      if (!boardRef.current && action !== 'create_board') throw new Error('该 workspace 还没有看板');
      if (action === '__dispatch_task' || action === '__dispatch_todo') {
        return dispatchItems(action === '__dispatch_task' ? [{ taskId: input.taskId }] : [{ todoId: input.todoId }]);
      }
      if (action === '__maintenance') {
        const response = await pbFetchJson('/api/project-board/maintenance', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, operation: input.operation, commandId: input.commandId || pbUuid(), roots: input.roots, message: input.message, conflictId: input.conflictId, choice: input.choice }),
        });
        assertCurrentWorkspace();
        if (!response?.board) throw new Error('维护未返回看板，请重试');
        applyBoard(response.board);
        return { ...response, board: boardRef.current };
      }
      async function execute(commandAction, commandInput) {
        assertCurrentWorkspace();
        const response = await pbFetchJson('/api/project-board/command', {
          method: 'POST',
          body: JSON.stringify({
            workspacePath,
            expectedRevision: options.skipRevisionCheck ? undefined : boardRef.current?.revision,
            commandId: pbUuid(),
            action: commandAction,
            input: commandInput || {},
          }),
        });
        assertCurrentWorkspace();
        if (!response?.board) throw new Error('保存未返回看板，请刷新后重试');
        applyBoard(response.board);
        if (commandAction === 'delete_todo' || commandAction === 'delete_task') setConversation((current) => current?.targetId === commandInput?.id ? null : current);
        if (commandAction === 'delete_node') setSelectedNodeId((current) => current === commandInput?.id ? null : current);
        if (commandAction === 'create_board') loadWorkspaceInfo();
        return { ...response, committedBoard: response.board, board: boardRef.current };
      }
      if (action === '__connect_nodes') {
        // 按出队后的最新看板规划；多个归属修复命令也作为同一队列项完成。
        const plan = pbPlanConnection(boardRef.current, input.source, input.target, input.kind);
        for (const command of plan.commands) await execute(command.action, command.input);
        return { board: boardRef.current, message: plan.message };
      }
      const response = await execute(action, input);
      if (options.fitAfter) setTimeout(guardWorkspace(() => fitView(boardRef.current)), 20);
      return response;
    }).catch(async (err) => {
      // 冲突后的刷新也属于当前队列项，后续本地写入须等待最新 revision。
      if (isCurrentWorkspace()) {
        if (options.reportError !== false) setError(err.message + (err.code === 'STALE_REVISION' ? '（已请求重载，请检查后重试）' : ''));
        if (err.code === 'STALE_REVISION' || err.code === 'BOARD_NOT_FOUND') await loadBoard(workspacePath, { keepSelection: true, keepError: true });
      }
      throw err;
    });
    // 失败不阻塞后续显式操作；外部版本冲突只重读，不自动重放写入。
    scope.commands = operation.catch(() => {});
    try {
      return await operation;
    } catch (err) {
      if (options.throwOnError) throw err;
      return null;
    } finally {
      --scope.pendingCommands;
      if (isCurrentWorkspace()) setBusy(scope.pendingCommands > 0);
    }
  }

  function runMaintenance(operation, input = {}) {
    return runCommand('__maintenance', { ...input, operation }, { throwOnError: true, reportError: false });
  }

  async function deleteEdge(id) {
    const response = await runCommand('delete_edge', { id }, { throwOnError: true });
    if (!response) throw new Error('删除连线未成功，请重试');
    assertCurrentWorkspace();
    setSelectedEdgeId((selected) => selected === id ? null : selected);
    return response;
  }

  async function dispatchItems(items) {
    assertCurrentWorkspace();
    let leadSessionId = boardRef.current?.assistant?.sessionId;
    if (!leadSessionId) {
      const candidates = Object.values(sessionsSnap.byId || {}).filter((summary) => summary.cwd === workspacePath && sessionsSnap.projectionsBySession?.[summary.id]?.values?.agentTeam);
      candidates.sort((a, b) => ((b.running ? 1 : 0) - (a.running ? 1 : 0)) || (b.updatedAt - a.updatedAt));
      leadSessionId = candidates[0]?.id;
    }
    if (!leadSessionId) throw new Error('该 workspace 还没有看板 Lead 会话；先在看板对话里创建它');
    const response = await pbFetchJson('/api/project-board/dispatch', {
      method: 'POST',
      body: JSON.stringify({ workspacePath, expectedRevision: boardRef.current?.revision, commandId: pbUuid(), leadSessionId, items }),
    });
    assertCurrentWorkspace();
    if (!response?.board) throw new Error('派发未返回看板，请刷新后重试');
    applyBoard(response.board);
    const count = response.created?.length || 0;
    setNotice(count ? `已派发 ${count} 项到 Agent Team` : '已是最新派发，无需重复派发');
    setTimeout(guardWorkspace(() => setNotice('')), 4000);
    return { ...response, board: boardRef.current };
  }

  function fitView(targetBoard) {
    if (!isCurrentWorkspace()) return;
    const currentLayout = canvasLayout.current?.board === (targetBoard || board) ? canvasLayout.current : null;
    const rows = currentLayout?.nodes || (targetBoard || board)?.nodes || [];
    if (!rows.length) { setView({ x: 60, y: 60, scale: 1 }); return; }
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const node of rows) {
      box.minX = Math.min(box.minX, node.x);
      box.minY = Math.min(box.minY, node.y);
      box.maxX = Math.max(box.maxX, node.x + pbCanvasNodeWidth(node));
      const extraRows = Math.max(0, (currentLayout?.previews.get(node.id)?.visible.length || 0) - 3);
      const height = ['figure', 'milestone', 'component'].includes(node.kind) && pbNodeTasks(targetBoard || board, node.id).length ? 176 + extraRows * 26 : 130;
      box.maxY = Math.max(box.maxY, node.y + height);
    }
    const width = Math.max(200, box.maxX - box.minX);
    const height = Math.max(160, box.maxY - box.minY);
    const scale = Math.max(0.3, Math.min(1.15, Math.min((viewport.width - 90) / width, (viewport.height - 90) / height)));
    const offsetX = Math.max(40, (viewport.width - width * scale) / 2);
    const offsetY = Math.max(40, (viewport.height - height * scale) / 2);
    setView({ x: offsetX - box.minX * scale, y: offsetY - box.minY * scale, scale });
  }

  function autoLayout() {
    if (!board || !isCurrentWorkspace()) return;
    const byId = new Map(board.nodes.map((node) => [node.id, node]));
    const themes = board.nodes.filter((node) => node.kind === 'theme');
    const childIds = new Set();
    const positions = [];
    themes.forEach((theme, index) => {
      const x = 60 + index * 320;
      positions.push({ id: theme.id, x, y: 60 });
      const children = board.edges.filter((edge) => edge.kind === 'contains' && edge.from === theme.id).map((edge) => byId.get(edge.to)).filter(Boolean);
      let y = 220;
      for (const child of children) {
        positions.push({ id: child.id, x: x + 30, y });
        childIds.add(child.id);
        y += ['figure', 'milestone', 'component'].includes(child.kind) && pbNodeTasks(board, child.id).length ? 196 : 150;
      }
    });
    let looseY = 220;
    const loose = board.nodes.filter((node) => !themes.includes(node) && !childIds.has(node.id));
    loose.forEach((node, index) => {
      const perRow = Math.max(1, Math.floor((viewport.width - 120) / 260));
      positions.push({ id: node.id, x: 60 + (index % perRow) * 270, y: looseY + Math.floor(index / perRow) * 160 });
    });
    runCommand('save_positions', { positions }, { fitAfter: true });
  }

  function openCanvasTask(nodeId, taskId) {
    if (!isCurrentWorkspace()) return;
    const current = boardRef.current;
    if (!current?.nodes.some((node) => node.id === nodeId)) return;
    if (taskId && !current.tasks.some((task) => task.id === taskId && task.nodeId === nodeId)) return;
    setSelectedNodeId(nodeId); setSelectedEdgeId(null); setConversation(null);
    setRightTab('inspector'); setInspectorTab('overview');
    setTaskFocus({ workspacePath, nodeId, taskId, requestId: pbUuid() });
    if (renderedDockWidth < 100) setDockWidth(clampDock(400));
  }

  async function onCreateNode({ title, kind, position }) {
    assertCurrentWorkspace();
    const fallback = { x: Math.round((viewport.width / 2 - view.x) / view.scale - 115), y: Math.round((viewport.height / 2 - view.y) / view.scale - 40) };
    const point = position || fallback;
    const response = await runCommand('upsert_node', { node: { title, kind, x: point.x, y: point.y, status: 'todo' } }, { throwOnError: true });
    if (response && isCurrentWorkspace()) setNodeModal((current) => current === nodeModal ? null : current);
    return response;
  }

  function cancelConnection() {
    if (!isCurrentWorkspace() || connectionInFlight.current) return;
    setConnectSource(null); setConnectMode(false);
  }

  React.useEffect(() => {
    if (!connectMode) return undefined;
    const cancel = (event) => {
      if (isCurrentWorkspace() && event.key === 'Escape' && !connectionInFlight.current) {
        event.preventDefault(); setConnectSource(null); setConnectMode(false);
      }
    };
    document.addEventListener('keydown', cancel);
    return () => document.removeEventListener('keydown', cancel);
  }, [connectMode, scope]);

  async function onConnectNode(nodeId) {
    if (!isCurrentWorkspace() || connectionInFlight.current || !connectMode) return;
    if (!connectSource) { setConnectSource(nodeId); setError(''); return; }
    if (connectSource === nodeId) { setConnectSource(null); return; }
    connectionInFlight.current = true; setConnectPending(true); setError('');
    try {
      const response = await runCommand('__connect_nodes', { source: connectSource, target: nodeId, kind: connectKind }, { throwOnError: true });
      assertCurrentWorkspace();
      setSelectedNodeId(nodeId); setSelectedEdgeId(null); setConversation(null); setTaskFocus(null);
      setRightTab('inspector'); setInspectorTab('overview');
      setNotice(response.message); setTimeout(guardWorkspace(() => setNotice('')), 4000);
      setConnectSource(null); setConnectMode(false);
    } catch (err) {
      if (isCurrentWorkspace()) setError(err.message || '连线保存失败，请重试');
    } finally {
      if (isCurrentWorkspace()) { connectionInFlight.current = false; setConnectPending(false); }
    }
  }

  function focusRow(row) {
    if (!isCurrentWorkspace()) return;
    const node = (canvasLayout.current?.nodes || boardRef.current?.nodes || []).find((node) => node.id === row.nodeId);
    if (node) {
      setViewMode('canvas');
      setView((value) => ({ ...value, x: viewport.width / 2 - (node.x + pbCanvasNodeWidth(node) / 2) * value.scale, y: viewport.height / 2 - (node.y + 75) * value.scale }));
      openCanvasTask(node.id, row.taskId);
    }
    if (row.kind === 'question' && row.targetId) {
      const item = (row.targetType === 'todo' ? boardRef.current.todos : boardRef.current.tasks).find((item) => item.id === row.targetId);
      if (item) { selectThread(row.targetType, item.id, row.sessionId); setConversation({ targetType: row.targetType, targetId: row.targetId }); }
    } else if (row.type === 'todo' || row.targetType === 'todo') setConversation({ targetType: 'todo', targetId: row.targetId || row.item.id });
    if (row.kind === 'decision') {
      setInspectorTab('history');
      if (!node) setRightTab('history');
      setTimeout(guardWorkspace(() => document.querySelector('[data-decision-id="' + row.decisionId + '"]')?.scrollIntoView({ block: 'center' })), 40);
    }
  }
  const undoChange = (changeId) => runCommand('undo_change', { changeId }, { throwOnError: true });
  const connectionType = PB_CONNECTION_TYPES[connectKind];
  const connectionSourceTitle = board?.nodes.find((node) => node.id === connectSource)?.title;
  const connectionHint = connectPending ? '正在保存连线…' : connectionSourceTitle
    ? (connectKind === 'contains' ? `已选分支「${connectionSourceTitle}」，再点要加入的节点；重连会替换原归属` : `已选「${connectionSourceTitle}」，再点${connectKind === 'produces' ? '产出' : '后置'}节点`)
    : `${connectionType.label}连线：${connectionType.prompt}`;

  const header = h('header', { className: 'pb-header' },
    h('div', { className: 'pb-ws' },
      h(PbIcon, { name: 'grid', size: 14 }),
      h('select', { value: workspacePath, disabled: connectPending, onChange: (event) => { if (!connectionInFlight.current) changeWorkspace(event.target.value); }, 'aria-label': '选择 workspace' },
        workspaceItems.length === 0 ? h('option', { value: '' }, '没有 workspace') : null,
        ...workspaceItems.map((row) => {
          const info = boardInfo?.workspaces?.find((entry) => entry.path === row.path);
          return h('option', { key: row.workspaceId, value: row.path }, (info?.hasBoard ? '● ' : '') + (row.title || row.path));
        }))),
    h('h1', { className: 'pb-title' }, '项目看板'),
    board ? h('span', { className: 'pb-meta' }, `rev ${board.revision} · ${pbAgo(board.updatedAt)}更新`) : null,
    h('span', { className: 'pb-spacer' }),
    board ? h(React.Fragment, null,
      h('button', { className: 'pb-btn', onClick: () => loadBoard(workspacePath, { keepSelection: true }) }, h(PbIcon, { name: 'refresh', size: 13 }), '刷新'),
      h(PbMaintenancePanel, {
        key: workspacePath, board, workspacePath, workspaceScope: scope, isCurrentWorkspace, runMaintenance,
        onContinue: guardWorkspace(() => { setConversation(null); setRightTab('assistant'); if (renderedDockWidth < 260) setDockWidth(clampDock(400)); }),
      }),
      h('button', { className: 'pb-btn', onClick: guardWorkspace(() => setNodeModal({ position: null })) }, h(PbIcon, { name: 'plus', size: 13 }), '节点'),
      h('button', {
        className: 'pb-btn' + (connectMode ? ' on' : ''), disabled: connectPending, 'aria-pressed': connectMode,
        onClick: guardWorkspace(() => {
          if (connectionInFlight.current) return;
          if (connectMode) cancelConnection();
          else { setConnectKind('contains'); setConnectSource(null); setSelectedEdgeId(null); setError(''); setConnectMode(true); }
        }),
      }, h(PbIcon, { name: 'link', size: 13 }), connectMode ? '取消连线' : '连线'),
      connectMode ? h('select', {
        className: 'pb-connect-select', 'aria-label': '连线类型', value: connectKind, disabled: connectPending,
        onChange: guardWorkspace((event) => { if (!connectionInFlight.current) { setConnectKind(event.target.value); setConnectSource(null); setError(''); } }),
      }, ...Object.entries(PB_CONNECTION_TYPES).map(([kind, meta]) => h('option', { key: kind, value: kind }, meta.choice))) : null,
      h('button', { className: 'pb-btn', onClick: autoLayout }, h(PbIcon, { name: 'grid', size: 13 }), '自动整理'),
      h('button', { className: 'pb-btn', onClick: () => fitView(board) }, h(PbIcon, { name: 'fit', size: 13 }), '适应'),
      selectedEdgeId ? h('button', { className: 'pb-btn danger pb-edge-toolbar-delete', onClick: () => { deleteEdge(selectedEdgeId).catch(() => {}); } }, h(PbIcon, { name: 'trash', size: 13 }), '删除连线') : null) : null);

  let body;
  if (!workspacePath) {
    body = h('div', { className: 'pb-empty big' }, '还没有选择 workspace。请在 DSH 中注册项目目录后重试。');
  } else if (loading && !board) {
    body = h('div', { className: 'pb-empty big' }, '正在读取看板…');
  } else if (!exists) {
    body = h('div', { className: 'pb-empty big' },
      h('div', { style: { fontSize: 16, fontWeight: 650, marginBottom: 10 } }, '为「' + (workspace?.title || workspacePath) + '」创建项目看板'),
      h('div', null, '看板数据会保存在项目内：' + workspacePath + '/board/project-board.json'),
      h('div', { style: { marginTop: 16 } },
        h('button', { className: 'pb-btn primary', disabled: busy, onClick: () => runCommand('create_board', {}) }, '创建看板')));
  } else {
    body = h('div', { className: 'pb-body', ref: bodyRef },
      h('div', { className: 'pb-stage' },
      h('div', { className: 'pb-stage-canvas', style: viewMode === 'list' ? { visibility: 'hidden', pointerEvents: 'none' } : undefined, 'aria-hidden': viewMode === 'list' }, h(BoardCanvas, {
        key: workspacePath,
        workspacePath, matchNodeIds,
        onOpenArtifact: guardWorkspace((row) => setArtifact({ workspacePath, row })),
        board,
        selectedNodeId,
        selectedEdgeId,
        connectMode,
        connectSource,
        connectPending,
        connectionHint,
        onSelectNode: guardWorkspace((id) => { setSelectedNodeId(id); setTaskFocus(null); if (!id) setConversation(null); if (id) setRightTab('inspector'); }),
        onOpenTask: openCanvasTask,
        executionFor,
        onSelectEdge: guardWorkspace(setSelectedEdgeId),
        onDeleteEdge: deleteEdge,
        onConnectNode,
        onCreateAt: guardWorkspace((position) => setNodeModal({ position })),
        onMoveNodes: (positions) => runCommand('save_positions', { positions }),
        onFit: guardWorkspace(() => fitView(boardRef.current)),
        onLayout: guardWorkspace((value) => { canvasLayout.current = value; }),
        view,
        setView: guardWorkspace(setView),
        onViewport: guardWorkspace(setViewport),
      })),
      viewMode === 'list' ? h(PbBoardList, { board, rows: searchRows, onOpen: focusRow, onArtifact: guardWorkspace((row) => setArtifact({ workspacePath, row })) }) : null),
      h('div', { className: 'pb-dock-resizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖动调整右栏宽度', tabIndex: 0, 'aria-valuemin': 0, 'aria-valuemax': Math.max(0, bodyWidth - 7), 'aria-valuenow': Math.round(renderedDockWidth), title: '拖动调整宽度（双击恢复默认）',
        onPointerDown: onDockResizeStart, onPointerMove: onDockResizeMove, onPointerUp: onDockResizeEnd, onPointerCancel: onDockResizeEnd,
        onKeyDown: (event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setDockWidth((width) => clampDock(width + (event.key === 'ArrowLeft' ? 20 : -20))); } },
        onDoubleClick: () => { setDockWidth(400); try { localStorage.setItem('dsh.project-board.dockWidth.v1', '400'); } catch { /* ignore */ } } }),
      h('div', { className: 'pb-dock', ref: dockRef, style: { width: renderedDockWidth + 'px' } },
        h('div', { className: 'pb-dock-tabs' },
          h('button', { className: 'pb-tab', role: 'tab', 'aria-selected': rightTab === 'assistant', onClick: guardWorkspace(() => { setConversation(null); setRightTab('assistant'); }) }, h(PbIcon, { name: 'users', size: 13 }), ' 看板 Lead'),
          h('button', { className: 'pb-tab', role: 'tab', 'aria-selected': rightTab === 'inspector', onClick: guardWorkspace(() => { setConversation(null); setRightTab('inspector'); }) }, h(PbIcon, { name: 'grid', size: 12 }), ' 节点检查器')),
        conversationItem ? h(PbConversationDrawer, {
          key: workspacePath + ':' + conversation.targetType + ':' + conversationItem.id,
          board, workspacePath, item: conversationItem, task: conversationTask, node: conversationNode,
          targetType: conversation.targetType, sessionId: selectedFor(conversation.targetType, conversationItem),
          sessionsSnapshot: sessionsSnap, runCommand,
          onClose: guardWorkspace(() => { setConversation(null); setRightTab('inspector'); setInspectorTab('overview'); }), onOpenSession: guardWorkspace((id) => props.openSession(id, isCurrentWorkspace)),
          onSelectThread: selectThread, onCreateThread: createThread, onRemoveThread: removeThread,
          onOpenArtifact: guardWorkspace((row) => setArtifact({ workspacePath, row })),
          acquireConversationSession: props.acquireConversationSession,
          SessionProvider: props.SessionProvider, renderSlot: props.renderSlot, workspaceFiles: props.workspaceFiles,
        }) : rightTab === 'inbox' ? h(PbInbox, { rows: inboxRows, seen: workspaceSeen, onSeen: markViewed, onOpen: focusRow }) : rightTab === 'history' ? h(PbBoardChangeHistory, { board, onUndo: undoChange, runCommand }) : rightTab === 'assistant' ? h(BoardAssistant, {
          key: workspacePath,
          isCurrentWorkspace,
          board,
          workspacePath,
          workspaceInfo,
          sessionsSnapshot: sessionsSnap,
          runCommand,
          createSession: props.createSession,
          acquireConversationSession: props.acquireConversationSession,
          SessionProvider: props.SessionProvider, renderSlot: props.renderSlot, workspaceFiles: props.workspaceFiles,
          onOpenSession: guardWorkspace((id) => props.openSession(id, isCurrentWorkspace)),
        }) : (selectedNode ? h(PbNodeInspector, {
          key: workspacePath + ':' + selectedNode.id,
          board,
          node: selectedNode,
          workspacePath,
          sessionsSnapshot: sessionsSnap,
          runCommand,
          onUndoChange: undoChange,
          parentCandidates: board.nodes.filter((candidate) => !pbScopeStats(board, selectedNode.id).nodeIds.includes(candidate.id)).map((row) => ({ id: row.id, title: row.title })),
          onReparentNode: (parentId) => runCommand('__connect_nodes', { source: parentId, target: selectedNode.id, kind: 'contains' }, { throwOnError: true }),
          onOpenTodo: guardWorkspace((id) => setConversation({ targetType: 'todo', targetId: id })),
          threadUi, tab: inspectorTab, onTabChange: guardWorkspace(setInspectorTab), executionFor,
          taskFocus: taskFocus?.workspacePath === workspacePath && taskFocus.nodeId === selectedNode.id ? taskFocus : null,
          onClose: guardWorkspace(() => { setSelectedNodeId(null); setTaskFocus(null); setRightTab('assistant'); }),
          onDispatchTask: (taskId) => runCommand('__dispatch_task', { taskId }),
          onOpenArtifact: guardWorkspace((row) => setArtifact({ workspacePath, row })),
        }) : h('div', { className: 'pb-empty' }, '选择一个节点查看节点详情、任务与产物。'))));

  }

  return h('main', { className: 'pb-page', 'data-project-board': '', 'aria-label': '项目看板' },
    header,
    board ? h(PbBoardToolbar, { board, filters, onFilters: guardWorkspace(setFilters), mode: viewMode, onMode: guardWorkspace(setViewMode), inboxCount: unreadCount, onInbox: guardWorkspace(() => { setConversation(null); setRightTab('inbox'); if (renderedDockWidth < 260) setDockWidth(400); }), onHistory: guardWorkspace(() => { setConversation(null); setRightTab('history'); if (renderedDockWidth < 260) setDockWidth(400); }) }) : null,
    notice ? h('div', { className: 'pb-toast', onClick: () => setNotice('') }, h(PbIcon, { name: 'check', size: 13 }), notice) : null,
    error ? h('div', { className: 'pb-error', role: 'alert', onClick: guardWorkspace(() => setError('')) }, error) : null,
    busy ? h('div', { className: 'pb-busy' }, '保存中…') : null,
    body,
    artifact ? h(PbArtifactViewer, {
      key: artifact.workspacePath + ':' + artifact.row.path,
      workspacePath: artifact.workspacePath, row: artifact.row,
      sessionId: board?.assistant?.sessionId || Object.values(sessionsSnap.byId || {}).find((row) => row.cwd === artifact.workspacePath)?.id,
      workspaceFiles: props.workspaceFiles, onClose: guardWorkspace(() => setArtifact(null)),
    }) : null,
    nodeModal ? h(PbModal, {
      key: workspacePath,
      title: '新建节点',
      onClose: guardWorkspace(() => setNodeModal(null)),
      actions: null,
    }, h(PbNodeCreateForm, { onCreate: (value) => onCreateNode({ ...value, position: nodeModal.position }), onCancel: guardWorkspace(() => setNodeModal(null)) })) : null);
}

// 自绘类型菜单复用节点 SVG；弹层挂在 body，避免被新建窗口的滚动区裁切。
function PbNodeKindSelect({ id, value, onChange }) {
  const choices = Object.entries(PB_KIND_META);
  const selectedIndex = Math.max(0, choices.findIndex(([kind]) => kind === value));
  const meta = choices[selectedIndex][1];
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(selectedIndex);
  const [position, setPosition] = React.useState({ left: 0, top: 0 });
  const anchorRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const menuId = id + '-options';

  const placeMenu = React.useCallback(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - 16);
    const height = menuRef.current?.scrollHeight || 240;
    const below = Math.max(0, window.innerHeight - rect.bottom - 14);
    const above = Math.max(0, rect.top - 14);
    const upward = below < height && above > below;
    const maxHeight = Math.min(height, upward ? above : below);
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: upward ? rect.top - 6 - maxHeight : rect.bottom + 6,
      width, maxHeight,
    });
  }, []);

  React.useLayoutEffect(() => { if (open) placeMenu(); }, [open, placeMenu]);
  React.useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector('[data-kind="' + choices[activeIndex][0] + '"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);
  React.useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!anchorRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
    };
  }, [open, placeMenu]);

  function choose(kind) {
    onChange(kind); setOpen(false);
    anchorRef.current?.focus({ preventScroll: true });
  }

  function onKeyDown(event) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setActiveIndex((current) => event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : !open ? selectedIndex : (current + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length);
      setOpen(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(choices[activeIndex][0]);
      else { setActiveIndex(selectedIndex); setOpen(true); }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
  }

  return h(React.Fragment, null,
    h('button', {
      id, ref: anchorRef, type: 'button', role: 'combobox', className: 'pb-select pb-kind-trigger' + (open ? ' open' : ''),
      'aria-label': '节点类型', 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-controls': menuId,
      'aria-activedescendant': open ? menuId + '-' + choices[activeIndex][0] : undefined,
      onClick: () => { setActiveIndex(selectedIndex); setOpen((current) => !current); },
      onKeyDown, onBlur: () => setOpen(false),
    },
      h('span', { className: 'pb-kind-icon', style: { color: meta.color } }, h(PbIcon, { name: meta.icon, size: 16 })),
      h('span', { className: 'pb-kind-label' }, meta.label), h(PbIcon, { name: 'chevronDown', size: 14 })),
    open ? createPortal(h('div', {
      id: menuId, ref: menuRef, className: 'pb-kind-menu', role: 'listbox', 'aria-label': '节点类型选项', style: position,
      onPointerDown: (event) => { if (event.target.closest('[role="option"]')) event.preventDefault(); },
    }, ...choices.map(([kind, item], index) => h('button', {
      key: kind, id: menuId + '-' + kind, type: 'button', role: 'option', tabIndex: -1,
      className: 'pb-kind-option', 'aria-selected': kind === value, 'data-kind': kind, 'data-active': index === activeIndex,
      onMouseEnter: () => setActiveIndex(index), onClick: () => choose(kind),
    },
      h('span', { className: 'pb-kind-icon', style: { color: item.color } }, h(PbIcon, { name: item.icon, size: 16 })),
      h('span', { className: 'pb-kind-label' }, item.label),
      kind === value ? h(PbIcon, { name: 'check', size: 14, color: PB_ACCENT }) : null))), document.body) : null);
}

function PbNodeCreateForm({ onCreate, onCancel }) {
  const [title, setTitle] = React.useState('');
  const [kind, setKind] = React.useState('experiment');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const pending = React.useRef(false);
  const formId = React.useId();
  async function submit() {
    if (!title.trim() || pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try {
      const response = await onCreate({ title: title.trim(), kind });
      if (!response) throw new Error('创建未成功，请重试');
    } catch (err) { setError(err.message || '创建失败，请重试'); }
    finally { pending.current = false; setSaving(false); }
  }
  return h('div', { className: 'pb-form' },
    h('label', { htmlFor: formId + '-title' }, '标题'), h('input', { id: formId + '-title', className: 'pb-input', autoFocus: true, value: title, disabled: saving, onChange: (event) => setTitle(event.target.value), onKeyDown: (event) => { if (pbIsSubmitKey(event)) { event.preventDefault(); void submit(); } } }),
    h('label', { htmlFor: formId + '-kind' }, '类型'), h(PbNodeKindSelect, { id: formId + '-kind', value: kind, onChange: (value) => { if (!pending.current) setKind(value); } }),
    error ? h('div', { role: 'alert', className: 'pb-conversation-error' }, error) : null,
    h('div', { className: 'pb-modal-actions', style: { marginTop: 6 } },
      h('button', { className: 'pb-btn', disabled: saving, onClick: onCancel }, '取消'),
      h('button', { className: 'pb-btn primary', disabled: saving || !title.trim(), onClick: submit }, saving ? '创建中…' : '创建')));
}
