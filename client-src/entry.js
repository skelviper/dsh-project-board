// Client entry: register the board panel, sidebar entries, and session helpers.
const PB_CLIENT_INJECT = ['slots', 'layout', 'workspaces', 'sessions', 'uiSession', 'jobs', 'uiWorkspace', 'conversation', 'modelDirectories', 'remote', 'remote.session', 'remote.workspaceFiles'];

function pbOpenBoard(ctx, workspacePath) {
  PB_PENDING_WORKSPACE = workspacePath || '';
  try { ctx.layout.selectPanel(PB_PANEL); } catch (error) { console.warn('[project-board] selectPanel failed', error); }
  window.dispatchEvent(new CustomEvent(PB_EVENT, { detail: { workspacePath: workspacePath || '' } }));
}

// 打开已有会话前等待它加载完成；此路径只导航，绝不调用 create/startSession。
async function pbOpenSession(ctx, sessionId, isCurrent = () => true) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('请选择要打开的会话');
  if (!isCurrent()) throw new Error('项目已切换，请在当前项目打开会话');
  // 首屏目录只含最近会话；绑定的旧会话需先完成原生目录刷新。
  if (ctx.sessions.list && !ctx.sessions.list.getSnapshot().byId[sessionId]) await ctx.sessions.refresh();
  if (!isCurrent()) throw new Error('项目已切换，请在当前项目打开会话');
  const reference = ctx.sessions.retain(sessionId, { source: 'projectBoardNavigation' });
  try {
    await reference.ready;
    if (!isCurrent()) throw new Error('项目已切换，请在当前项目打开会话');
    if (reference.sessionId !== sessionId) throw new Error('加载的会话与当前选择不一致');
    ctx.uiWorkspace.openSession(sessionId);
    return sessionId;
  } finally { reference.release(); }
}

