// 看板内的产物预览，复用 DSH 的只读 workspaceFiles RPC，不切换主面板或创建会话。
function pbPreviewPath(workspacePath, value) {
  let input = String(value || '').replaceAll('\\', '/');
  const root = workspacePath.replace(/\/+$/, '');
  if (input === root) input = '';
  else if (input.startsWith(root + '/')) input = input.slice(root.length + 1);
  else if (input.startsWith('/') || /^[a-z]+:/i.test(input)) throw new Error('预览路径必须位于当前项目内');
  const parts = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('预览路径必须位于当前项目内'); parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

function pbPreviewSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// Markdown 图片和链接相对于文档目录解析，继续限制在当前 workspace 内。
function pbPreviewDestination(workspacePath, documentPath, value) {
  const destination = String(value).split(/[?#]/, 1)[0];
  if (!destination || /^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//')) return null;
  const decoded = decodeURIComponent(destination);
  return pbPreviewPath(workspacePath, decoded.startsWith('/') ? decoded : documentPath.slice(0, documentPath.lastIndexOf('/') + 1) + decoded);
}

function PbPreviewMarkdown({ workspacePath, path, text, onOpen }) {
  const labels = React.useMemo(() => ({ code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消自动换行' } }, footnotes: '脚注' }), []);
  const pathImages = React.useMemo(() => ({ resolve: (value) => {
    try {
      const relative = pbPreviewDestination(workspacePath, path, value);
      if (relative === null) return undefined;
      return new URL('api/file?path=' + encodeURIComponent(workspacePath.replace(/\/+$/, '') + '/' + relative), document.baseURI).href;
    } catch { return undefined; }
  } }), [workspacePath, path]);
  return h(MarkdownDelegateProvider, { openFile: async (value, options) => onOpen(value, options) },
    h('article', { className: 'pb-preview-markdown', tabIndex: 0 }, h(MarkdownText, { text, streaming: false, labels, pathImages })));
}

// 弹层保持居中，尺寸随视口收缩，右下角拖动时两侧同步伸缩。
function pbPreviewBounds(width, height) {
  const padding = window.innerWidth <= 760 ? 16 : 40;
  const maxWidth = Math.max(1, window.innerWidth - padding);
  const maxHeight = Math.max(1, window.innerHeight - padding);
  return { width: Math.min(maxWidth, Math.max(Math.min(420, maxWidth), width)), height: Math.min(maxHeight, Math.max(Math.min(280, maxHeight), height)) };
}

function PbArtifactViewer({ workspacePath, row, sessionId, workspaceFiles, onClose }) {
  const [target, setTarget] = React.useState(() => ({ path: row.path, kind: row.kind }));
  const [back, setBack] = React.useState([]);
  const [offset, setOffset] = React.useState(() => Number.isInteger(row.line) && row.line > 0 ? row.line : 1);
  const [reload, setReload] = React.useState(0);
  const [view, setView] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [markdownRendered, setMarkdownRendered] = React.useState(false);
  const [size, setSize] = React.useState(null);
  const [maximized, setMaximized] = React.useState(false);
  const [resizing, setResizing] = React.useState(false);
  const resizeRef = React.useRef(null);
  const dialogRef = React.useRef(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const key = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll('button:not(:disabled),a[href],input,iframe,[tabindex="0"]') || [])];
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  React.useEffect(() => {
    const fit = () => setSize((current) => current ? pbPreviewBounds(current.width, current.height) : null);
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  function startResize(event) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const rect = dialogRef.current.getBoundingClientRect();
    resizeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSize(pbPreviewBounds(rect.width, rect.height)); setMaximized(false); setResizing(true);
  }

  function moveResize(event) {
    const start = resizeRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setSize(pbPreviewBounds(start.width + 2 * (event.clientX - start.x), start.height + 2 * (event.clientY - start.y)));
  }

  function stopResize(event) {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null; setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeKey(event) {
    const step = event.shiftKey ? 80 : 20;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const rect = dialogRef.current.getBoundingClientRect();
    setSize(pbPreviewBounds(rect.width + delta[0], rect.height + delta[1])); setMaximized(false);
  }

  React.useEffect(() => {
    const controller = new AbortController();
    let objectUrl;
    let stopped = false;
    setView(null); setError(''); setLoading(true);
    const read = async (method, ...args) => {
      const result = await workspaceFiles[method](sessionId, ...args, controller.signal);
      if (!result.ok) throw new Error(result.error?.message || '读取失败');
      return result.value;
    };
    (async () => {
      try {
        if (!sessionId || !workspaceFiles) throw new Error('当前项目会话尚未就绪，请稍后重试');
        const file = pbPreviewPath(workspacePath, target.path);
        let directory = target.kind === 'dir' || target.kind === 'directory' || file === '';
        let stat;
        let listing;
        if (!directory) {
          try { stat = await read('stat', file); }
          catch (fileError) {
            try { listing = await read('list', file); directory = true; }
            catch { throw fileError; }
          }
        }
        let next;
        if (directory) {
          listing = listing || await read('list', file || '.');
          const entries = [...listing.entries].sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
          next = { kind: 'directory', path: listing.path, entries, truncated: listing.truncated };
        } else {
          const ext = (file.split('.').pop() || '').toLowerCase();
          const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
          if (imageTypes[ext] || ext === 'pdf') {
            const bytes = await read('readBytes', file, {});
            if (stopped) return;
            objectUrl = URL.createObjectURL(new Blob([bytes.data], { type: imageTypes[ext] || 'application/pdf' }));
            next = { kind: ext === 'pdf' ? 'pdf' : 'image', path: file, url: objectUrl, bytes: bytes.bytes };
          } else if (['zip', 'gz', 'tar', 'bz2', 'xz', 'zst', 'zstd', 'npz', 'npy', 'h5', 'hdf5', 'parquet', 'xlsx', 'docx', 'pptx', 'pkl', 'pickle', 'bin', 'exe'].includes(ext)) {
            next = { kind: 'unsupported', path: file, bytes: stat?.bytes };
          } else if (markdownRendered && /\.(md|markdown|mdown|mkd)$/i.test(file)) {
            // 完整读取后再解析，避免源码分页切断表格、代码块或链接定义。
            const bytes = await read('readBytes', file, {});
            const text = new TextDecoder().decode(bytes.data);
            next = { kind: 'text', path: file, text, offset: 1, lines: text ? text.split('\n').length : 0, eof: true, bytes: bytes.bytes, fullMarkdown: true };
          } else {
            const text = await read('read', file, { offset, limit: 400 });
            next = { kind: 'text', path: file, text: text.text, offset: text.offset, lines: text.lines, eof: text.eof, bytes: text.bytes };
          }
        }
        if (!stopped) setView(next);
      } catch (err) { if (!stopped && !controller.signal.aborted) setError(err.message); }
      finally { if (!stopped) setLoading(false); }
    })();
    return () => { stopped = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [workspacePath, target.path, target.kind, sessionId, workspaceFiles, offset, reload, markdownRendered]);

  function navigate(path, kind, line = 1) {
    setBack((items) => [...items, { ...target, offset }]);
    setTarget({ path, kind }); setOffset(line);
  }

  function openMarkdownFile(value, options) {
    try {
      const path = pbPreviewDestination(workspacePath, currentPath, value);
      if (path === null) return;
      if (options?.line) setMarkdownRendered(false);
      navigate(path, 'file', options?.line || 1);
    } catch (err) { setError(err.message); }
  }

  function goBack() {
    const previous = back[back.length - 1];
    if (!previous) return;
    setBack((items) => items.slice(0, -1));
    setTarget({ path: previous.path, kind: previous.kind }); setOffset(previous.offset || 1);
  }

  let currentPath = String(target.path || '');
  try { currentPath = pbPreviewPath(workspacePath, currentPath); } catch { /* 错误在内容区显示 */ }
  const parts = currentPath.split('/').filter(Boolean);
  const downloadUrl = '/api/project-board/artifact?' + pbWorkspaceQuery(workspacePath) + '&path=' + encodeURIComponent(currentPath);
  const isDirectory = view?.kind === 'directory';
  const isMarkdown = !isDirectory && /\.(md|markdown|mdown|mkd)$/i.test(currentPath);
  const crumbButtons = [h('button', { type: 'button', key: 'root', onClick: () => navigate('', 'directory'), title: workspacePath }, '项目')];
  parts.forEach((part, index) => {
    crumbButtons.push(h('span', { key: 'sep:' + index, 'aria-hidden': true }, '/'));
    crumbButtons.push(h('button', { type: 'button', key: 'part:' + index, disabled: index === parts.length - 1, onClick: () => navigate(parts.slice(0, index + 1).join('/'), 'directory') }, part));
  });

  let content = null;
  if (loading) content = h('div', { className: 'pb-preview-empty', role: 'status' }, '正在读取…');
  else if (error) content = h('div', { className: 'pb-preview-empty' }, h('p', { role: 'alert' }, error), h('button', { type: 'button', className: 'pb-btn', onClick: () => setReload((value) => value + 1) }, '重试'));
  else if (isDirectory) content = h('div', { className: 'pb-preview-directory' },
    ...view.entries.map((entry) => h('button', {
      type: 'button', key: entry.name, className: 'pb-preview-entry', disabled: entry.type === 'other',
      'data-preview-name': entry.name, onClick: () => navigate((view.path ? view.path + '/' : '') + entry.name, entry.type),
    }, h(PbIcon, { name: entry.type === 'directory' ? 'folder' : 'file', size: 17 }),
      h('span', { className: 'pb-preview-entry-name' }, entry.name),
      h('span', { className: 'pb-meta' }, entry.type === 'directory' ? '文件夹' : pbPreviewSize(entry.size)),
      entry.type === 'directory' ? h(PbIcon, { name: 'chevronRight', size: 13 }) : null)),
    !view.entries.length ? h('div', { className: 'pb-preview-empty' }, '这个文件夹是空的') : null,
    view.truncated ? h('div', { className: 'pb-preview-note' }, '文件夹内容较多，当前列表显示了部分条目。') : null);
  else if (view?.kind === 'text') content = view.fullMarkdown
    ? h(PbPreviewMarkdown, { workspacePath, path: currentPath, text: view.text, onOpen: openMarkdownFile })
    : h('pre', { className: 'pb-preview-text', tabIndex: 0 }, view.text || (view.lines === 0 ? '（空文件）' : ''));
  else if (view?.kind === 'image') content = h('div', { className: 'pb-preview-image' }, h('img', { src: view.url, alt: currentPath, onError: () => setError('无法显示这张图片') }));
  else if (view?.kind === 'pdf') content = h('iframe', { className: 'pb-preview-pdf', src: view.url, title: 'PDF 预览：' + currentPath });
  else if (view?.kind === 'unsupported') content = h('div', { className: 'pb-preview-empty' }, '此文件格式暂不支持直接预览，可点击上方「下载」后打开。');

  // 原生会话容器会限制绝对定位与裁剪，预览挂到页面顶层以使用完整视口。
  return createPortal(h('div', { className: 'pb-preview-mask', onPointerDown: (event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); } },
    h('section', { ref: dialogRef, className: 'pb-preview-dialog' + (maximized ? ' maximized' : '') + (resizing ? ' resizing' : ''), style: !maximized && size ? size : undefined, role: 'dialog', 'aria-modal': true, 'aria-label': '产物预览', tabIndex: -1 },
      h('header', { className: 'pb-preview-head' },
        h(PbIcon, { name: isDirectory ? 'folder' : 'file', size: 18 }),
        h('div', { className: 'pb-preview-heading' }, h('h2', null, '产物预览'), h('div', { className: 'pb-preview-path', title: currentPath }, currentPath || workspacePath)),
        h('span', { className: 'pb-meta' }, pbPreviewSize(view?.bytes)),
        isMarkdown ? h('button', { type: 'button', className: 'pb-btn small', 'aria-pressed': markdownRendered, disabled: loading, onClick: () => setMarkdownRendered((value) => !value) }, markdownRendered ? '查看源码' : '渲染 Markdown') : null,
        view && !isDirectory ? h('a', { className: 'pb-btn small', href: downloadUrl, download: parts[parts.length - 1] || 'artifact' }, '下载') : null,
        h('button', { type: 'button', className: 'pb-btn small', 'aria-pressed': maximized, onClick: () => setMaximized((value) => !value) }, maximized ? '还原' : '最大化'),
        h('button', { type: 'button', className: 'pb-icon-btn', 'aria-label': '关闭产物预览', title: '关闭（Esc）', onClick: onClose }, h(PbIcon, { name: 'close', size: 18 }))),
      h('nav', { className: 'pb-preview-nav', 'aria-label': '预览导航' },
        h('button', { type: 'button', className: 'pb-btn small', disabled: !back.length, onClick: goBack }, h(PbIcon, { name: 'chevronLeft', size: 13 }), '返回'),
        h('button', { type: 'button', className: 'pb-btn small', disabled: !parts.length, onClick: () => navigate(parts.slice(0, -1).join('/'), 'directory') }, '上一级'),
        h('div', { className: 'pb-preview-crumbs' }, ...crumbButtons)),
      h('div', { className: 'pb-preview-content', 'aria-busy': loading }, content),
      view?.kind === 'text' ? h('footer', { className: 'pb-preview-foot' },
        h('span', { className: 'pb-meta' }, view.fullMarkdown ? 'Markdown · 全文' : view.lines ? `第 ${view.offset}–${view.offset + view.lines - 1} 行` : '空文件'),
        h('span', { className: 'pb-spacer' }),
        !view.fullMarkdown ? h('button', { type: 'button', className: 'pb-btn small', disabled: offset <= 1, onClick: () => setOffset(Math.max(1, offset - 400)) }, '上一页') : null,
        !view.fullMarkdown ? h('button', { type: 'button', className: 'pb-btn small', disabled: view.eof, onClick: () => setOffset(view.offset + view.lines) }, '下一页') : null) : null,
      h('button', { type: 'button', className: 'pb-preview-resize', 'aria-label': '调整预览窗口大小', title: '拖动调整大小；方向键微调，双击恢复默认大小', onPointerDown: startResize, onPointerMove: moveResize, onPointerUp: stopResize, onPointerCancel: stopResize, onLostPointerCapture: stopResize, onKeyDown: resizeKey, onDoubleClick: () => { setSize(null); setMaximized(false); } }))), document.body);
}
