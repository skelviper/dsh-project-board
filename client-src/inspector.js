// 节点检查器、任务/待办交付、产物和变更历史。
const PB_DELIVERY_OUTCOMES = { unspecified: '未填写', supported: '支持假设', not_supported: '未支持假设', not_triggered: '条件未触发', inconclusive: '尚无定论' };
const PB_DELIVERY_REVIEWS = { none: '未提交', pending: '待验收', accepted: '已验收', changes_requested: '需修改' };

function pbDeliveryValues(item) {
  return { acceptance: item.acceptance || '', summary: item.delivery?.summary || '', outcome: item.delivery?.outcome || 'unspecified', review: item.delivery?.review || 'none', submittedAt: item.delivery?.submittedAt || '', primaryArtifactPath: item.primaryArtifactPath || '' };
}

// 只写显式改动的字段；旧验收文本不会复制到交付结论，服务端合并 delivery 子字段。
function pbDeliveryPatch(previous, draft) {
  const patch = {}, delivery = {};
  for (const key of ['acceptance', 'primaryArtifactPath']) if (draft[key] !== previous[key]) patch[key] = draft[key];
  for (const key of ['summary', 'outcome', 'review', 'submittedAt']) if (draft[key] !== previous[key]) delivery[key] = draft[key];
  if (Object.keys(delivery).length) patch.delivery = delivery;
  return patch;
}

function pbEditorError(error, fallback, retained = '草稿') {
  const message = error?.message || fallback;
  return /CONFLICT|STALE_REVISION/i.test(error?.code || '')
    ? `版本冲突：${message}。${retained}已保留，请核对最新内容后重试。` : message;
}

function PbExpandableText({ text, empty = '', limit = 150 }) {
  const original = String(text || '');
  if (!original) return empty ? h('div', { className: 'pb-row-sub' }, empty) : null;
  const firstLine = original.trim().split(/\r?\n/).find((line) => line.trim()) || '';
  const brief = firstLine.length > limit ? firstLine.slice(0, limit) + '…' : firstLine;
  return h('div', { className: 'pb-expandable-text' },
    h('div', { className: 'pb-summary-brief' }, brief),
    original !== brief ? h('details', { className: 'pb-original-text' },
      h('summary', null, '展开完整原文'), h('div', { className: 'pb-full-text' }, original)) : null);
}

// 内部按记录挂载，调用者即使忘记 key，异步回调和草稿也不会进入另一条记录。
function PbDeliveryEditor(props) {
  return h(PbDeliveryEditorForm, { ...props, key: props.targetType + ':' + props.item.id });
}