function pbInjectSidebarRows(ctx, openBoard) {
  const rows = new Map();
  let stopped = false;
  let scheduled = false;
  const schedule = () => {
    if (stopped || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; tick(); });
  };
  function tick() {
    if (stopped) return;
    const tree = document.querySelector('[data-slot="sidebar.workspaces"] [role="tree"]');
    if (!tree) {
      for (const row of rows.values()) row.remove();
      rows.clear();
      return;
    }
    const items = ctx.workspaces.list.getSnapshot().items || [];
    const byId = new Map(items.map((item) => [String(item.workspaceId), item]));
    const seen = new Set();
    for (const workspaceRow of tree.querySelectorAll('[data-row-key^="workspace:"]')) {
      const rowKey = workspaceRow.getAttribute('data-row-key') || '';
      const id = rowKey.slice('workspace:'.length);
      if (!id) continue;
      let group = workspaceRow;
      while (group && group.parentElement !== tree) group = group.parentElement;
      if (!group) continue;
      const header = workspaceRow.parentElement && workspaceRow.parentElement !== group ? workspaceRow.parentElement : workspaceRow;
      const expanded = workspaceRow.getAttribute('aria-expanded') !== 'false';
      const existing = rows.get(id);
      if (!expanded) {
        if (existing) { existing.remove(); rows.delete(id); }
        continue;
      }
      seen.add(id);
      let element = existing && existing.isConnected ? existing : null;
      if (!element) {
        element = document.createElement('div');
        element.className = 'pb-side-row';
        element.dataset.dshProjectBoardRow = id;
        element.setAttribute('role', 'button');
        element.tabIndex = 0;
        element.title = '打开该 workspace 的项目看板';
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('width', '14'); icon.setAttribute('height', '14'); icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.7');
        icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<rect x="3" y="3" width="7" height="7" rx="2"></rect><rect x="14" y="3" width="7" height="7" rx="2"></rect><rect x="3" y="14" width="7" height="7" rx="2"></rect><path d="M14 17.5h7M17.5 14v7"></path>';
        const label = document.createElement('span');
        label.textContent = '项目看板';
        const open = () => { const target = byId.get(id); openBoard(target ? target.path : undefined); };
        element.addEventListener('click', (event) => { event.stopPropagation(); open(); });
        element.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
        element.append(icon, label);
        rows.set(id, element);
        const sessionRow = group.querySelector('[data-row-key^="session:"]');
        if (sessionRow) {
          const style = getComputedStyle(sessionRow);
          const indent = parseFloat(getComputedStyle(group).getPropertyValue('--dsh-workspace-indent')) || 0;
          const basePad = Math.max(8, (parseFloat(style.paddingLeft) || 0) - indent);
          element.style.paddingLeft = 'calc(var(--dsh-workspace-indent, 0px) + ' + basePad + 'px)';
          element.style.height = style.height || '32px';
          element.style.fontSize = style.fontSize || '14px';
        }
      }
      if (header.nextElementSibling !== element) header.insertAdjacentElement('afterend', element);
    }
    for (const [id, element] of rows) {
      if (!seen.has(id) || !element.isConnected) { element.remove(); rows.delete(id); }
    }
  }
  const observer = new MutationObserver((mutations) => {
    if (stopped) return;
    const tree = document.querySelector('[data-slot="sidebar.workspaces"] [role="tree"]');
    if (tree && mutations.every((mutation) => mutation.target === tree || tree.contains(mutation.target))) schedule();
    else schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded'] });
  let unsubscribe = () => {};
  try { unsubscribe = ctx.workspaces.list.subscribe(schedule); } catch { /* optional */ }
  schedule();
  return () => {
    stopped = true;
    observer.disconnect();
    try { unsubscribe(); } catch { /* ignore */ }
    for (const element of rows.values()) element.remove();
    rows.clear();
  };
}

// DSH 0.2.1-rc.2 没有逐实例 openFile 配置；重新注册会重复声明原生子槽。
// 只在 effect 生命周期内包装公开 StoredEntry.component，保留原 entry 的注入与子槽权限。
const PB_NATIVE_FILE_PREVIEW = Symbol.for('dsh.projectBoard.nativeFilePreview');
function pbInstallNativeFilePreview(ctx) {
  return ctx.effect(() => {
    const patches = new Map();
    let active = true;
    // registrant 是 fiber 名，压缩构建中可能统一为 Kb，不能用它判断组件身份。
    const targets = [
      { name: 'conversation.view', field: 'id', value: 'chat' },
      { name: 'conversation.user.text.node', field: 'key', value: 'file' },
    ];
    const restore = (entry, patch) => {
      // 其他插件若后来替换组件，卸载时不覆盖它的新值。
      if (entry.component === patch.wrapper) entry.component = patch.original;
      patches.delete(entry);
    };
    const reconcile = () => {
      if (!active) return;
      const live = new Set();
      for (const target of targets) {
        // entriesOfSlot 只返回胜出者；原始 entries 才能跟随原生注册的完整生命周期。
        for (const entry of ctx.slots.entries(target.name)) {
          if (entry.options?.[target.field] !== target.value) continue;
          live.add(entry);
          if (patches.has(entry)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(entry, 'component');
          if (!descriptor?.writable) {
            console.warn('[project-board] native file preview requires a writable slot component', target.name);
            continue;
          }
          // 热更交叠时直接取最初组件，不把本插件包装器叠成链。
          const original = entry.component?.[PB_NATIVE_FILE_PREVIEW]?.original || entry.component;
          function PbNativeFilePreview(props) {
            const openFile = React.useContext(PbFilePreviewContext);
            return h(original, active && typeof openFile === 'function' ? { ...props, openFile } : props);
          }
          PbNativeFilePreview[PB_NATIVE_FILE_PREVIEW] = { original };
          patches.set(entry, { original, wrapper: PbNativeFilePreview });
          entry.component = PbNativeFilePreview;
        }
      }
      for (const [entry, patch] of patches) if (!live.has(entry)) restore(entry, patch);
    };
    const unsubscribers = targets.map(target => ctx.slots.subscribe(target.name, reconcile));
    reconcile();
    return () => {
      active = false;
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const [entry, patch] of patches) restore(entry, patch);
    };
  }, 'project-board: native file preview');
}

function PbBoardIcon({ size = 18 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 2 }),
    h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 2 }),
    h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 2 }),
    h('path', { d: 'M14 17.5h7M17.5 14v7' }));
}

const pbClientEntry = {
  inject: PB_CLIENT_INJECT,
  apply(ctx) {
    pbInjectStyle(ctx);
    pbInstallNativeFilePreview(ctx);
    const props = {
      workspacesSource: ctx.workspaces.list,
      sessionsSource: ctx.sessions.list,
      sessionStatusSource: ctx.uiSession.sessionStatus,
      jobs: ctx.jobs,
      layout: ctx.layout,
      uiWorkspace: ctx.uiWorkspace,
      sessions: ctx.sessions,
      createSession: (workspaceId, sessionId) => ctx.sessions.create({ workspaceId, sessionId }),
      openSession: (sessionId, isCurrent) => pbOpenSession(ctx, sessionId, isCurrent),
      modelDirectories: ctx.modelDirectories,
      acquireConversationSession: async (sessionId) => {
        if (!ctx.sessions.list.getSnapshot().byId[sessionId]) await ctx.sessions.refresh();
        return ctx.sessions.retain(sessionId, { source: 'projectBoardConversation' });
      },
      workspaceFiles: ctx.remote.workspaceFiles,
      openBoard: (workspacePath) => pbOpenBoard(ctx, workspacePath),
    };
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PB_PANEL, inject: () => props,
      children: { 'project-board.conversation': { kind: 'single', scope: 'session' } },
    }, ProjectBoardPanel));
    ctx.slots.inject('project-board.conversation', () => ctx.slots.register({ name: 'project-board.conversation' }, PbNativeConversationSlot));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PB_PANEL, order: -19, label: () => '看板' }, PbBoardIcon));
    const disposeRows = pbInjectSidebarRows(ctx, (workspacePath) => pbOpenBoard(ctx, workspacePath));
    ctx.on('dispose', disposeRows);
  },
};

return pbClientEntry;
