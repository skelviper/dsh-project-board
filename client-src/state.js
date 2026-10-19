// Shared client state helpers for the project board (inside the module factory).
const h = React.createElement;
const PB_PANEL = 'project-board';
const PB_EVENT = 'project-board:open';
let PB_PENDING_WORKSPACE = '';
const PB_ACCENT = 'var(--dsw-alias-onboarding-accent, #3964fe)';
const PB_KIND_META = {
  theme: { label: '主题', color: '#288d77', icon: 'hub' },
  milestone: { label: '里程碑', color: '#5b7fd9', icon: 'flag' },
  component: { label: '模块', color: '#6d8590', icon: 'box' },
  document: { label: '文档', color: '#c98a3c', icon: 'doc' },
  experiment: { label: '实验', color: '#5b7fd9', icon: 'flask' },
  figure: { label: '图', color: '#b06ad4', icon: 'chart' },
  manuscript: { label: '文稿', color: '#c98a3c', icon: 'doc' },
  infra: { label: '基建', color: '#6d8590', icon: 'box' },
  historical: { label: '历史', color: '#9aa3a8', icon: 'clock' },
};
const PB_STATUS_META = {
  todo: { label: '待办', color: '#9aa3a8' },
  doing: { label: '进行中', color: '#d59c51' },
  blocked: { label: '受阻', color: '#d4665a' },
  done: { label: '完成', color: '#3aa087' },
  active: { label: '进行中', color: '#d59c51' },
  deferred: { label: '暂缓', color: '#9aa3a8' },
  historical: { label: '历史', color: '#9aa3a8' },
  dropped: { label: '已放弃', color: '#9aa3a8' },
};
const PB_TEAM_STATUS = { pending: '待领取', in_progress: '进行中', completed: '已完成', deleted: '已删除' };
const PB_CONNECTION_TYPES = {
  contains: { label: '归属', choice: '归属（分支 → 节点）', prompt: '先点所属分支，再点要加入的节点' },
  depends: { label: '依赖', choice: '依赖（前项 → 后项）', prompt: '先点前置节点，再点依赖它的节点' },
  produces: { label: '产出', choice: '产出（来源 → 成果）', prompt: '先点来源节点，再点产出节点' },
};

function pbNodeBranchPath(board, nodeId) {
  const byId = new Map((board?.nodes || []).map((node) => [node.id, node]));
  const seen = new Set([nodeId]), result = [];
  let current = nodeId;
  while (true) {
    const edge = board?.edges.find((edge) => edge.kind === 'contains' && edge.to === current);
    if (!edge || seen.has(edge.from) || !byId.has(edge.from)) break;
    result.unshift(byId.get(edge.from)); seen.add(edge.from); current = edge.from;
  }
  return result;
}

// 复用已有归属边的ID：更换分支是一次CAS upsert，不先删旧边造成短暂丢失归属。
function pbPlanConnection(board, source, target, kind) {
  if (!Object.hasOwn(PB_CONNECTION_TYPES, kind)) throw new Error('请选择归属、依赖或产出连线');
  const parent = board?.nodes.find((node) => node.id === source);
  const child = board?.nodes.find((node) => node.id === target);
  if (!parent || !child) throw new Error('节点已更新，请刷新后重试');
  if (source === target) throw new Error('不能连接到节点自身');
  const existing = board.edges.filter((edge) => edge.kind === kind && edge.from === source && edge.to === target);
  if (kind !== 'contains') return {
    commands: existing.length ? [] : [{ action: 'upsert_edge', input: { edge: { from: source, to: target, kind } } }],
    message: existing.length ? '这条连线已经存在' : `已创建${PB_CONNECTION_TYPES[kind].label}连线`,
  };
  const outgoing = new Map();
  for (const edge of board.edges) if (edge.kind === 'contains' && edge.to !== target) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const pending = [target], seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === source) throw new Error('不能归入自己的子分支，这会形成归属循环');
    if (seen.has(id)) continue;
    seen.add(id); pending.push(...(outgoing.get(id) || []));
  }
  const incoming = board.edges.filter((edge) => edge.kind === 'contains' && edge.to === target);
  const keep = existing[0] || incoming[0];
  const commands = keep?.from === source ? [] : [{ action: 'upsert_edge', input: { edge: { ...(keep ? { id: keep.id } : {}), from: source, to: target, kind: 'contains', label: '' } } }];
  // 兼容旧数据中的多个归属；只移除多余contains，保留依赖、产出和节点内容。
  for (const edge of incoming) if (edge !== keep) commands.push({ action: 'delete_edge', input: { id: edge.id } });
  return { commands, message: `已将「${child.title}」归入「${parent.title}」` };
}

function pbFetchJson(url, options = {}) {
  return fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  }).then(async (response) => {
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(value?.error?.message || `HTTP ${response.status}`);
      error.code = value?.error?.code;
      error.status = response.status;
      error.value = value;
      throw error;
    }
    return value;
  });
}

