// Inspector, task/todo editing, artifacts, notes, and the todo conversation drawer.
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

function PbTaskRow({ board, task, workspacePath, sessionsSnapshot, runCommand, onOpenTodo, threadUi, taskFocus, executionFor }) {
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
      task.acceptance ? h('div', { className: 'pb-row-sub', style: { marginBottom: 6 } }, '验收：' + task.acceptance) : null,
      task.writeScopes?.length ? h('div', { className: 'pb-row-sub', style: { marginBottom: 6 } }, 'write scopes：' + task.writeScopes.join('、')) : null,
      h('div', { className: 'pb-row-sub', style: { marginBottom: 4 } }, `待办 ${todos.length} 项`),
      ...todos.map((todo) => h('div', { key: todo.id, className: 'pb-todo', 'data-todo-id': todo.id, onClick: () => onOpenTodo(todo.id) },
        h('span', { style: { width: 7, height: 7, borderRadius: 7, marginTop: 6, flex: 'none', background: (PB_STATUS_META[todo.status] || PB_STATUS_META.todo).color } }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'pb-todo-title-line' }, h('div', { className: 'pb-todo-title' }, todo.title), h(PbExecutionBadge, { value: executionFor(todo) })),
          h('div', { className: 'pb-todo-meta' },
            h('span', null, (PB_STATUS_META[todo.status] || PB_STATUS_META.todo).label),
            h(PbConversationMenu, {
              item: todo, parentTask: task, targetType: 'todo', sessionsSnapshot, compact: true,
              selectedSessionId: threadUi.selectedFor('todo', todo),
              onSelect: (id) => threadUi.select('todo', todo.id, id),
              onCreate: () => threadUi.create('todo', todo.id),
              onRemove: (id) => threadUi.remove('todo', todo.id, id),
            }),
            todo.team ? h(PbTeamBadge, { sessionsSnapshot, claim: todo.team }) : null,
            todo.acceptance ? h('span', null, '验收：' + todo.acceptance.slice(0, 40)) : null)),
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

function PbNodeInspector({ board, node, workspacePath, sessionsSnapshot, runCommand, onOpenTodo, onClose, onDispatchTask, threadUi, tab = 'overview', onTabChange, onOpenArtifact, taskFocus, executionFor }) {
  const tasks = pbNodeTasks(board, node.id);
  const scrollRef = React.useRef(null);
  React.useLayoutEffect(() => {
    if (taskFocus && !taskFocus.taskId && tab === 'overview' && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [taskFocus?.requestId, tab]);
  const [summary, setSummary] = React.useState(node.summary || '');
  const [savingSummary, setSavingSummary] = React.useState(false);
  const notes = board.notes.filter((row) => row.targetType === 'node' && row.targetId === node.id);
  const decisions = board.decisions.filter((row) => row.nodeId === node.id);
  const meta = PB_KIND_META[node.kind] || PB_KIND_META.experiment;
  const status = pbDerivedNodeStatus(board, node.id);
  const branchPath = pbNodeBranchPath(board, node.id);
  const branchLabel = branchPath.length ? '所属分支：' + branchPath.map((parent) => parent.title).join(' / ')
    : node.kind === 'theme' ? '顶层项目分支' : '未归属 · 用「连线 → 归属」加入分支';
  const savedSummary = React.useRef(node.summary || '');
  React.useEffect(() => {
    const previous = savedSummary.current;
    savedSummary.current = node.summary || '';
    setSummary((current) => current === previous ? savedSummary.current : current);
  }, [node.summary]);

  const artifacts = [
    ...(node.links || []).map((row) => ({ ...row, label: row.label || row.path, source: '链接' })),
    ...tasks.flatMap((task) => (task.artifacts || []).map((row) => ({ ...row, label: row.label || row.path, source: task.title }))),
    ...tasks.flatMap((task) => pbTaskTodos(board, task.id).flatMap((todo) => (todo.artifacts || []).map((row) => ({ ...row, label: row.label || row.path, source: task.title + ' / ' + todo.title })))),
  ];

  async function saveSummary(event) {
    event.preventDefault();
    if (savingSummary || summary === (node.summary || '')) return;
    setSavingSummary(true);
    try { await runCommand('upsert_node', { node: { id: node.id, summary } }); }
    finally { setSavingSummary(false); }
  }

  // 概览占一行，任务紧接下方；回车和保存按钮使用同一写入命令。
  const overviewEditor = h('form', { className: 'pb-sec pb-overview-editor', onSubmit: saveSummary },
    h('label', { htmlFor: 'pb-node-overview' }, '概览'),
    h('input', {
      id: 'pb-node-overview', type: 'text', className: 'pb-input', 'aria-label': '概览',
      placeholder: '编辑节点概览…', value: summary, title: summary,
      onChange: (event) => setSummary(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter' && !pbIsSubmitKey(event)) event.preventDefault(); },
    }),
    h('button', { type: 'submit', className: 'pb-btn small', disabled: savingSummary || summary === (node.summary || '') }, savingSummary ? '保存中…' : '保存'));

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
    ...tasks.map((task) => h(PbTaskRow, { key: task.id, board, task, workspacePath, sessionsSnapshot, runCommand, onOpenTodo, threadUi, taskFocus, executionFor })),
    tasks.length === 0 ? h('div', { className: 'pb-empty' }, '还没有任务') : null,
    h(PbQuickAdd, { placeholder: '新增任务…（回车添加）',
      onSubmit: (title) => runCommand('upsert_task', { task: { nodeId: node.id, title } }) }));

  const artifactsTab = h('div', { className: 'pb-sec' },
    h('h3', null, '产物与文件'),
    ...artifacts.map((row, index) => h('div', { key: index, style: { marginBottom: 10 } },
      h('div', { className: 'pb-row-sub' }, row.source + ' · ' + row.path),
      h(PbArtifactPreview, { workspacePath, row, onOpenArtifact }))),
    artifacts.length === 0 ? h('div', { className: 'pb-empty' }, '还没有产物链接') : null);

  const historyTab = h('div', null,
    h('div', { className: 'pb-sec' },
      h('h3', null, '备注'),
      ...notes.map((row) => h('div', { key: row.id, className: 'pb-row' },
        h('div', { className: 'pb-row-text' },
          h('div', { className: 'pb-row-title' }, row.text),
          h('div', { className: 'pb-row-sub' }, (row.author || '我') + ' · ' + pbFormatTime(row.createdAt))),
        h('button', { className: 'pb-icon-btn', onClick: () => runCommand('delete_note', { id: row.id }) }, h(PbIcon, { name: 'trash', size: 12 })))),
      h(PbQuickAdd, { placeholder: '新增备注…（回车保存）',
        onSubmit: (text) => runCommand('add_note', { targetType: 'node', targetId: node.id, text, author: '我' }) }),
      h('h3', { style: { marginTop: 14 } }, '决策项'),
      ...decisions.map((row) => h('div', { key: row.id, className: 'pb-row' },
        h('div', { className: 'pb-row-text' },
          h('div', { className: 'pb-row-title' }, row.question),
          h('div', { className: 'pb-row-sub' }, row.status === 'open' ? '待决策' : '已答复：' + (row.answer || ''))))),
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
      h('div', { className: 'pb-node-membership', title: branchLabel }, branchLabel),
      h('div', { className: 'pb-tabs', role: 'tablist' },
        ...[['overview', '概览和任务'], ['artifacts', '产物'], ['history', '历史']].map(([id, label]) =>
          h('button', { key: id, className: 'pb-tab', role: 'tab', 'aria-selected': id === 'overview' ? tab !== 'artifacts' && tab !== 'history' : tab === id, onClick: () => onTabChange(id) }, label)))),
    h('div', { ref: scrollRef, className: 'pb-scroll' }, content));
}
