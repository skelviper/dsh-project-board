// 新增资料先作为线索交给既有 Lead 整理；更新继续由看板 SSE 驱动。
const PB_MAINTENANCE_UPDATE_MESSAGE = '请按当前项目目标整理新增资料：优先更新现有任务和来源，只有明确独立事项才新增节点，不要把目录或每份文档逐个建卡。';

function pbMaintenanceRoots(maintenance) {
  return maintenance?.scope === 'custom' && Array.isArray(maintenance.roots) ? maintenance.roots.join('\n') : '';
}

function pbMaintenanceValue(value) {
  if (value === undefined) return '（未设置）';
  if (value === null) return '（空值）';
  if (value === '') return '（空文本）';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function pbMaintenanceBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function PbMaintenanceDeletion({ deletion }) {
  const labels = { pending: '等待归档', archived: '已归档', needs_decision: '需决定', retained: '已保留文件' };
  const receipt = deletion.receipt;
  return h('article', { className: 'pb-maintenance-record', 'data-deletion-id': deletion.id },
    h('div', { className: 'pb-maintenance-record-head' },
      h('strong', null, deletion.title || deletion.targetId),
      h('span', { className: 'pb-chip' }, labels[deletion.status] || deletion.status)),
    deletion.reason ? h('div', { className: 'pb-maintenance-reason' }, deletion.reason) : null,
    receipt ? h('div', { className: 'pb-row-sub' }, `已归档 ${receipt.fileCount || 0} 个文件 · ${pbMaintenanceBytes(receipt.bytes)}`) : null,
    deletion.paths?.length || receipt?.receiptPath || receipt?.moves?.length ? h('details', { className: 'pb-maintenance-files' },
      h('summary', null, '文件与归档记录', deletion.paths?.length ? ' · ' + deletion.paths.length + ' 项' : ''),
      deletion.paths?.length ? h('ul', null, ...deletion.paths.map((path, index) => h('li', { key: index }, h('code', null, path)))) : null,
      receipt?.moves?.length ? h('ul', null, ...receipt.moves.map((move, index) => h('li', { key: index },
        typeof move === 'string' ? move : (move.from || move.source || '') + ' → ' + (move.to || move.destination || '')))) : null,
      receipt?.receiptPath ? h('div', { className: 'pb-row-sub' }, '归档收据：', h('code', null, receipt.receiptPath)) : null) : null);
}

function PbMaintenanceConflict({ conflict, deletion, busy, onResolve }) {
  const fieldLabels = { title: '标题', summary: '概览', description: '描述', status: '状态', acceptance: '验收标准', primaryArtifactPath: '主成果', 'delivery.summary': '交付结论', 'delivery.outcome': '结果标签', 'delivery.review': '验收状态' };
  const choices = conflict.kind === 'field' ? [['keep_board', '保留看板'], ['use_disk', '采用盘上']]
    : conflict.kind === 'archive' ? [['keep_files', '保留文件'], ['retry_archive', '重试归档']]
      : [['keep_board', '缺件保留记录']];
  return h('article', { className: 'pb-maintenance-conflict', 'data-conflict-id': conflict.id },
    h('div', { className: 'pb-maintenance-record-head' },
      h('strong', null, conflict.title || conflict.targetId),
      h('span', { className: 'pb-chip' }, conflict.kind === 'field' ? '字段取舍' : conflict.kind === 'archive' ? '归档取舍' : '来源缺件')),
    conflict.kind === 'field' ? h(React.Fragment, null,
      h('div', { className: 'pb-row-sub' }, '变更字段：' + (fieldLabels[conflict.field] || conflict.field || '内容')),
      h('div', { className: 'pb-maintenance-compare' },
        h('div', null, h('span', { className: 'pb-field-caption' }, '看板当前值'), h('pre', null, pbMaintenanceValue(conflict.current))),
        h('div', null, h('span', { className: 'pb-field-caption' }, '盘上新值'), h('pre', null, pbMaintenanceValue(conflict.proposed)))))
      : h('p', { className: 'pb-maintenance-reason' }, deletion?.reason || (conflict.kind === 'missing' ? '盘上来源已缺失，确认后保留已有看板记录。' : '相关文件仍被共享或使用，保留文件或检查后重试归档。')),
    conflict.sourcePath ? h('div', { className: 'pb-row-sub' }, '来源：', h('code', null, conflict.sourcePath)) : null,
    conflict.kind === 'archive' ? h(React.Fragment, null,
      h('div', { className: 'pb-row-sub' }, '保留文件会留下删除标记。重试归档会确认以下范围，仍只归档独占且未被活动会话使用的文件。'),
      deletion?.paths?.length ? h('ul', { className: 'pb-maintenance-archive-scope' }, ...deletion.paths.map((path, index) => h('li', { key: index }, h('code', null, path)))) : h('div', { className: 'pb-row-sub' }, '当前未登记可归档文件。')) : null,
    h('div', { className: 'pb-maintenance-actions' }, ...choices.map(([choice, label]) => h('button', {
      key: choice, type: 'button', className: 'pb-btn small', disabled: busy,
      'data-maintenance-choice': choice, onClick: () => onResolve(conflict.id, choice),
    }, label))));
}

function PbMaintenancePanelBody({ board, workspacePath, workspaceScope, isCurrentWorkspace, runMaintenance, onContinue }) {
  const maintenance = board.maintenance || {};
  const contextRef = React.useRef(null);
  if (!contextRef.current || contextRef.current.path !== workspacePath || contextRef.current.scope !== workspaceScope) {
    contextRef.current = { path: workspacePath, scope: workspaceScope, pending: null };
  }
  const context = contextRef.current;
  const initial = () => ({ context, open: false, roots: pbMaintenanceRoots(maintenance), savedRoots: pbMaintenanceRoots(maintenance), message: '', busy: '', error: '', retry: null, notice: '' });
  const [state, setState] = React.useState(initial);
  // 路径相同的 A→B→A 也按 scope 身份重新建草稿；首次渲染即不显示旧项目输入。
  const ui = state.context === context ? state : initial();
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = () => mounted.current && contextRef.current === context && isCurrentWorkspace?.() !== false;
  function update(patch) {
    if (!active()) return;
    setState((current) => ({ ...(current.context === context ? current : initial()), ...(typeof patch === 'function' ? patch(current.context === context ? current : initial()) : patch) }));
  }
  const savedRoots = pbMaintenanceRoots(maintenance);
  React.useEffect(() => {
    if (!active()) return;
    setState((current) => current.context !== context ? initial() : {
      ...current, roots: current.roots === current.savedRoots ? savedRoots : current.roots, savedRoots,
    });
  }, [context, savedRoots]);

  async function perform(operation, input = {}, retry = null, clearMessage = false) {
    if (!active() || context.pending) return null;
    const request = retry || { operation, input, commandId: pbUuid(), draft: ui.roots, clearMessage };
    context.pending = request;
    update({ busy: request.operation, error: '', retry: null, notice: '', open: true });
    try {
      const response = await runMaintenance(request.operation, { ...request.input, commandId: request.commandId });
      if (!active()) return null;
      if (!response?.board) throw new Error('维护未完成，请重试');
      update((current) => ({
        notice: request.operation === 'notify' ? (response.coalesced ? '已合并通知，待看板 Lead 整理；请在原会话查看进展。' : '已通知看板 Lead，整理请求已排队；请在原会话查看进展。')
          : request.operation === 'configure' ? (request.input.roots.length ? '自定义检查范围已保存。' : '已恢复检查已关联的活动入口。') : request.operation === 'resolve' ? '已记录选择。' : response.summary || '本次检查已完成。',
        message: request.clearMessage && current.message === request.input.message ? '' : current.message,
        ...(request.operation === 'configure' ? { savedRoots: pbMaintenanceRoots(response.board.maintenance), roots: current.roots === request.draft ? pbMaintenanceRoots(response.board.maintenance) : current.roots } : {}),
      }));
      if (request.operation === 'notify' && active()) onContinue?.();
      return response;
    } catch (err) {
      if (active()) update({ error: err.message || '维护失败，输入已保留，请重试。', retry: request });
      return null;
    } finally {
      if (context.pending === request) context.pending = null;
      if (active()) update({ busy: '' });
    }
  }

  const conflicts = (maintenance.conflicts || []).filter((row) => row.status === 'open');
  const resolved = (maintenance.conflicts || []).filter((row) => row.status === 'resolved');
  const deletions = maintenance.deletions || [];
  const pendingCandidates = (maintenance.candidates || []).filter((row) => row.status === 'pending').length;
  const busy = Boolean(ui.busy);
  function configure(event) {
    event.preventDefault();
    const roots = [...new Set(ui.roots.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    return perform('configure', { roots });
  }
  function notify(event) {
    event.preventDefault();
    if (!board.assistant?.sessionId) return;
    return perform('notify', { message: ui.message }, null, true);
  }
  function resolveConflict(conflictId, choice) {
    if (!active() || context.pending) return null;
    const conflict = conflicts.find((row) => row.id === conflictId);
    if (!conflict) return null;
    if (choice === 'retry_archive') {
      const deletion = deletions.find((row) => row.id === conflict.deletionId);
      const paths = deletion?.paths || [];
      if (!window.confirm('确认对列出的文件范围重试归档？\n' + (paths.length ? paths.join('\n') : '当前未登记可归档文件') + '\n仅独占且没有活动会话使用的文件可自动归档。共享或活动文件仍会保留并进入待决策。')) return null;
    }
    return perform('resolve', { conflictId, choice });
  }
  const panelId = React.useId();
  return h(React.Fragment, null,
    h('div', { className: 'pb-maintenance-toolbar', role: 'group', 'aria-label': '看板维护' },
      h('button', { type: 'button', className: 'pb-btn', disabled: busy || !board.assistant?.sessionId, onClick: () => { if (board.assistant?.sessionId) return perform('notify', { message: PB_MAINTENANCE_UPDATE_MESSAGE }); } }, h(PbIcon, { name: 'refresh', size: 13 }), ui.busy === 'notify' ? '通知中…' : '更新看板'),
      h('button', { type: 'button', className: 'pb-btn' + (pendingCandidates || conflicts.length || ui.open ? ' on' : ''), 'aria-expanded': ui.open, 'aria-controls': panelId, onClick: () => update({ open: !ui.open }) }, '维护记录',
        pendingCandidates ? h('span', { className: 'pb-count' }, '待整理 ' + pendingCandidates) : null,
        conflicts.length ? h('span', { className: 'pb-count' }, '需决定 ' + conflicts.length) : null)),
    ui.open ? h('section', { id: panelId, className: 'pb-maintenance-panel', 'aria-label': '看板维护记录', 'aria-busy': busy },
      h('div', { className: 'pb-maintenance-heading' }, h('strong', null, '看板维护记录'),
        maintenance.lastScanAt ? h('time', { className: 'pb-meta', dateTime: maintenance.lastScanAt }, '上次检查 ' + pbFormatTime(maintenance.lastScanAt)) : null,
        h('span', { className: 'pb-spacer' }), h('button', { type: 'button', className: 'pb-btn small', onClick: () => update({ open: false }) }, '收起')),
      h('p', { className: 'pb-maintenance-summary' }, maintenance.lastSummary || '点击“更新看板”通知原看板 Lead，按当前项目目标整理新增资料。'),
      h('p', { className: 'pb-row-sub', 'aria-label': '待整理资料线索' }, '待整理线索 ' + pendingCandidates + ' 条。Lead 会优先补充现有任务与来源，只有明确独立事项才新增节点。'),
      ui.notice ? h('div', { className: 'pb-maintenance-notice', role: 'status' }, ui.notice) : null,
      ui.error ? h('div', { className: 'pb-form-error', role: 'alert' }, ui.error, h('span', null, ' 输入已保留。'),
        ui.retry ? h('button', { type: 'button', className: 'pb-btn small', disabled: busy, onClick: () => perform(ui.retry.operation, ui.retry.input, ui.retry) }, '重试此操作') : null) : null,
      h('div', { className: 'pb-maintenance-grid' },
        h('section', { className: 'pb-maintenance-section', 'aria-label': '需要决定的维护冲突' },
          h('h3', null, '需决定', h('span', { className: 'pb-count' }, conflicts.length)),
          conflicts.length ? conflicts.map((conflict) => h(PbMaintenanceConflict, {
            key: conflict.id, conflict, deletion: deletions.find((row) => row.id === conflict.deletionId), busy,
            onResolve: resolveConflict,
          })) : h('div', { className: 'pb-row-sub' }, '当前没有需要决定的维护冲突。')),
        h('section', { className: 'pb-maintenance-section', 'aria-label': '删除与归档清单' },
          h('h3', null, '删除与归档', h('span', { className: 'pb-count' }, deletions.length)),
          deletions.length ? deletions.map((deletion) => h(PbMaintenanceDeletion, { key: deletion.id, deletion })) : h('div', { className: 'pb-row-sub' }, '暂无删除或归档记录。'))),
      resolved.length ? h('details', { className: 'pb-maintenance-config' }, h('summary', null, '已处理决定 · ' + resolved.length),
        ...resolved.map((conflict) => h('div', { key: conflict.id, className: 'pb-row-sub' }, (conflict.title || conflict.targetId) + ' · 已处理'))) : null,
      h('form', { className: 'pb-maintenance-notify', onSubmit: notify },
        h('label', null, '通知附言（可选）', h('textarea', { className: 'pb-input', rows: 2, 'aria-label': '通知看板 Lead 的附言', value: ui.message, placeholder: '说明这次需要关注的变化…', onChange: (event) => update({ message: event.target.value }) })),
        h('div', { className: 'pb-maintenance-actions' },
          h('button', { type: 'submit', className: 'pb-btn small', disabled: busy || !board.assistant?.sessionId }, ui.busy === 'notify' ? '通知中…' : '通知看板 Lead'),
          onContinue ? h('button', { type: 'button', className: 'pb-btn small', onClick: () => { if (active()) onContinue(); } }, '继续看板对话') : null,
          h('span', { className: 'pb-row-sub' }, board.assistant?.sessionId ? '先检查关联范围，再通知原看板 Lead 整理；已通知表示请求已排队，可在原会话继续交流。' : '先打开看板对话，准备好 Lead 会话后即可通知。'))),
      h('details', { className: 'pb-maintenance-config' },
        h('summary', null, '检查范围配置', ui.roots !== ui.savedRoots ? ' · 有未保存修改' : ''),
        h('form', { onSubmit: configure }, h('label', null, '额外检查目录（每行一个）', h('textarea', { className: 'pb-input', rows: 3, 'aria-label': '看板检查目录', value: ui.roots, placeholder: '留空：仅检查已关联的活动入口', onChange: (event) => update({ roots: event.target.value }) })),
          h('div', { className: 'pb-row-sub' }, '默认留空，只检查已关联的活动入口。填写项目内相对目录后使用自定义范围；清空并保存可恢复默认。新增资料先记为线索，由 Lead 按项目目标整理。'),
          h('button', { type: 'submit', className: 'pb-btn small', disabled: busy || ui.roots === ui.savedRoots }, ui.busy === 'configure' ? '保存中…' : '保存检查目录')))) : null);
}