function PbDeliveryEditorForm({ item, targetType, runCommand, onOpenArtifact }) {
  const [draft, setDraft] = React.useState(() => pbDeliveryValues(item));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const saved = React.useRef(pbDeliveryValues(item));
  const pending = React.useRef(false), composing = React.useRef(false);
  React.useEffect(() => {
    const previous = saved.current, next = pbDeliveryValues(item);
    saved.current = next;
    setDraft((current) => Object.fromEntries(Object.keys(next).map((key) => [key, current[key] === previous[key] ? next[key] : current[key]])));
  }, [item.acceptance, item.primaryArtifactPath, item.delivery?.summary, item.delivery?.outcome, item.delivery?.review, item.delivery?.submittedAt]);
  const artifacts = (item.artifacts || []).filter((row, index, all) => row.path && all.findIndex((other) => other.path === row.path) === index);
  const primary = artifacts.find((row) => row.path === item.primaryArtifactPath);
  const dirty = Object.keys(pbDeliveryPatch(saved.current, draft)).length > 0;
  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  async function save(event, submitForReview = false) {
    event.preventDefault();
    if (pending.current || composing.current || event.nativeEvent?.isComposing) return;
    const submitted = submitForReview ? { ...draft, review: 'pending', submittedAt: new Date().toISOString() } : { ...draft };
    const patch = pbDeliveryPatch(saved.current, submitted);
    if (!Object.keys(patch).length) return;
    if (patch.primaryArtifactPath && !artifacts.some((row) => row.path === patch.primaryArtifactPath)) { setError('主成果已不在登记产物中，请重新选择或清除。'); return; }
    if (submitForReview) setDraft(submitted);
    pending.current = true; setSaving(true); setError('');
    try {
      const response = await runCommand(targetType === 'task' ? 'upsert_task' : 'upsert_todo', { [targetType]: { id: item.id, ...patch } }, { throwOnError: true });
      if (!response) throw new Error('保存未成功，草稿已保留，请重试。');
      const stored = response.board?.[targetType === 'task' ? 'tasks' : 'todos']?.find((row) => row.id === item.id);
      const next = stored ? pbDeliveryValues(stored) : submitted;
      saved.current = next;
      setDraft((current) => Object.fromEntries(Object.keys(next).map((key) => [key, current[key] === submitted[key] ? next[key] : current[key]])));
    } catch (err) { setError(pbEditorError(err, '保存失败，草稿已保留，请重试。')); }
    finally { pending.current = false; setSaving(false); }
  }

  return h('section', { className: 'pb-delivery', 'data-delivery-target': targetType + ':' + item.id, onClick: (event) => event.stopPropagation() },
    item.acceptance ? h('div', { className: 'pb-delivery-readout' }, h('span', { className: 'pb-field-caption' }, '验收标准'), h(PbExpandableText, { text: item.acceptance })) : null,
    item.delivery?.summary ? h('div', { className: 'pb-delivery-readout' }, h('span', { className: 'pb-field-caption' }, '交付结论'), h(PbExpandableText, { text: item.delivery.summary })) : null,
    h('div', { className: 'pb-delivery-meta' },
      h('span', { className: 'pb-chip' }, '结果：' + (PB_DELIVERY_OUTCOMES[item.delivery?.outcome] || '未填写')),
      h('span', { className: 'pb-chip' }, PB_DELIVERY_REVIEWS[item.delivery?.review] || '未提交'),
      item.delivery?.submittedAt ? h('time', { dateTime: item.delivery.submittedAt, className: 'pb-row-sub', title: item.delivery.submittedAt }, '提交于 ' + pbFormatTime(item.delivery.submittedAt)) : null),
    primary ? h('button', { type: 'button', className: 'pb-primary-artifact', disabled: !onOpenArtifact, 'data-artifact-path': primary.path, 'aria-haspopup': 'dialog', onClick: () => onOpenArtifact(primary) },
      h('span', { className: 'pb-primary-label' }, '当前采用'), primary.label || primary.path) : null,
    item.primaryArtifactPath && !primary ? h('div', { className: 'pb-row-sub' }, '原主成果已不在登记产物中：' + item.primaryArtifactPath) : null,
    h('details', { className: 'pb-delivery-details' },
      h('summary', null, '编辑验收与交付', dirty ? ' · 有未保存修改' : ''),
      h('form', { className: 'pb-delivery-form', 'aria-busy': saving, onSubmit: save,
        onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
        onKeyDown: (event) => { if (event.key === 'Enter' && !pbIsSubmitKey(event)) event.preventDefault(); } },
        h('label', null, '验收标准', h('textarea', { className: 'pb-input', 'aria-label': '验收标准', rows: 3, value: draft.acceptance, onChange: (event) => change('acceptance', event.target.value), placeholder: '交付需要满足的要求' })),
        h('label', null, '交付结论', h('textarea', { className: 'pb-input', 'aria-label': '交付结论', rows: 3, value: draft.summary, onChange: (event) => change('summary', event.target.value), placeholder: '实际完成的工作、结论与限制' })),
        h('div', { className: 'pb-delivery-selects' },
          h('label', null, '结果标签', h('select', { className: 'pb-select', 'aria-label': '结果标签', value: draft.outcome, onChange: (event) => change('outcome', event.target.value) }, ...Object.entries(PB_DELIVERY_OUTCOMES).map(([value, label]) => h('option', { key: value, value }, label)))),
          h('label', null, '验收状态', h('select', { className: 'pb-select', 'aria-label': '验收状态', value: draft.review, onChange: (event) => change('review', event.target.value) }, ...Object.entries(PB_DELIVERY_REVIEWS).map(([value, label]) => h('option', { key: value, value }, label))))),
        h('label', null, '主成果', h('select', { className: 'pb-select', 'aria-label': '主成果', value: draft.primaryArtifactPath, onChange: (event) => change('primaryArtifactPath', event.target.value) },
          h('option', { value: '' }, '未指定（可清除）'),
          draft.primaryArtifactPath && !artifacts.some((row) => row.path === draft.primaryArtifactPath) ? h('option', { value: draft.primaryArtifactPath, disabled: true }, '已不在登记产物中：' + draft.primaryArtifactPath) : null,
          ...artifacts.map((row) => h('option', { key: row.path, value: row.path }, row.label ? row.label + ' · ' + row.path : row.path)))),
        h('div', { className: 'pb-delivery-meta' }, h('span', { className: 'pb-row-sub' }, draft.submittedAt ? '提交时间：' + pbFormatTime(draft.submittedAt) : '尚未记录提交时间'),
          draft.submittedAt ? h('button', { type: 'button', className: 'pb-btn small', onClick: () => change('submittedAt', '') }, '清除提交时间') : null),
        h('div', { className: 'pb-delivery-actions' },
          h('button', { type: 'submit', className: 'pb-btn small', disabled: saving || !dirty }, saving ? '保存中…' : '保存交付信息'),
          h('button', { type: 'button', className: 'pb-btn small', disabled: saving, onClick: (event) => save(event, true) }, '提交验收')))),
    error ? h('div', { className: 'pb-form-error', role: 'alert' }, error) : null);
}

