// 搜索、待处理与本地阅读状态；浏览不会改动任务验收状态。
function pbReadLocal(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key)); return value == null ? fallback : value; } catch { return fallback; }
}
function pbWriteLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 无存储权限仍可使用当前视图。 */ }
}
function pbWorkspaceView(path) {
  const value = pbReadLocal('dsh.project-board.view.v2:' + path, null);
  return value && ['x', 'y', 'scale'].every((key) => Number.isFinite(value[key])) && value.scale >= .28 && value.scale <= 1.9 ? value : null;
}
function pbPrimaryArtifact(item) {
  return item?.primaryArtifactPath ? item.artifacts?.find((row) => row.path === item.primaryArtifactPath) || null : null;
}
function pbDeliveryLabel(item) {
  const delivery = item?.delivery;
  const outcome = { supported: '支持假设', not_supported: '未支持假设', not_triggered: '条件未触发', inconclusive: '结论未定' }[delivery?.outcome];
  return [outcome, { pending: '待验收', accepted: '已验收', changes_requested: '需修改' }[delivery?.review]].filter(Boolean).join(' · ');
}
function pbSearchRows(board, filters = {}) {
  if (!board) return [];
  const byNode = new Map(board.nodes.map((row) => [row.id, row]));
  const byTask = new Map(board.tasks.map((row) => [row.id, row]));
  const scope = filters.branch && filters.branch !== 'unparented' ? new Set(pbScopeStats(board, filters.branch).nodeIds) : null;
  const unparented = new Set(board.nodes.filter((node) => node.kind !== 'theme' && !board.edges.some((edge) => edge.kind === 'contains' && edge.to === node.id)).map((node) => node.id));
  const rows = [...board.nodes.map((item) => ({ type: 'node', item, nodeId: item.id })), ...board.tasks.map((item) => ({ type: 'task', item, nodeId: item.nodeId, taskId: item.id })), ...board.todos.map((item) => ({ type: 'todo', item, nodeId: byTask.get(item.taskId)?.nodeId, taskId: item.taskId }))];
  const words = String(filters.query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const node = byNode.get(row.nodeId), item = row.item;
    if (!node || (scope && !scope.has(row.nodeId)) || (filters.branch === 'unparented' && !unparented.has(row.nodeId))) return false;
    if (filters.kind && node.kind !== filters.kind) return false;
    if (filters.status && (row.type === 'node' ? pbDerivedNodeStatus(board, item.id) : item.status) !== filters.status) return false;
    if (filters.outcome && item.delivery?.outcome !== filters.outcome) return false;
    const text = [item.id, item.title, item.summary, item.description, item.acceptance, item.delivery?.summary, pbDeliveryLabel(item), node.title, ...pbNodeBranchPath(board, row.nodeId).map((row) => row.title), ...(item.artifacts || []).flatMap((row) => [row.label, row.path]), ...pbThreadsOf(item).flatMap((row) => [row.sessionId, row.title])].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
function pbInboxRows(board, sessionsSnapshot, sessionStatuses) {
  if (!board) return [];
  const rows = [], claimedSessions = new Set();
  const tasks = new Map(board.tasks.map((row) => [row.id, row]));
  const entries = [...board.todos.map((item) => ({ type: 'todo', item, task: tasks.get(item.taskId) })), ...board.tasks.map((item) => ({ type: 'task', item, task: item }))];
  for (const entry of entries) {
    const { item, task, type } = entry;
    if (!task) continue;
    const nodeId = task.nodeId;
    // 子待办先认领自己的等待会话，父任务不重复汇总同一问题。
    for (const sessionId of pbExecutionContext(board, item, sessionsSnapshot).ids) {
      const pending = sessionStatuses?.get?.(sessionId)?.pendingInteraction;
      if (!pending || claimedSessions.has(sessionId)) continue;
      claimedSessions.add(sessionId);
      rows.push({ id: 'question:' + sessionId, kind: 'question', label: '待回答', title: item.title, detail: sessionsSnapshot?.byId?.[sessionId]?.title || '关联会话等待回答或确认', nodeId, taskId: task.id, targetType: type, targetId: item.id, sessionId, version: JSON.stringify(pending) });
    }
    if (item.delivery?.review === 'pending') rows.push({ id: 'review:' + type + ':' + item.id, kind: 'review', label: '待验收', title: item.title, detail: item.delivery.summary || '已显式提交验收，等待检查交付', nodeId, taskId: task.id, targetType: type, targetId: item.id, version: item.delivery.submittedAt + ':' + item.updatedAt });
    if (item.status === 'blocked') rows.push({ id: 'blocked:' + type + ':' + item.id, kind: 'blocked', label: '受阻', title: item.title, detail: item.description || item.acceptance || '查看任务中的阻塞原因', nodeId, taskId: task.id, targetType: type, targetId: item.id, version: item.updatedAt || '' });
  }
  for (const decision of board.decisions || []) if (decision.status === 'open') rows.push({ id: 'decision:' + decision.id, kind: 'decision', label: '待决策', title: decision.question, detail: board.nodes.find((node) => node.id === decision.nodeId)?.title || '项目决策', nodeId: decision.nodeId, decisionId: decision.id, version: decision.updatedAt || decision.createdAt || '' });
  return rows;
}
function PbBoardToolbar({ board, filters, onFilters, mode, onMode, inboxCount, onInbox, onHistory }) {
  const field = (key) => (event) => onFilters({ ...filters, [key]: event.target.value });
  const active = Object.values(filters).some(Boolean);
  return h('div', { className: 'pb-explorer-toolbar', 'aria-label': '看板搜索与筛选' },
    h('div', { className: 'pb-view-switch', role: 'group', 'aria-label': '视图' }, ...[['canvas', '画布'], ['list', '列表']].map(([key, label]) => h('button', { key, className: 'pb-btn small' + (mode === key ? ' on' : ''), 'aria-pressed': mode === key, onClick: () => onMode(key) }, label))),
    h('input', { className: 'pb-input pb-board-search', type: 'search', value: filters.query, onChange: field('query'), placeholder: '搜索任务、结论、文件或会话…', 'aria-label': '搜索看板' }),
    h('select', { className: 'pb-input', value: filters.branch, onChange: field('branch'), 'aria-label': '按分支筛选' }, h('option', { value: '' }, '所有分支'), ...board.nodes.filter((node) => node.kind === 'theme').map((node) => h('option', { key: node.id, value: node.id }, node.title)), h('option', { value: 'unparented' }, '未归属节点')),
    h('select', { className: 'pb-input', value: filters.status, onChange: field('status'), 'aria-label': '按状态筛选' }, h('option', { value: '' }, '所有状态'), ...Object.entries(PB_STATUS_META).filter(([key]) => key !== 'active').map(([key, meta]) => h('option', { key, value: key }, meta.label))),
    h('select', { className: 'pb-input', value: filters.kind, onChange: field('kind'), 'aria-label': '按节点类型筛选' }, h('option', { value: '' }, '所有类型'), ...Object.entries(PB_KIND_META).map(([key, meta]) => h('option', { key, value: key }, meta.label))),
    h('select', { className: 'pb-input', value: filters.outcome, onChange: field('outcome'), 'aria-label': '按交付结论筛选' }, h('option', { value: '' }, '所有结论'), ...Object.entries({ supported: '支持假设', not_supported: '未支持假设', not_triggered: '条件未触发', inconclusive: '结论未定' }).map(([key, value]) => h('option', { key, value: key }, value))),
    active ? h('button', { className: 'pb-btn small', onClick: () => onFilters({ query: '', branch: '', status: '', kind: '', outcome: '' }) }, '清除筛选') : null,
    h('span', { className: 'pb-spacer' }),
    h('button', { className: 'pb-btn small', onClick: onHistory }, h(PbIcon, { name: 'history', size: 13 }), '变更'),
    h('button', { className: 'pb-btn small' + (inboxCount ? ' on' : ''), onClick: onInbox }, '待我处理', h('span', { className: 'pb-count' }, inboxCount)));
}
function PbBoardList({ board, rows, onOpen, onArtifact }) {
  return h('section', { className: 'pb-board-list', 'aria-label': '看板列表' },
    h('div', { className: 'pb-list-heading' }, h('strong', null, '项目条目'), h('span', { className: 'pb-meta' }, rows.length + ' 项匹配 · 点击定位画布')),
    !rows.length ? h('div', { className: 'pb-empty' }, '没有匹配条目，调整筛选后重试。') : rows.map((row) => {
      const item = row.item, node = board.nodes.find((node) => node.id === row.nodeId), primary = pbPrimaryArtifact(item);
      const stats = row.type === 'node' ? pbScopeStats(board, item.id) : null;
      return h('article', { key: row.type + ':' + item.id, className: 'pb-list-row' },
        h('button', { className: 'pb-list-open', onClick: () => onOpen(row) },
          h('span', { className: 'pb-meta' }, (row.type === 'node' ? PB_KIND_META[item.kind]?.label : row.type === 'task' ? '任务' : '待办') + ' · ' + (pbNodeBranchPath(board, row.nodeId).map((node) => node.title).join(' / ') || (node?.kind !== 'theme' ? '未归属' : '项目分支'))),
          h('strong', null, item.title),
          h('span', { className: 'pb-meta', title: item.delivery?.summary || item.summary || item.description }, pbShortSummary(item.delivery?.summary || item.summary || item.description || '', 150)),
          h('span', { className: 'pb-list-labels' }, h('span', { className: 'pb-chip' }, PB_STATUS_META[row.type === 'node' ? pbDerivedNodeStatus(board, item.id) : item.status]?.label || item.status), pbDeliveryLabel(item), stats?.total ? h('span', { className: 'pb-meta' }, `已结束 ${stats.closed}/${stats.total} · 完成 ${stats.done}`) : null)),
        primary ? h('button', { className: 'pb-btn small pb-list-artifact', title: primary.path, onClick: () => onArtifact(primary) }, h(PbIcon, { name: 'file', size: 13 }), '主要成果') : null);
    }));
}
function PbInbox({ rows, seen, onSeen, onOpen }) {
  const [filter, setFilter] = React.useState('all');
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const visible = rows.filter((row) => (filter === 'all' || row.kind === filter) && (!unreadOnly || seen[row.id] !== row.version));
  return h('section', { className: 'pb-inbox', 'aria-label': '待我处理' },
    h('div', { className: 'pb-section-head' }, h('strong', null, '待我处理'), h('span', { className: 'pb-meta' }, rows.length + ' 项')),
    h('p', { className: 'pb-meta' }, '汇总待回答、待决策、显式提交的验收和阻塞。已查看标记仅保存在当前浏览器。'),
    h('div', { className: 'pb-inbox-filters' }, h('select', { className: 'pb-input', value: filter, 'aria-label': '待处理类别', onChange: (event) => setFilter(event.target.value) }, ...Object.entries({ all: '全部类别', question: '待回答', decision: '待决策', review: '待验收', blocked: '受阻' }).map(([key, label]) => h('option', { key, value: key }, label))),
      h('label', null, h('input', { type: 'checkbox', checked: unreadOnly, onChange: (event) => setUnreadOnly(event.target.checked) }), ' 仅未查看')),
    visible.length ? visible.map((row) => h('article', { key: row.id, className: 'pb-inbox-row' + (seen[row.id] === row.version ? ' viewed' : '') },
      h('button', { className: 'pb-list-open', onClick: () => { onSeen(row); onOpen(row); } }, h('span', { className: 'pb-chip' }, row.label), h('strong', null, pbShortSummary(row.title, 140)), h('span', { className: 'pb-meta', title: row.detail }, pbShortSummary(row.detail, 160))),
      h('button', { className: 'pb-btn small', disabled: seen[row.id] === row.version, onClick: () => onSeen(row) }, seen[row.id] === row.version ? '已查看' : '标记已查看'))) : h('div', { className: 'pb-empty' }, '当前筛选下没有待处理项。'));
}
function PbBoardChangeHistory({ board, onUndo, runCommand }) {
  const [pending, setPending] = React.useState(''), [error, setError] = React.useState('');
  const inFlight = React.useRef(false);
  async function undo(id) {
    if (inFlight.current) return;
    inFlight.current = true; setPending(id); setError('');
    try { await onUndo(id); } catch (err) { setError(err.message || '撤销失败'); } finally { inFlight.current = false; setPending(''); }
  }
  return h('section', { className: 'pb-inbox', 'aria-label': '看板变更历史' }, h('strong', null, '最近变更'), h('p', { className: 'pb-meta' }, '撤销会检查相关字段是否仍与本次操作一致，保留其他并发改动。派发和创建会话等外部操作不能撤销。'), error ? h('div', { className: 'pb-error', role: 'alert' }, error) : null,
    ...(board.decisions || []).filter((decision) => !decision.nodeId).map((decision) => h('article', { key: decision.id, className: 'pb-inbox-row', 'data-decision-id': decision.id }, h('strong', null, decision.question), h('span', { className: 'pb-meta' }, decision.status === 'open' ? '待决策' : decision.answer || '已决策'), decision.status === 'open' && runCommand ? h(PbQuickAdd, { placeholder: '填写决策结论…', label: '记录决策', onSubmit: (answer) => runCommand('upsert_decision', { decision: { id: decision.id, answer, status: 'answered' } }, { throwOnError: true }) }) : null)),
    ...(board.changes?.length ? board.changes.map((change) => h('article', { key: change.id, className: 'pb-inbox-row' }, h('strong', null, change.summary), h('span', { className: 'pb-meta' }, pbFormatTime(change.at) + ' · ' + change.actor), change.undo?.status === 'available' ? h('button', { className: 'pb-btn small', disabled: Boolean(pending), onClick: () => undo(change.id) }, pending === change.id ? '撤销中…' : '撤销此操作') : h('span', { className: 'pb-meta', title: change.undo?.reason }, change.undo?.status === 'undone' ? '已撤销' : change.undo?.reason || '不可撤销'))) : [h('div', { key: 'empty', className: 'pb-empty' }, '后续修改会记录在这里。') ]));
}
const PB_EXPLORER_CSS = `
.pb-explorer-toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea);background:var(--dsw-alias-bg-base,#fff)}
.pb-explorer-toolbar .pb-input{width:auto;max-width:175px;font-size:12px;padding:6px 8px;min-height:30px}.pb-explorer-toolbar .pb-board-search{flex:1;min-width:180px;max-width:340px}.pb-view-switch{display:flex;gap:3px}.pb-count{font-variant-numeric:tabular-nums;font-size:11px;min-width:17px;text-align:center;border-radius:5px;background:color-mix(in srgb,currentColor 9%,transparent);padding:1px 4px}
.pb-stage{flex:1;min-width:0;min-height:0;position:relative}.pb-stage-canvas{position:absolute;inset:0;display:flex}.pb-board-list{position:absolute;inset:0;overflow:auto;padding:16px 22px;background:var(--dsw-alias-bg-base,#fff)}.pb-list-heading{display:flex;gap:12px;align-items:baseline;margin-bottom:12px}.pb-list-row{position:relative;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea);padding:10px 0}.pb-list-open{display:flex;flex:1;min-width:0;flex-direction:column;gap:6px;border:0!important;background:transparent;text-align:left;padding:8px!important;border-radius:8px;overflow-wrap:anywhere}.pb-list-open:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}.pb-list-open:focus-visible{outline:2px solid ${PB_ACCENT}}.pb-list-open strong{font-size:13px;font-weight:600}.pb-list-labels{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}.pb-list-artifact{flex:none}.pb-inbox{overflow:auto;min-height:0;padding:18px;flex:1}.pb-inbox>p{line-height:1.6}.pb-inbox-filters{display:flex;align-items:center;gap:10px;margin:14px 0;font-size:12px}.pb-inbox-filters .pb-input{width:auto;font-size:12px}.pb-inbox-row{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea);font-size:13px}.pb-inbox-row>.pb-btn{align-self:flex-start;margin-left:8px}.pb-inbox-row.viewed .pb-list-open{opacity:.66}.pb-inbox-row .pb-chip{align-self:flex-start}.pb-dock-tabs{flex-wrap:wrap}.pb-explorer-toolbar select{color:inherit;background:var(--dsw-alias-bg-base,#fff)}
.pb-edge.related{stroke:${PB_ACCENT};stroke-width:2.4}.pb-edge.unrelated{opacity:.27}.pb-edge-hit:focus-visible+.pb-edge,.pb-edge-hit:hover+.pb-edge{opacity:1}.pb-node.search-muted{filter:saturate(.6);opacity:.46!important}.pb-node.search-match{outline:1px solid color-mix(in srgb,${PB_ACCENT} 48%,transparent)}.pb-card-result{display:flex;align-items:center;gap:7px;padding:7px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#6f777d)}.pb-card-result>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.pb-card-result button{flex:none}.pb-card-summary{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pb-todo-title{border:0;background:transparent;text-align:left;padding:0;color:inherit;font:inherit}.pb-todo-title:focus-visible{outline:2px solid ${PB_ACCENT};outline-offset:2px}
@media(max-width:960px){.pb-explorer-toolbar{padding:8px 10px}.pb-explorer-toolbar .pb-input{max-width:140px}.pb-explorer-toolbar .pb-board-search{max-width:none}.pb-board-list{padding:12px}.pb-list-artifact{max-width:100px}}
`;
