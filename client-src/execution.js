// 运行提示来自关联会话和实际产物，不把任务 doing 或会话 inactive 当作运行/完成。
function pbExecutionContext(board, item, sessionsSnapshot) {
  const items = item.nodeId ? [item, ...pbTaskTodos(board, item.id)] : [item];
  const ids = new Set(items.flatMap((row) => pbThreadsOf(row).map((thread) => thread.sessionId)));
  const teams = items.flatMap((row) => {
    if (!row.team) return [];
    const projection = sessionsSnapshot?.projectionsBySession?.[row.team.leadSessionId]?.values?.agentTeam;
    const task = projection?.tasks?.find((task) => String(task.id) === String(row.team.taskId));
    // Lead 的其他工作不属于这项任务；只有领取本任务的成员运行才计入。
    if (task?.status === 'in_progress' && task.ownerName) {
      const owner = projection.members?.find((member) => member.name === task.ownerName);
      if (owner) ids.add(owner.id);
    }
    return [task || row.team];
  });
  return { items, ids: [...ids], teams };
}

function pbThreadExecutionResult(entries) {
  const last = entries?.[entries.length - 1];
  if (!last) return 'empty';
  if (last.kind === 'note' && /中断|异常结束/.test(last.text || '')) return 'stopped';
  return last.kind === 'assistant' ? 'reply' : 'paused';
}

function pbExecutionVersion(summary) {
  return String(summary?.updatedAt || 0) + ':' + String(summary?.running ?? 'unknown');
}

function useBoardThreadResults(board, sessionsSnapshot) {
  const [results, setResults] = React.useState({});
  const cache = React.useRef(new Map());
  const ids = [...new Set((board?.tasks || []).flatMap((task) => pbExecutionContext(board, task, sessionsSnapshot).ids))].sort();
  const signature = JSON.stringify(ids.map((id) => [id, pbExecutionVersion(sessionsSnapshot?.byId?.[id])]));
  React.useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    const queue = ids.filter((id) => !sessionsSnapshot?.byId?.[id]?.running && cache.current.get(id)?.version !== pbExecutionVersion(sessionsSnapshot?.byId?.[id]));
    async function worker() {
      while (queue.length && !cancelled) {
        const id = queue.shift();
        const version = pbExecutionVersion(sessionsSnapshot?.byId?.[id]);
        let state, time = Number(sessionsSnapshot?.byId?.[id]?.updatedAt) || 0;
        try {
          const value = await pbFetchJson('/api/project-board/thread?sessionId=' + encodeURIComponent(id) + '&limit=12', { signal: abort.signal });
          state = pbThreadExecutionResult(value.entries);
          time = Date.parse(value.entries?.[value.entries.length - 1]?.time) || time;
        } catch {
          if (cancelled) return;
          state = 'unknown';
        }
        if (cancelled) return;
        const result = { version, state, time };
        cache.current.set(id, result);
        setResults((current) => ({ ...current, [id]: result }));
      }
    }
    // 只在关联或会话版本变化时读取；不轮询，也不激活 Agent。
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
    return () => { cancelled = true; abort.abort(); };
  }, [signature]);
  return results;
}

function useBoardJobs(board, sessionsSnapshot, jobs) {
  const snapshot = useObservableSource(jobs.state);
  const ids = [...new Set((board?.tasks || []).flatMap((task) => pbExecutionContext(board, task, sessionsSnapshot).ids))].sort();
  const signature = JSON.stringify(ids);
  React.useEffect(() => {
    const releases = ids.map((id) => jobs.watchRows(id));
    return () => releases.forEach((release) => release());
  }, [signature, jobs]);
  return snapshot;
}

function pbItemExecution(board, item, sessionsSnapshot, sessionStatuses, results, jobsSnapshot) {
  const { items, ids, teams } = pbExecutionContext(board, item, sessionsSnapshot);
  const status = (id) => sessionStatuses?.get(id);
  // roster 包含所有人可见的无主 job；它们不属于当前条目，必须排除。
  const jobs = ids.flatMap((id) => (jobsSnapshot?.rows?.[id] || []).filter((job) => job.owner === id));
  if (ids.some((id) => status(id)?.pendingInteraction)) return { kind: 'waiting', label: '待你处理', title: '关联会话正在等待你的回答或确认。' };
  if (jobs.some((job) => job.status === 'running' || job.status === 'stopping') || ids.some((id) => (status(id)?.running ?? sessionsSnapshot?.byId?.[id]?.running) === true)) return { kind: 'running', label: '运行中', title: '关联会话、领取本任务的成员或其后台作业当前正在执行。' };
  const records = ids.map((id) => results?.[id]?.version === pbExecutionVersion(sessionsSnapshot?.byId?.[id]) ? results[id] : { state: 'unknown', time: Number(sessionsSnapshot?.byId?.[id]?.updatedAt) || 0 });
  const current = records.map((row) => row.state);
  const jobResults = jobs.filter((job) => job.finishedAt).map((job) => ({ time: job.finishedAt, state: job.status === 'completed' ? 'reply' : 'stopped' }));
  const latest = [...records, ...jobResults].sort((a, b) => (b.time || 0) - (a.time || 0))[0];
  if (latest?.state === 'stopped') return { kind: 'stopped', label: '需检查', title: '最近的关联会话被中断或异常结束，请查看记录。' };
  const hasReply = latest?.state === 'reply';
  const hasArtifact = items.some((row) => row.status === 'done' && row.artifacts?.length > 0);
  const completed = item.status === 'done' || teams.some((task) => task.status === 'completed');
  if (hasReply || hasArtifact || completed) return { kind: 'ready', label: '可查看', title: hasReply ? '关联会话已有回复或后台作业已结束，可打开查看；任务验收状态单独保留。' : '已有登记产物或完成记录，可打开查看；任务验收状态单独保留。' };
  if (item.status === 'blocked') return { kind: 'blocked', label: '受阻', title: '任务仍受阻，目前没有可确认的新结果。' };
  if (item.status === 'dropped') return { kind: 'idle', label: '已放弃', title: '此任务已放弃。' };
  if (ids.length && current.includes('unknown')) return { kind: 'idle', label: '待核实', title: '暂时无法确认关联会话结果，点击查看详情。' };
  if (current.includes('paused') || item.status === 'doing' || teams.some((task) => task.status === 'in_progress')) return { kind: 'idle', label: '待继续', title: '当前未运行，尚未确认本轮交付完成。' };
  return { kind: 'idle', label: '待运行', title: '尚未开始执行；派发或创建会话不会自动算作运行。' };
}

function PbExecutionBadge({ value }) {
  return h('span', { className: 'pb-execution-badge ' + value.kind, 'data-execution-state': value.kind, title: value.title },
    h('span', { className: 'pb-execution-dot', 'aria-hidden': true }), value.label);
}