function PbNodeMembership({ board, node, parentCandidates = [], onReparentNode }) {
  const parents = pbNodeBranchPath(board, node.id);
  const [parentId, setParentId] = React.useState('');
  const [saving, setSaving] = React.useState(false), [error, setError] = React.useState('');
  const pending = React.useRef(false), composing = React.useRef(false);
  const label = parents.length ? '所属分支：' + parents.map((parent) => parent.title).join(' / ') : node.kind === 'theme' ? '顶层项目分支' : '未归属';
  async function submit(event) {
    event.preventDefault();
    if (pending.current || composing.current || !parentId || !onReparentNode) return;
    if (!parentCandidates.some((row) => row.id === parentId)) { setError('所选归属已不可用，请重新选择。'); return; }
    const submitted = parentId;
    pending.current = true; setSaving(true); setError('');
    try {
      const response = await onReparentNode(submitted);
      if (!response) throw new Error('归属未保存，请重试。');
      setParentId((current) => current === submitted ? '' : current);
    } catch (err) { setError(pbEditorError(err, '更改归属失败，请重试。', '选择')); }
    finally { pending.current = false; setSaving(false); }
  }
  return h('div', { className: 'pb-membership-editor' },
    h('div', { className: 'pb-node-membership' + (!parents.length && node.kind !== 'theme' ? ' pb-unassigned' : ''), title: label }, label),
    node.kind !== 'theme' && onReparentNode ? h('form', { className: 'pb-membership-form', onSubmit: submit, 'aria-busy': saving, onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; }, onKeyDown: (event) => { if (event.key === 'Enter' && !pbIsSubmitKey(event)) event.preventDefault(); } },
      h('select', { className: 'pb-select', 'aria-label': '选择所属分支', value: parentId, onChange: (event) => setParentId(event.target.value) },
        h('option', { value: '' }, parentCandidates.length ? '选择所属分支…' : '暂无可选分支'),
        ...parentCandidates.map((parent) => h('option', { key: parent.id, value: parent.id }, parent.title))),
      h('button', { type: 'submit', className: 'pb-btn small', disabled: saving || !parentId }, saving ? '保存中…' : '设置归属')) : null,
    error ? h('div', { className: 'pb-form-error', role: 'alert' }, error) : null);
}

