// Draggable node-graph canvas (HTML cards + SVG edges, no external libraries).
function PbIcon({ name, size = 16, color }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color || 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  const paths = {
    hub: [h('rect', { key: 1, x: 3, y: 3, width: 7, height: 7, rx: 2 }), h('rect', { key: 2, x: 14, y: 3, width: 7, height: 7, rx: 2 }), h('rect', { key: 3, x: 3, y: 14, width: 7, height: 7, rx: 2 }), h('path', { key: 4, d: 'M14 17.5h7M17.5 14v7' })],
    flag: [h('path', { key: 1, d: 'M5 21V3h14l-3 5 3 5H5' })],
    flask: [h('path', { key: 1, d: 'M9 3h6M10 3v6.5L4.6 18.3A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.7L14 9.5V3' })],
    chart: [h('path', { key: 1, d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' })],
    doc: [h('path', { key: 1, d: 'M6 2h8l4 4v16H6z' }), h('path', { key: 2, d: 'M14 2v5h4M9 12h6M9 16h6' })],
    box: [h('path', { key: 1, d: 'M3 7l9-4 9 4v10l-9 4-9-4z' }), h('path', { key: 2, d: 'M3 7l9 4 9-4M12 11v10' })],
    clock: [h('circle', { key: 1, cx: 12, cy: 12, r: 9 }), h('path', { key: 2, d: 'M12 7v5l3 2' })],
    plus: [h('path', { key: 1, d: 'M12 5v14M5 12h14' })],
    link: [h('path', { key: 1, d: 'M9 15l6-6M8 11a4 4 0 0 1 0-5.7l2.3-2.3a4 4 0 0 1 5.7 5.7L14.7 10M16 13a4 4 0 0 1 0 5.7l-2.3 2.3a4 4 0 0 1-5.7-5.7L9.3 14' })],
    spark: [h('path', { key: 1, d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' }), h('path', { key: 2, d: 'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z' })],
    refresh: [h('path', { key: 1, d: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4' })],
    trash: [h('path', { key: 1, d: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6' })],
    close: [h('path', { key: 1, d: 'M6 6l12 12M18 6L6 18' })],
    chat: [h('path', { key: 1, d: 'M21 12a8 8 0 0 1-8 8H4l2.2-3.3A8 8 0 1 1 21 12z' })],
    play: [h('path', { key: 1, d: 'M8 5v14l11-7z' })],
    check: [h('path', { key: 1, d: 'M4 12.5l5 5L20 6.5' })],
    file: [h('path', { key: 1, d: 'M6 2h8l4 4v16H6z' }), h('path', { key: 2, d: 'M14 2v5h4' })],
    folder: [h('path', { key: 1, d: 'M3 6h6l2 2h10v12H3z' })],
    zoomIn: [h('circle', { key: 1, cx: 11, cy: 11, r: 7 }), h('path', { key: 2, d: 'M20 20l-3.5-3.5M11 8v6M8 11h6' })],
    zoomOut: [h('circle', { key: 1, cx: 11, cy: 11, r: 7 }), h('path', { key: 2, d: 'M20 20l-3.5-3.5M8 11h6' })],
    fit: [h('path', { key: 1, d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' })],
    grid: [h('rect', { key: 1, x: 3, y: 3, width: 7, height: 7, rx: 1.5 }), h('rect', { key: 2, x: 14, y: 3, width: 7, height: 7, rx: 1.5 }), h('rect', { key: 3, x: 3, y: 14, width: 7, height: 7, rx: 1.5 }), h('rect', { key: 4, x: 14, y: 14, width: 7, height: 7, rx: 1.5 })],
    users: [h('circle', { key: 1, cx: 9, cy: 8, r: 3.2 }), h('path', { key: 2, d: 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.5a3 3 0 0 1 0 5.8M18 20c0-2.2-.9-4.2-2.4-5.6' })],
    history: [h('path', { key: 1, d: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4' }), h('path', { key: 2, d: 'M12 8v4l3 2' })],
    chevronRight: [h('path', { key: 1, d: 'M9 6l6 6-6 6' })],
    chevronDown: [h('path', { key: 1, d: 'M6 9l6 6 6-6' })],
    chevronUp: [h('path', { key: 1, d: 'M6 15l6-6 6 6' })],
    chevronLeft: [h('path', { key: 1, d: 'M15 6l-6 6 6 6' })],
  };
  return h('svg', common, ...(paths[name] || paths.hub));
}

const PB_EDGE_OFFSET = 5000;

function pbEdgePath(source, target, kind) {
  // Hierarchy edges leave the theme from the bottom and enter the child from
  // the top; dependency/produce edges connect side anchors. Coordinates are
  // shifted by PB_EDGE_OFFSET because the edge SVG canvas is anchored at
  // (-PB_EDGE_OFFSET, -PB_EDGE_OFFSET).
  const sx = source.x + pbCanvasNodeWidth(source) / 2 + PB_EDGE_OFFSET;
  const tx = (kind === 'contains' ? target.x - 2 : target.x + pbCanvasNodeWidth(target) / 2 - 2) + PB_EDGE_OFFSET;
  const sy = source.y + (kind === 'contains' ? 96 : 48) + PB_EDGE_OFFSET;
  const ty = target.y + (kind === 'contains' ? 0 : 48) + PB_EDGE_OFFSET;
  if (kind === 'contains') {
    const busX = source.x - 18 + PB_EDGE_OFFSET;
    const top = sy + 16;
    // Orthogonal hierarchy bus: down from the theme, left into a shared
    // vertical rail, then into each child's left edge.
    return `M${sx} ${sy} L${sx} ${top} L${busX} ${top} L${busX} ${ty} L${tx} ${ty}`;
  }
  const dx = Math.max(40, Math.abs(tx - sx) * 0.45);
  const c1x = sx + (tx >= sx ? dx : -dx);
  const c2x = tx - (tx >= sx ? dx : -dx);
  return `M${sx} ${sy} C${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`;
}

function BoardCanvas({ board, workspacePath, matchNodeIds, onOpenArtifact, selectedNodeId, selectedEdgeId, connectMode, connectSource, connectPending, connectionHint, onSelectNode, onOpenTask, executionFor, onSelectEdge, onDeleteEdge, onConnectNode, onCreateAt, onMoveNodes, onFit, onLayout, view, setView, onViewport }) {
  const wrapRef = React.useRef(null);
  const interaction = React.useRef(null);
  const edgeMenuRef = React.useRef(null);
  const [dragNode, setDragNode] = React.useState(null);
  const [edgeMenu, setEdgeMenu] = React.useState(null);
  const [deletingEdge, setDeletingEdge] = React.useState(false);
  const [edgeError, setEdgeError] = React.useState('');
  const [expandedTaskNodes, setExpandedTaskNodes] = React.useState(() => {
    const value = pbReadLocal('dsh.project-board.expanded.v1:' + workspacePath, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  });
  React.useEffect(() => { pbWriteLocal('dsh.project-board.expanded.v1:' + workspacePath, expandedTaskNodes); }, [workspacePath, expandedTaskNodes]);
  const previews = new Map(board.nodes.filter((node) => ['figure', 'milestone', 'component'].includes(node.kind)).map((node) => [node.id, pbCanvasTaskPreview(board, node.id, 3, executionFor, Boolean(expandedTaskNodes[node.id]))]));
  const layout = pbCanvasExpandedLayout(board.nodes, previews);
  React.useLayoutEffect(() => { onLayout?.({ board, nodes: layout.nodes, previews }); });
  const menuEdge = edgeMenu && selectedEdgeId === edgeMenu.id ? board.edges.find((edge) => edge.id === edgeMenu.id) : null;

  React.useEffect(() => {
    if (!menuEdge) return undefined;
    const outside = (event) => {
      if (!edgeMenuRef.current?.contains(event.target) && !event.target.closest?.('.pb-edge-hit, .pb-edge-toolbar-delete')) { setEdgeMenu(null); onSelectEdge?.(null); }
    };
    const key = (event) => {
      if (event.key === 'Escape') { setEdgeMenu(null); onSelectEdge?.(null); }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key); };
  }, [Boolean(menuEdge), onSelectEdge]);

  React.useEffect(() => { setEdgeMenu(null); }, [view.x, view.y, view.scale, connectMode]);
  React.useEffect(() => { if (menuEdge) edgeMenuRef.current?.querySelector('.pb-edge-delete')?.focus({ preventScroll: true }); }, [menuEdge?.id]);

  React.useLayoutEffect(() => {
    const menu = edgeMenuRef.current;
    const wrap = wrapRef.current;
    if (!menu || !wrap || !edgeMenu) return;
    const preferredX = edgeMenu.anchorX + menu.offsetWidth + 16 <= wrap.clientWidth ? edgeMenu.anchorX + 8 : edgeMenu.anchorX - menu.offsetWidth - 8;
    const preferredY = edgeMenu.anchorY + menu.offsetHeight + 16 <= wrap.clientHeight ? edgeMenu.anchorY + 8 : edgeMenu.anchorY - menu.offsetHeight - 8;
    const x = Math.max(8, Math.min(preferredX, wrap.clientWidth - menu.offsetWidth - 8));
    const y = Math.max(8, Math.min(preferredY, wrap.clientHeight - menu.offsetHeight - 8));
    if (x !== edgeMenu.x || y !== edgeMenu.y) setEdgeMenu((value) => value && { ...value, x, y });
  }, [edgeMenu]);

  function openEdgeMenu(event, edge) {
    event.preventDefault(); event.stopPropagation();
    const rect = wrapRef.current.getBoundingClientRect();
    let clientX = event.clientX, clientY = event.clientY;
    if (!Number.isFinite(clientX) || event.type === 'keydown') {
      const path = event.currentTarget;
      const middle = path.getPointAtLength(path.getTotalLength() / 2);
      const point = new DOMPoint(middle.x, middle.y).matrixTransform(path.getScreenCTM());
      clientX = point.x; clientY = point.y;
    }
    onSelectEdge?.(edge.id); setEdgeError('');
    setEdgeMenu({ id: edge.id, anchorX: clientX - rect.left, anchorY: clientY - rect.top, x: clientX - rect.left + 8, y: clientY - rect.top + 8 });
  }

  async function deleteMenuEdge() {
    if (!menuEdge || deletingEdge) return;
    setDeletingEdge(true); setEdgeError('');
    try { await onDeleteEdge(menuEdge.id); setEdgeMenu(null); }
    catch (err) { setEdgeError(err.message || '删除连线失败'); }
    finally { setDeletingEdge(false); }
  }

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => onViewport?.({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onViewport]);

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      if (event.target.closest?.('.pb-edge-menu')) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setView((current) => {
        if (event.ctrlKey || event.metaKey) {
          const factor = Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.0018);
          const scale = Math.max(0.28, Math.min(1.9, current.scale * factor));
          return { scale, x: point.x - (point.x - current.x) * (scale / current.scale), y: point.y - (point.y - current.y) * (scale / current.scale) };
        }
        return { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setView]);

  const toScene = (clientX, clientY) => {
    const rect = wrapRef.current.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale };
  };

  function isControlTarget(target) {
    return Boolean(target?.closest('.pb-toolbar, .pb-legend, .pb-edge-menu, .pb-edge-hit, button, a, input, select, textarea, [role="button"]'));
  }

  function startPan(event) {
    if (event.button !== 0) return;
    if (event.target.closest('.pb-node')) return;
    if (isControlTarget(event.target)) return;
    interaction.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, origin: view };
    wrapRef.current.setPointerCapture(event.pointerId);
    onSelectNode?.(null);
    onSelectEdge?.(null);
  }

  function startNodeDrag(event, node) {
    if (event.button !== 0) return;
    event.stopPropagation();
    // 连接只由click/键盘激活一次；pointerdown不能同时选中并清掉source。
    if (connectMode) return;
    interaction.current = { kind: 'node', id: node.id, startX: event.clientX, startY: event.clientY, origin: { x: node.x, y: node.y }, layoutOffset: layout.offsets.get(node.id) || 0, moved: false };
    setDragNode({ id: node.id, x: node.x, y: node.y });
    wrapRef.current.setPointerCapture(event.pointerId);
    onSelectNode?.(node.id);
  }

  function onPointerMove(event) {
    const active = interaction.current;
    if (!active) return;
    if (active.kind === 'pan') {
      setView({ ...active.origin, x: active.origin.x + (event.clientX - active.startX), y: active.origin.y + (event.clientY - active.startY) });
    } else if (active.kind === 'node') {
      const dx = (event.clientX - active.startX) / view.scale;
      const dy = (event.clientY - active.startY) / view.scale;
      if (!active.moved && Math.abs(dx) * view.scale < 3 && Math.abs(dy) * view.scale < 3) return;
      active.moved = true;
      setDragNode({ id: active.id, x: active.origin.x + dx, y: active.origin.y + dy });
    }
  }

  function endInteraction() {
    const active = interaction.current;
    interaction.current = null;
    if (active?.kind === 'node' && dragNode && active.moved) {
      onMoveNodes?.([{ id: dragNode.id, x: Math.round(dragNode.x), y: Math.round(dragNode.y - active.layoutOffset) }]);
    }
    setDragNode(null);
  }

  function zoomAtCenter(factor) {
    setView((value) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      const cx = rect ? rect.width / 2 : 0;
      const cy = rect ? rect.height / 2 : 0;
      const next = Math.min(1.9, Math.max(0.28, value.scale * factor));
      const k = next / value.scale;
      return { ...value, scale: next, x: cx - (cx - value.x) * k, y: cy - (cy - value.y) * k };
    });
  }

  function nodePosition(node) {
    return dragNode && dragNode.id === node.id ? { ...node, x: dragNode.x, y: dragNode.y } : node;
  }

  const nodes = layout.nodes.map(nodePosition);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const connecting = connectMode && connectSource;

  return h('div', {
    ref: wrapRef,
    className: 'pb-canvas-wrap' + (connectMode ? ' pb-connecting' : ''),
    onPointerDown: startPan,
    onPointerMove,
    onPointerUp: endInteraction,
    onPointerCancel: endInteraction,
    onDoubleClick: (event) => {
      if (event.target.closest('.pb-node') || isControlTarget(event.target)) return;
      const point = toScene(event.clientX, event.clientY);
      onCreateAt?.({ x: Math.round(point.x - 115), y: Math.round(point.y - 30) });
    },
  },
  h('div', { className: 'pb-grid' }),
  connectMode ? h('div', { className: 'pb-connection-guide', role: 'status', 'aria-live': 'polite' },
    h('span', null, connectionHint), !connectPending ? h('span', { className: 'pb-meta' }, 'Esc 取消') : null) : null,
  h('div', { className: 'pb-scene', style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } },
    h('svg', { className: 'pb-edges', width: 10000, height: 10000, style: { left: -5000, top: -5000 } },
      h('defs', null,
        h('marker', { id: 'pb-arrow-dep', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
          h('path', { d: 'M0 0L8 4L0 8z', fill: '#c9a96a' })),
        h('marker', { id: 'pb-arrow-prod', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
          h('path', { d: 'M0 0L8 4L0 8z', fill: '#4f9a85' })),
        h('marker', { id: 'pb-arrow-hier', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
          h('path', { d: 'M0 0L8 4L0 8z', fill: '#93a6af' }))),
      ...board.edges.map((edge) => {
        const source = byId.get(edge.from);
        const target = byId.get(edge.to);
        if (!source || !target) return null;
        const edgePath = pbEdgePath(source, target, edge.kind);
        return h('g', { key: edge.id },
          // 透明实线提供稳定的 14px 点击区域，虚线空隙和缩小视图也能点中。
          h('path', {
            d: edgePath, className: 'pb-edge-hit', 'data-edge-id': edge.id,
            role: 'button', tabIndex: 0, 'aria-label': `连线：${source.title} → ${target.title}`,
            'aria-haspopup': 'menu', 'aria-expanded': menuEdge?.id === edge.id,
            // 场景使用 CSS 缩放，显式补偿线宽以保持屏幕上的点击区域大小。
            style: { strokeWidth: 14 / view.scale },
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => openEdgeMenu(event, edge),
            onContextMenu: (event) => openEdgeMenu(event, edge),
            onKeyDown: (event) => { if (event.key === 'Enter') openEdgeMenu(event, edge); else if (event.key === ' ') event.preventDefault(); },
            onKeyUp: (event) => { if (event.key === ' ') openEdgeMenu(event, edge); },
          }),
          h('path', {
            d: edgePath, className: 'pb-edge ' + edge.kind + (selectedNodeId ? (edge.from === selectedNodeId || edge.to === selectedNodeId ? ' related' : ' unrelated') : ''),
            markerEnd: edge.kind === 'depends' ? 'url(#pb-arrow-dep)' : edge.kind === 'produces' ? 'url(#pb-arrow-prod)' : 'url(#pb-arrow-hier)',
            style: selectedEdgeId === edge.id ? { stroke: PB_ACCENT, strokeWidth: 2.6 } : undefined,
          }));
      })),
    ...nodes.map((node) => {
      const meta = PB_KIND_META[node.kind] || PB_KIND_META.experiment;
      const status = pbDerivedNodeStatus(board, node.id);
      const statusMeta = PB_STATUS_META[status] || PB_STATUS_META.todo;
      const progress = pbNodeProgress(board, node.id);
      const preview = previews.get(node.id);
      const hasPreview = Boolean(preview?.tasks.length);
      const tasksExpanded = Boolean(expandedTaskNodes[node.id]);
      const canExpandTasks = (preview?.tasks.length || 0) > 3;
      const tasksId = 'pb-node-tasks-' + node.id;
      const runningCount = preview?.tasks.filter((task) => executionFor(task).kind === 'running').length || 0;
      const readyCount = preview?.tasks.filter((task) => executionFor(task).kind === 'ready').length || 0;
      const activityCount = [runningCount ? `运行 ${runningCount}` : '', readyCount ? `可查看 ${readyCount}` : ''].filter(Boolean).join(' · ');
      const linkCount = node.links?.length || 0;
      const teamTask = node.team || null;
      const resultItems = [node, ...pbNodeTasks(board, node.id).flatMap((task) => [task, ...pbTaskTodos(board, task.id)])];
      const primary = resultItems.map(pbPrimaryArtifact).find(Boolean);
      const selected = selectedNodeId === node.id;
      const isConnectSource = connecting && connectSource === node.id;
      return h('div', {
        key: node.id,
        className: 'pb-node' + (matchNodeIds ? (matchNodeIds.has(node.id) ? ' search-match' : ' search-muted') : '') + (hasPreview ? ' pb-node-with-tasks' : '') + (selected ? ' selected' : '') + (dragNode?.id === node.id ? ' dragging' : ''),
        style: { left: node.x, top: node.y, width: pbCanvasNodeWidth(node), opacity: connecting && !isConnectSource && !selected ? 0.82 : 1, ...(isConnectSource ? { borderColor: PB_ACCENT, boxShadow: `0 0 0 2px color-mix(in srgb, ${PB_ACCENT} 25%, transparent)` } : null) },
        'data-node-id': node.id,
        role: connectMode ? 'button' : undefined, tabIndex: connectMode ? 0 : undefined,
        'aria-label': connectMode ? `选择节点：${node.title}` : undefined,
        'aria-disabled': connectMode ? Boolean(connectPending) : undefined,
        onPointerDown: (event) => startNodeDrag(event, node),
        onClick: (event) => {
          event.stopPropagation();
          if (connectMode) { if (!connectPending) onConnectNode?.(node.id); return; }
          onSelectNode?.(node.id);
        },
        onKeyDown: (event) => {
          if (!connectMode || event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault(); event.stopPropagation();
            if (event.key === 'Enter' && !event.repeat && !connectPending) onConnectNode?.(node.id);
          }
        },
        onKeyUp: (event) => {
          if (connectMode && event.target === event.currentTarget && event.key === ' ') {
            event.preventDefault(); event.stopPropagation();
            if (!connectPending) onConnectNode?.(node.id);
          }
        },
      },
      h('div', { className: 'pb-node-head', title: node.summary || node.title },
        h('span', { className: 'pb-node-kind', style: { color: meta.color } }, h(PbIcon, { name: meta.icon, size: 14 })),
        h('span', { className: 'pb-node-title' }, node.title),
        h('span', { className: 'pb-dot', style: { background: statusMeta.color, marginLeft: 'auto' }, title: statusMeta.label })),
      hasPreview ? h('div', { id: tasksId, className: 'pb-node-tasks', 'aria-label': node.title + '的任务' },
        ...preview.visible.map((task) => {
          const taskStatus = PB_STATUS_META[task.status] || PB_STATUS_META.todo;
          const execution = executionFor(task);
          return h('button', {
            key: task.id, type: 'button', className: 'pb-node-task', 'data-preview-task-id': task.id,
            title: [task.title, taskStatus.label, pbDeliveryLabel(task), task.delivery?.summary, execution.title].filter(Boolean).join(' · '), 'aria-label': task.title + '，' + execution.label + '，查看任务详情',
            disabled: Boolean(connectMode), onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => { event.stopPropagation(); if (!connectMode) onOpenTask?.(node.id, task.id); },
          }, h('span', { className: 'pb-dot', style: { background: taskStatus.color } }),
          h('span', { className: 'pb-node-task-title', title: task.delivery?.summary || '' }, task.title, pbDeliveryLabel(task) ? h('span', { className: 'pb-meta', style: { fontSize: 10 } }, ' · ' + pbDeliveryLabel(task)) : null),
          h(PbExecutionBadge, { value: execution }));
        }),
        !preview.visible.length ? h('span', { className: 'pb-meta' }, '当前没有待推进任务') : null)
        : node.summary ? h('div', { className: 'pb-node-summary' }, node.summary) : null,
      h('div', { className: 'pb-node-foot' },
        h('span', { className: 'pb-chip' }, meta.label),
        hasPreview ? (canExpandTasks ? h('button', {
          type: 'button', className: 'pb-chip pb-node-tasks-all',
          'aria-label': tasksExpanded ? `收起${node.title}的任务` : `展开${node.title}全部 ${preview.tasks.length} 项任务`,
          'aria-expanded': tasksExpanded, 'aria-controls': tasksId,
          title: tasksExpanded ? '收起为默认三项任务' : `展开全部 ${preview.tasks.length} 项任务（含已完成）`,
          disabled: Boolean(connectMode), onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => { event.stopPropagation(); if (!connectMode) setExpandedTaskNodes((value) => ({ ...value, [node.id]: !value[node.id] })); },
        }, tasksExpanded ? '收起' : `展开全部 ${preview.tasks.length} 项`, h(PbIcon, { name: tasksExpanded ? 'chevronUp' : 'chevronDown', size: 11 }))
          : h('span', { className: 'pb-chip' }, `全部 ${preview.tasks.length} 项`))
          : h('span', { className: 'pb-chip' }, `${pbScopeStats(board, node.id).taskCount} 任务`),
        primary ? h('button', { type: 'button', className: 'pb-chip pb-btn small', title: primary.path, disabled: Boolean(connectMode), onPointerDown: (event) => event.stopPropagation(), onClick: (event) => { event.stopPropagation(); if (!connectMode) onOpenArtifact?.(primary); } }, h(PbIcon, { name: 'file', size: 11 }), '主要成果') : null,
        teamTask ? h('span', { className: 'pb-chip', title: '已派发到 Agent Team' }, h(PbIcon, { name: 'users', size: 11 })) : null,
        linkCount && !hasPreview ? h('span', { className: 'pb-chip' }, h(PbIcon, { name: 'folder', size: 11 }), String(linkCount)) : null,
        hasPreview ? h('span', { className: 'pb-node-done-count', title: `任务完成 ${preview.done}/${preview.tasks.length}；点击任务查看详情` }, activityCount || `已完成 ${preview.done}`)
          : progress ? h('span', { className: 'pb-chip', style: { marginLeft: 'auto' }, title: `已结束 ${progress.closed}/${progress.total} · 完成 ${progress.done} · 放弃 ${progress.dropped} · 历史 ${progress.historical}` }, `已结束 ${progress.pct}%`) : null),
      progress && !hasPreview ? h('div', { className: 'pb-progress' }, h('span', { style: { width: progress.pct + '%' } })) : null);
    })),
  board.nodes.length === 0 ? h('div', { className: 'pb-empty big', style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' } },
    h('div', null,
      h('div', { style: { fontSize: 15, fontWeight: 650, marginBottom: 8 } }, '这张看板还是空的'),
      h('div', null, '双击画布或点右上角「+ 节点」开始；也可以让 AI 根据项目生成初稿。'))) : null,
  menuEdge ? h('div', {
    ref: edgeMenuRef, className: 'pb-edge-menu', role: 'menu', 'aria-label': '连线操作',
    'data-edge-id': menuEdge.id, style: { left: edgeMenu.x, top: edgeMenu.y },
    onPointerDown: (event) => event.stopPropagation(),
    onClick: (event) => event.stopPropagation(),
  },
    h('div', { className: 'pb-edge-menu-head' },
      h('span', { className: 'pb-meta' }, ({ contains: '归属连线', depends: '依赖连线', produces: '产出连线' })[menuEdge.kind] || '连线'),
      h('span', { className: 'pb-spacer' }),
      h('button', { type: 'button', className: 'pb-icon-btn', 'aria-label': '关闭连线菜单', onClick: () => { setEdgeMenu(null); onSelectEdge?.(null); } }, h(PbIcon, { name: 'close', size: 12 }))),
    h('div', { className: 'pb-edge-menu-title', title: `${byId.get(menuEdge.from)?.title || menuEdge.from} → ${byId.get(menuEdge.to)?.title || menuEdge.to}` },
      (byId.get(menuEdge.from)?.title || menuEdge.from) + ' → ' + (byId.get(menuEdge.to)?.title || menuEdge.to)),
    h('button', { type: 'button', role: 'menuitem', className: 'pb-edge-delete', disabled: deletingEdge, onClick: deleteMenuEdge }, h(PbIcon, { name: 'trash', size: 14 }), deletingEdge ? '正在删除…' : '删除连线'),
    edgeError ? h('div', { className: 'pb-edge-menu-error', role: 'alert' }, edgeError) : null) : null,
  h('div', { className: 'pb-toolbar' },
    h('button', { className: 'pb-icon-btn', title: '缩小', onClick: () => zoomAtCenter(1 / 1.2) }, h(PbIcon, { name: 'zoomOut', size: 15 })),
    h('span', { style: { fontSize: 11.5, minWidth: 40, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary,#8a9298)' } }, Math.round(view.scale * 100) + '%'),
    h('button', { className: 'pb-icon-btn', title: '放大', onClick: () => zoomAtCenter(1.2) }, h(PbIcon, { name: 'zoomIn', size: 15 })),
    h('span', { style: { width: 1, height: 16, background: 'var(--dsw-alias-border-l1,#e6e8ea)' } }),
    h('button', { className: 'pb-icon-btn', title: '适应画布', onClick: () => onFit?.() }, h(PbIcon, { name: 'fit', size: 15 }))),
  h('div', { className: 'pb-legend' },
    ...[...new Set(['theme', ...board.nodes.map((node) => node.kind)])].filter((kind) => PB_KIND_META[kind]).map((kind) =>
      h('span', { key: kind }, h('i', { style: { width: 8, height: 8, borderRadius: 4, background: PB_KIND_META[kind].color, display: 'inline-block' } }), PB_KIND_META[kind].label))));

}