// 中文选词的回车和长按回车不应触发提交。
function pbIsSubmitKey(event) {
  const native = event.nativeEvent || event;
  return event.key === 'Enter' && !native.isComposing && native.keyCode !== 229 && !event.repeat && !native.repeat;
}

function pbWorkspaceQuery(path) {
  return 'workspacePath=' + encodeURIComponent(path);
}

function useObservableSource(source) {
  const subscribe = React.useCallback((callback) => source.subscribe(callback), [source]);
  const snapshot = React.useCallback(() => source.getSnapshot(), [source]);
  return React.useSyncExternalStore(subscribe, snapshot);
}

function pbFormatTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return ''; }
}

function pbShortPath(path, max = 46) {
  if (!path) return '';
  return path.length > max ? '…' + path.slice(-(max - 1)) : path;
}

function pbNodeTasks(board, nodeId) {
  if (!board) return [];
  return board.tasks.filter((task) => task.nodeId === nodeId).sort((a, b) => (a.order || 0) - (b.order || 0));
}

// 仅用于打开/选择会话：无独立关联的待办可查看所属任务会话，不改实际绑定。
function pbConversationThreads(item, parentTask) {
  const own = pbThreadsOf(item);
  const inherited = own.length === 0 && !!parentTask && pbThreadsOf(parentTask).length > 0;
  return { threads: inherited ? pbThreadsOf(parentTask) : own, inherited };
}

function pbTaskTodos(board, taskId) {
  if (!board) return [];
  return board.todos.filter((todo) => todo.taskId === taskId).sort((a, b) => (a.order || 0) - (b.order || 0));
}

// 默认预览三项，展开时包含完成和已放弃的任务；待办详情仍由检查器展示。
function pbCanvasTaskPreview(board, nodeId, limit = 3, executionFor, expanded = false) {
  const tasks = pbNodeTasks(board, nodeId);
  const closed = (task) => task.status === 'done' || task.status === 'dropped';
  const priority = { doing: 0, active: 0, blocked: 1, deferred: 1, todo: 2 };
  const rank = (task) => {
    const execution = executionFor?.(task)?.kind;
    return execution === 'running' || execution === 'waiting' ? -2 : execution === 'ready' ? -1 : (priority[task.status] ?? 2);
  };
  const current = tasks.filter((task) => !closed(task)).sort((a, b) => rank(a) - rank(b));
  const ordered = [...current, ...tasks.filter(closed)];
  const visible = expanded ? ordered : ordered.slice(0, limit);
  return { tasks, visible, done: tasks.filter((task) => task.status === 'done').length, hidden: tasks.length - visible.length };
}

// 展开只临时增加同列后续节点的画布偏移，不写回用户保存的位置。
function pbCanvasExpandedLayout(nodes, previews) {
  const placed = [];
  const offsets = new Map();
  for (const node of [...nodes].sort((a, b) => a.y - b.y)) {
    let offset = 0;
    for (const previous of placed) {
      if (previous.node.y < node.y && previous.node.x < node.x + pbCanvasNodeWidth(node) && node.x < previous.node.x + pbCanvasNodeWidth(previous.node)) {
        offset = Math.max(offset, previous.offset + previous.extra);
      }
    }
    const preview = previews.get(node.id);
    const extra = Math.max(0, (preview?.visible.length || 0) - 3) * 26;
    offsets.set(node.id, offset);
    placed.push({ node, offset, extra });
  }
  return { nodes: nodes.map((node) => ({ ...node, y: node.y + offsets.get(node.id) })), offsets };
}

function pbCanvasNodeWidth(node) {
  return ['figure', 'milestone', 'component'].includes(node.kind) ? (node.w || 280) : 230;
}

function pbDerivedNodeStatus(board, nodeId) {
  const node = board?.nodes?.find((row) => row.id === nodeId);
  if (!node) return 'todo';
  if (node.kind === 'historical') return 'historical';
  const stats = pbScopeStats(board, nodeId);
  if (!stats.total) return node.status || 'todo';
  if (stats.doing) return 'doing';
  if (stats.blocked) return 'blocked';
  if (stats.deferred) return 'deferred';
  if (stats.closed === stats.total) return stats.done ? 'done' : stats.dropped ? 'dropped' : 'historical';
  return 'todo';
}

function pbNodeProgress(board, nodeId) {
  const stats = pbScopeStats(board, nodeId);
  return stats.total ? stats : null;
}

function pbTeamTask(board, claim) {
  if (!claim) return null;
  return { claim, status: claim.status, ownerName: claim.ownerName };
}

function pbAgo(value) {
  if (!value) return '';
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return '';
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.floor(hours / 24);
  return days + ' 天前';
}