function PbChangeHistory({ board, targetType, targetId, onUndoChange }) {
  const [undoing, setUndoing] = React.useState(''), [error, setError] = React.useState('');
  const pending = React.useRef(false);
  const changes = (board.changes || []).filter((change) => (change.targets || []).some((target) => target.type === targetType && target.id === targetId));
  async function undo(changeId) {
    if (pending.current || !onUndoChange) return;
    pending.current = true; setUndoing(changeId); setError('');
    try {
      const response = await onUndoChange(changeId);
      if (!response) throw new Error('撤销未完成；内容可能已变化，请核对最新历史后重试。');
    } catch (err) { setError(pbEditorError(err, '撤销失败，请核对最新历史后重试。', '当前内容')); }
    finally { pending.current = false; setUndoing(''); }
  }
  return h('section', { className: 'pb-sec pb-change-history' },
    h('h3', null, '变更历史'),
    ...changes.map((change) => h('div', { key: change.id, className: 'pb-change-row', 'data-change-id': change.id },
      h(PbExpandableText, { text: change.summary || change.action }),
      h('div', { className: 'pb-row-sub' }, (change.actor || '未记录操作者') + ' · ' + pbFormatTime(change.at)),
      h('div', { className: 'pb-row-sub' }, (change.targets || []).map((target) => ({ node: '节点', task: '任务', todo: '待办' }[target.type] || target.type) + '：' + (target.title || target.id)).join(' · ')),
      change.undo?.status === 'available' && onUndoChange ? h('button', { type: 'button', className: 'pb-btn small', disabled: !!undoing, onClick: () => undo(change.id) }, undoing === change.id ? '撤销中…' : '撤销此变更') : null,
      change.undo?.status === 'undone' ? h('div', { className: 'pb-row-sub' }, '已撤销' + (change.undo.undoneBy ? ' · ' + change.undo.undoneBy : '') + (change.undo.undoneAt ? ' · ' + pbFormatTime(change.undo.undoneAt) : '')) : null,
      change.undo?.status === 'unavailable' ? h('div', { className: 'pb-row-sub' }, '不可撤销' + (change.undo.reason ? '：' + change.undo.reason : '')) : null)),
    changes.length ? null : h('div', { className: 'pb-empty' }, '暂无变更记录'),
    error ? h('div', { className: 'pb-form-error', role: 'alert' }, error) : null);
}

// 任务、待办、备注共用轻量输入；失败保留草稿，成功只清理本次提交文本。
function PbQuickAdd({ placeholder, onSubmit, label = '添加' }) {
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const pending = React.useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (!draft.trim() || pending.current) return;
    const submitted = draft;
    pending.current = true; setSaving(true); setError('');
    try {
      const response = await onSubmit(submitted.trim());
      if (response) setDraft((current) => current === submitted ? '' : current);
    } catch (err) { setError(err.message || '保存失败，请重试'); }
    finally { pending.current = false; setSaving(false); }
  }
  return h('form', { className: 'pb-quick-add', onSubmit: submit, 'aria-busy': saving },
    h('div', { className: 'pb-form-row' },
      h('input', { className: 'pb-input', 'aria-label': placeholder, placeholder, value: draft,
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && !pbIsSubmitKey(event)) event.preventDefault(); } }),
      h('button', { type: 'submit', className: 'pb-btn small', disabled: saving || !draft.trim() }, saving ? '保存中…' : label)),
    error ? h('div', { className: 'pb-form-error', role: 'alert' }, error) : null);
}

function PbTeamBadge({ sessionsSnapshot, claim }) {
  if (!claim) return null;
  const team = sessionsSnapshot?.projectionsBySession?.[claim.leadSessionId]?.values?.agentTeam;
  const task = team?.tasks?.find((row) => String(row.id) === String(claim.taskId));
  const status = task?.status || claim.status || 'pending';
  const statusMeta = PB_TEAM_STATUS[status] || status;
  return h('span', { className: 'pb-chip', title: `Agent Team 任务 ${claim.taskId}` },
    h(PbIcon, { name: 'users', size: 11 }),
    statusMeta,
    task?.ownerName ? ' · ' + task.ownerName : claim.ownerName ? ' · ' + claim.ownerName : '');
}

function PbStatusSelect({ value, onChange, statuses }) {
  return h('select', { className: 'pb-select', style: { width: 'auto', padding: '2px 6px', fontSize: 12 }, value, onChange: (event) => onChange(event.target.value) },
    ...(statuses || ['todo', 'doing', 'blocked', 'done']).map((status) => h('option', { key: status, value: status }, PB_STATUS_META[status]?.label || status)));
}

function PbTaskRow({ board, task, workspacePath, sessionsSnapshot, runCommand, onOpenTodo, onOpenArtifact, threadUi, taskFocus, executionFor }) {
  const rowRef = React.useRef(null);
  const focused = taskFocus?.taskId === task.id;
  const [expanded, setExpanded] = React.useState(true);
  React.useLayoutEffect(() => { if (focused) setExpanded(true); }, [taskFocus?.requestId]);
  React.useLayoutEffect(() => {
    if (!focused || !expanded || !rowRef.current) return;
    rowRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    rowRef.current.focus({ preventScroll: true });
  }, [taskFocus?.requestId, expanded]);
  const [dispatching, setDispatching] = React.useState(false);
  const todos = pbTaskTodos(board, task.id);
  const statusMeta = PB_STATUS_META[task.status] || PB_STATUS_META.todo;
  const team = sessionsSnapshot?.projectionsBySession?.[task.team?.leadSessionId]?.values?.agentTeam;
  const teamTask = team?.tasks?.find((row) => String(row.id) === String(task.team?.taskId));
  const canDispatch = !task.team;

  return h('div', { ref: rowRef, tabIndex: -1, className: 'pb-task-row' + (focused ? ' pb-task-focused' : ''), 'data-task-id': task.id, style: { border: '1px solid var(--dsw-alias-border-l1,#e6e8ea)', borderRadius: 9, marginBottom: 8, overflow: 'hidden' } },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 9px', background: 'var(--dsw-specific-tip,#f7f9f9)' } },
      h('button', { className: 'pb-icon-btn', title: expanded ? '收起' : '展开', onClick: () => setExpanded(!expanded) }, h(PbIcon, { name: expanded ? 'check' : 'play', size: 13 })),
      h('span', { style: { width: 7, height: 7, borderRadius: 7, background: statusMeta.color, flex: 'none' } }),
      h('span', { style: { flex: 1, minWidth: 140, fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' } }, task.title),
      h(PbExecutionBadge, { value: executionFor(task) }),
      h(PbTeamBadge, { sessionsSnapshot, claim: task.team }),
      h(PbConversationMenu, {
        item: task, targetType: 'task', sessionsSnapshot, compact: true,
        selectedSessionId: threadUi.selectedFor('task', task),
        onSelect: (id) => threadUi.select('task', task.id, id),
        onCreate: () => threadUi.create('task', task.id),
        onRemove: (id) => threadUi.remove('task', task.id, id),
      }),
      h('button', {
        className: 'pb-btn small',
        title: '派发到 Agent Team',
        disabled: !canDispatch || dispatching,
        onClick: async () => {
          setDispatching(true);
          try { await runCommand('__dispatch_task', { taskId: task.id }); } catch { /* panel shows the error */ } finally { setDispatching(false); }
        },
      }, canDispatch ? (dispatching ? '派发中…' : '派发') : '已派发'),
      h('button', { className: 'pb-icon-btn', title: '删除任务', onClick: () => runCommand('delete_task', { id: task.id }) }, h(PbIcon, { name: 'trash', size: 13 }))),
    expanded ? h('div', { style: { padding: '7px 9px 9px' } },
      h(PbDeliveryEditor, { item: task, targetType: 'task', runCommand, onOpenArtifact }),
      task.writeScopes?.length ? h('div', { className: 'pb-row-sub', style: { marginBottom: 6 } }, 'write scopes：' + task.writeScopes.join('、')) : null,
      h('div', { className: 'pb-row-sub', style: { marginBottom: 4 } }, `待办 ${todos.length} 项`),
      ...todos.map((todo) => h('div', { key: todo.id, className: 'pb-todo', 'data-todo-id': todo.id, onClick: () => onOpenTodo(todo.id) },
        h('span', { style: { width: 7, height: 7, borderRadius: 7, marginTop: 6, flex: 'none', background: (PB_STATUS_META[todo.status] || PB_STATUS_META.todo).color } }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'pb-todo-title-line' }, h('button', { type: 'button', className: 'pb-todo-title', 'aria-label': '打开待办：' + todo.title, onClick: (event) => { event.stopPropagation(); onOpenTodo(todo.id); } }, todo.title), h(PbExecutionBadge, { value: executionFor(todo) })),
          h('div', { className: 'pb-todo-meta' },
            h('span', null, (PB_STATUS_META[todo.status] || PB_STATUS_META.todo).label),
            h(PbConversationMenu, {
              item: todo, parentTask: task, targetType: 'todo', sessionsSnapshot, compact: true,
              selectedSessionId: threadUi.selectedFor('todo', todo),
              onSelect: (id) => threadUi.select('todo', todo.id, id),
              onCreate: () => threadUi.create('todo', todo.id),
              onRemove: (id) => threadUi.remove('todo', todo.id, id),
            }),
            todo.team ? h(PbTeamBadge, { sessionsSnapshot, claim: todo.team }) : null),
          h(PbDeliveryEditor, { item: todo, targetType: 'todo', runCommand, onOpenArtifact })),
        h('div', { className: 'pb-actions' },
          h('button', { className: 'pb-icon-btn', title: '删除待办', onClick: (event) => { event.stopPropagation(); runCommand('delete_todo', { id: todo.id }); } }, h(PbIcon, { name: 'trash', size: 12 }))))),
      todos.length === 0 ? h('div', { className: 'pb-row-sub', style: { margin: '2px 0 6px' } }, '还没有待办') : null,
      h(PbQuickAdd, { placeholder: '新增待办事项…（回车添加）',
        onSubmit: (title) => runCommand('upsert_todo', { todo: { taskId: task.id, title } }) })) : null);
}

function PbArtifactPreview({ workspacePath, row, onOpenArtifact }) {
  const url = '/api/project-board/artifact?' + pbWorkspaceQuery(workspacePath) + '&path=' + encodeURIComponent(row.path);
  const ext = (row.path.split('.').pop() || '').toLowerCase();
  const link = {
    href: url, 'aria-haspopup': 'dialog', 'data-artifact-path': row.path,
    onClick: (event) => { event.preventDefault(); event.stopPropagation(); onOpenArtifact(row); },
  };
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) {
    return h('a', { ...link, style: { display: 'block', marginTop: 6 } },
      h('img', { src: url, alt: row.label || row.path, style: { maxWidth: '100%', maxHeight: 200, objectFit: 'contain', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1,#e6e8ea)' } }));
  }
  return h('a', { ...link, className: 'pb-chip', style: { marginTop: 5, textDecoration: 'none' } }, h(PbIcon, { name: row.kind === 'dir' ? 'folder' : 'file', size: 11 }), row.label || pbShortPath(row.path, 40));
}

function PbNodeInspector({ board, node, workspacePath, sessionsSnapshot, runCommand, onOpenTodo, onClose, onDispatchTask, threadUi, tab = 'overview', onTabChange, onOpenArtifact, taskFocus, executionFor, parentCandidates, onReparentNode, onUndoChange }) {
  const tasks = pbNodeTasks(board, node.id);
  const scrollRef = React.useRef(null);
  React.useLayoutEffect(() => {
    if (taskFocus && !taskFocus.taskId && tab === 'overview' && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [taskFocus?.requestId, tab]);
  const [summary, setSummary] = React.useState(node.summary || '');
  const [savingSummary, setSavingSummary] = React.useState(false);
  const [summaryError, setSummaryError] = React.useState('');
  const summaryPending = React.useRef(false), summaryComposing = React.useRef(false);
  const notes = board.notes.filter((row) => row.targetType === 'node' && row.targetId === node.id);
  const decisions = board.decisions.filter((row) => row.nodeId === node.id);
  const meta = PB_KIND_META[node.kind] || PB_KIND_META.experiment;
  const status = pbDerivedNodeStatus(board, node.id);
  const savedSummary = React.useRef(node.summary || '');
  React.useEffect(() => {
    const previous = savedSummary.current;
    savedSummary.current = node.summary || '';
    setSummary((current) => current === previous ? savedSummary.current : current);
  }, [node.summary]);

  const artifacts = [
    ...(node.links || []).map((row) => ({ ...row, label: row.label || row.path, source: '链接' })),
    ...tasks.flatMap((task) => (task.artifacts || []).map((row) => ({ ...row, label: row.label || row.path, source: task.title, primary: task.primaryArtifactPath === row.path }))),
    ...tasks.flatMap((task) => pbTaskTodos(board, task.id).flatMap((todo) => (todo.artifacts || []).map((row) => ({ ...row, label: row.label || row.path, source: task.title + ' / ' + todo.title, primary: todo.primaryArtifactPath === row.path })))),
  ];

  async function saveSummary(event) {
    event.preventDefault();
    if (summaryPending.current || summaryComposing.current || summary === (node.summary || '')) return;
    summaryPending.current = true; setSavingSummary(true); setSummaryError('');
    try {
      const response = await runCommand('upsert_node', { node: { id: node.id, summary } }, { throwOnError: true });
      if (!response) throw new Error('概览未保存，草稿已保留，请重试。');
    } catch (err) { setSummaryError(pbEditorError(err, '保存失败，草稿已保留，请重试。')); }
    finally { summaryPending.current = false; setSavingSummary(false); }
  }

  // 概览占一行，任务紧接下方；回车和保存按钮使用同一写入命令。
  const overviewEditor = h('div', null, h('form', { className: 'pb-sec pb-overview-editor', onSubmit: saveSummary,
    onCompositionStart: () => { summaryComposing.current = true; }, onCompositionEnd: () => { summaryComposing.current = false; } },
    h('label', { htmlFor: 'pb-node-overview' }, '概览'),
    h('input', {
      id: 'pb-node-overview', type: 'text', className: 'pb-input', 'aria-label': '概览',
      placeholder: '编辑节点概览…', value: summary, title: summary,
      onChange: (event) => setSummary(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter' && !pbIsSubmitKey(event)) event.preventDefault(); },
    }),
    h('button', { type: 'submit', className: 'pb-btn small', disabled: savingSummary || summary === (node.summary || '') }, savingSummary ? '保存中…' : '保存')),
    summaryError ? h('div', { className: 'pb-form-error', role: 'alert' }, summaryError) : null,
    summary.length > 150 || /[\r\n]/.test(summary) ? h('div', { className: 'pb-sec pb-overview-original' }, h(PbExpandableText, { text: summary })) : null);

  const sourcesSection = h('div', null,
    h('div', { className: 'pb-sec' },
      h('h3', null, '链接与来源'),
      ...(node.links || []).map((row, index) => h('div', { key: index, className: 'pb-row' },
        h(PbIcon, { name: row.kind === 'dir' ? 'folder' : 'file', size: 13 }),
        h('a', { className: 'pb-row-text', href: '/api/project-board/artifact?' + pbWorkspaceQuery(workspacePath) + '&path=' + encodeURIComponent(row.path), 'aria-haspopup': 'dialog', onClick: (event) => { event.preventDefault(); onOpenArtifact(row); }, style: { color: 'inherit', textDecoration: 'none' } },
          h('div', { className: 'pb-row-title' }, row.label || row.path),
          h('div', { className: 'pb-row-sub' }, row.path)))),
      (node.links || []).length === 0 ? h('div', { className: 'pb-empty' }, '还没有链接文件') : null,
      (node.derivedFrom || []).length ? h('div', { className: 'pb-row-sub', style: { marginTop: 8 } }, '状态来源：' + node.derivedFrom.join('、')) : null,
      (node.tags || []).length ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 } },
        ...node.tags.map((tag) => h('span', { key: tag, className: 'pb-chip' }, tag))) : null));

  const tasksTab = h('div', { className: 'pb-sec' },
    h('h3', null, '任务'),
    ...tasks.map((task) => h(PbTaskRow, { key: task.id, board, task, workspacePath, sessionsSnapshot, runCommand, onOpenTodo, onOpenArtifact, threadUi, taskFocus, executionFor })),
    tasks.length === 0 ? h('div', { className: 'pb-empty' }, '还没有任务') : null,
    h(PbQuickAdd, { placeholder: '新增任务…（回车添加）',
      onSubmit: (title) => runCommand('upsert_task', { task: { nodeId: node.id, title } }) }));

  const artifactsTab = h('div', { className: 'pb-sec' },
    h('h3', null, '产物与文件'),
    ...artifacts.map((row, index) => h('div', { key: index, style: { marginBottom: 10 } },
      h('div', { className: 'pb-row-sub' }, row.primary ? h('span', { className: 'pb-primary-label' }, '当前采用') : null, row.source + ' · ' + row.path),
      h(PbArtifactPreview, { workspacePath, row, onOpenArtifact }))),
    artifacts.length === 0 ? h('div', { className: 'pb-empty' }, '还没有产物链接') : null);

  const historyTab = h('div', null,
    h(PbChangeHistory, { key: 'node:' + node.id, board, targetType: 'node', targetId: node.id, onUndoChange }),
    h('div', { className: 'pb-sec' },
      h('h3', null, '备注'),
      ...notes.map((row) => h('div', { key: row.id, className: 'pb-row' },
        h('div', { className: 'pb-row-text' },
          h(PbExpandableText, { text: row.text }),
          h('div', { className: 'pb-row-sub' }, (row.author || '我') + ' · ' + pbFormatTime(row.createdAt))),
        h('button', { className: 'pb-icon-btn', onClick: () => runCommand('delete_note', { id: row.id }) }, h(PbIcon, { name: 'trash', size: 12 })))),
      h(PbQuickAdd, { placeholder: '新增备注…（回车保存）',
        onSubmit: (text) => runCommand('add_note', { targetType: 'node', targetId: node.id, text, author: '我' }) }),
      h('h3', { style: { marginTop: 14 } }, '决策项'),
      ...decisions.map((row) => h('div', { key: row.id, className: 'pb-row', 'data-decision-id': row.id },
        h('div', { className: 'pb-row-text' },
          h(PbExpandableText, { text: row.question }),
          h('div', { className: 'pb-row-sub' }, row.status === 'open' ? '待决策' : '已答复'),
          row.status !== 'open' && row.answer ? h(PbExpandableText, { text: row.answer }) : null))),
      decisions.length === 0 ? h('div', { className: 'pb-empty' }, '没有决策项') : null));

  const overviewAndTasks = h(React.Fragment, null, overviewEditor, tasksTab, sourcesSection);
  const content = tab === 'artifacts' ? artifactsTab : tab === 'history' ? historyTab : overviewAndTasks;

  return h('div', { className: 'pb-inspector' },
    h('div', { className: 'pb-inspector-head' },
      h('h2', { className: 'pb-inspector-title' },
        h('span', { className: 'pb-node-kind', style: { color: meta.color } }, h(PbIcon, { name: meta.icon, size: 14 })),
        node.title),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 7, alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { className: 'pb-chip' }, meta.label),
        h(PbStatusSelect, { value: status, onChange: (next) => runCommand('upsert_node', { node: { id: node.id, status: next === 'active' ? 'doing' : next } }), statuses: ['todo', 'doing', 'blocked', 'done', 'deferred', 'historical'] }),
        h('span', { className: 'pb-meta' }, node.id),
        h('span', { className: 'pb-spacer' }),
        h('button', { className: 'pb-icon-btn', title: '删除节点', onClick: () => { if (window.confirm('删除节点「' + node.title + '」及其任务和待办？')) runCommand('delete_node', { id: node.id }); } }, h(PbIcon, { name: 'trash', size: 14 })),
        h('button', { className: 'pb-icon-btn', title: '取消选择', onClick: onClose }, h(PbIcon, { name: 'close', size: 15 }))),
      h(PbNodeMembership, { key: node.id, board, node, parentCandidates, onReparentNode }),
      h('div', { className: 'pb-tabs', role: 'tablist' },
        ...[['overview', '概览和任务'], ['artifacts', '产物'], ['history', '历史']].map(([id, label]) =>
          h('button', { key: id, className: 'pb-tab', role: 'tab', 'aria-selected': id === 'overview' ? tab !== 'artifacts' && tab !== 'history' : tab === id, onClick: () => onTabChange(id) }, label)))),
    h('div', { ref: scrollRef, className: 'pb-scroll' }, content));
}
