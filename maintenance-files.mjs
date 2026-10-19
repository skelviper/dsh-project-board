// 维护进程的文件边界。文档只作为索引文本；不执行内容，也不推断科学状态。
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';

const DOCUMENT_BYTES = 64 * 1024;
const ARCHIVE_ENTRIES = 10000;
const ARCHIVE_BYTES = 16 * 1024 ** 3;
const ARCHIVE_DEPTH = 64;
const CONTROL_BYTES = 4 * 1024 * 1024;
const DIRECT_DOCUMENTS = ['README.md', 'REPORT.md', 'PROTOCOL.md', 'SUMMARY.md', 'NOTES.md', 'index.md'];
const EXCLUDED = new Set([
  'archive', 'old_data', 'data', 'board', 'plugins', '.git', '.execution', 'node_modules',
  'provenance', '源码冻结', 'source_freeze', 'source_frozen', 'source_snapshot', 'frozen_source',
  'code_before', 'source', 'sources', 'code', 'frozen_code', 'code_frozen', 'code_snapshot',
  'source-freeze', 'source-frozen', 'source-snapshot', 'cache', 'caches', '__pycache__', 'coords', 'coordinates', 'checkpoints',
  'checkpoint', 'outputs', 'predictions', 'logs', 'input', 'inputs', 'raw', 'public_inputs',
  'train', 'training', 'large-train', 'large_train', 'models',
  'venv', 'env', 'dist', 'build', 'coverage', 'wandb', 'tensorboard',
]);
const CONTAINERS = new Set(['main', 'test_res', 'experiments', 'runs', 'docs', 'documentation', 'figures', 'results']);
const SOURCE_ROOTS = new Set(['snp_free_recon', 'phasing', 'reconstruction']);
const PROTECTED = [
  'archive', 'old_data', 'data', 'board', 'plugins', '.git', '.execution', '.agents', 'node_modules',
  'snp_free_recon', 'phasing', 'reconstruction', 'src', 'packages', 'apps',
  'test_res/experiment_registry.json', 'experiment_registry.json', 'registry.json', 'catalog.json', 'inventory.json', 'baseline', 'configs', 'new_experiment.py',
  'AGENTS.md', 'README.md', 'pyproject.toml', 'setup.py', 'setup.cfg', 'package.json',
  'package-lock.json', 'pnpm-lock.yaml', 'uv.lock', 'requirements.txt', 'Makefile',
  'main/VERSION_LOCK', 'main/VERSION_LOCK.json', 'main/VERSION_LOCK.md',
];
const SOURCE_MARKERS = new Set(['.git', 'pyproject.toml', 'package.json', 'setup.py']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const overlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

/** 纯路径规范化；不探测磁盘。异步入口在使用前逐段检查 symlink。 */
export function maintenancePath(workspacePath, value) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath) || typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\u0000-\u001f\u007f\\]/u.test(text) || /^[a-z][a-z0-9+.-]*:/iu.test(text) || text.startsWith('//')) return null;
  if (text.split('/').includes('..')) return null;
  const workspace = path.resolve(workspacePath);
  const absolute = path.isAbsolute(text) ? path.resolve(text) : path.resolve(workspace, text);
  const relative = path.relative(workspace, absolute).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

function absolutePath(workspace, relative) {
  if (maintenancePath(workspace, relative) !== relative) throw failure('ARCHIVE_CONFLICT', `路径无效或超出 workspace：${relative}`);
  const absolute = path.resolve(workspace, ...relative.split('/'));
  if (path.relative(workspace, absolute).split(path.sep).join('/') !== relative) throw failure('ARCHIVE_CONFLICT', `路径解析不一致：${relative}`);
  return absolute;
}

async function maybeStat(anchoredPath) {
  try { return await fsp.lstat(anchoredPath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function descriptorPath(handle, name = '') {
  if (!Number.isInteger(handle.fd) || handle.fd < 0 || (name && (name.includes('/') || name === '.' || name === '..'))) throw failure('ARCHIVE_CONFLICT', '目录 fd 或路径段无效');
  return `/proc/self/fd/${handle.fd}${name ? `/${name}` : ''}`;
}

async function closeHandles(handles) {
  // 所有父 fd 都活到操作结束；逐个关闭，即使其中一个 close 失败也不泄漏其余 fd。
  const errors = [];
  for (const handle of [...handles].reverse()) {
    try { await handle.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors[0];
}

function directoryFlags() {
  if (process.platform !== 'linux' || !Number.isInteger(fsConstants.O_DIRECTORY) || !Number.isInteger(fsConstants.O_NOFOLLOW)) throw failure('MAINTENANCE_UNSUPPORTED', '维护文件操作仅支持具备 /proc/self/fd 的 Linux；其他平台拒绝执行');
  return fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
}

async function verifyDirectory(anchor, handle) {
  let actual;
  try { actual = await fsp.realpath(descriptorPath(handle)); }
  catch (error) { throw failure('ARCHIVE_CONFLICT', `无法验证已打开目录 fd：${error.message}`, error); }
  if (actual !== anchor.workspace && !actual.startsWith(`${anchor.workspace}/`)) throw failure('ARCHIVE_CONFLICT', `目录 fd 已离开 workspace：${actual}`);
  return actual;
}

// 从 / 开始逐段 O_NOFOLLOW 打开；只在 /proc 中解析受持有的 fd，不跟随项目 symlink。
async function workspaceRoot(workspacePath) {
  const flags = directoryFlags();
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw failure('ARCHIVE_CONFLICT', 'workspace 必须是绝对目录路径');
  const workspace = path.resolve(workspacePath);
  if (workspace === path.parse(workspace).root) throw failure('ARCHIVE_CONFLICT', '禁止把文件系统根作为 workspace');
  const handles = [];
  try {
    let current = await fsp.open('/', flags);
    handles.push(current);
    for (const segment of workspace.split('/').filter(Boolean)) {
      current = await fsp.open(descriptorPath(current, segment), flags);
      handles.push(current);
    }
    const actual = await fsp.realpath(descriptorPath(current));
    if (actual !== workspace || !(await current.stat()).isDirectory()) throw failure('ARCHIVE_CONFLICT', 'workspace fd 与请求路径不一致');
    return { workspace, root: current, handles };
  } catch (error) {
    await closeHandles(handles);
    if (error.code === 'ARCHIVE_CONFLICT') throw error;
    throw failure('ARCHIVE_CONFLICT', `无法安全打开 workspace（拒绝 symlink，且必须支持 /proc/self/fd）：${error.message}`, error);
  }
}

async function withDirectory(anchor, relative, action, { missing = false, create = false } = {}) {
  if (relative) absolutePath(anchor.workspace, relative);
  const handles = [];
  let current = anchor.root;
  try {
    await verifyDirectory(anchor, current);
    for (const segment of relative ? relative.split('/') : []) {
      const entryPath = descriptorPath(current, segment);
      let next;
      try { next = await fsp.open(entryPath, directoryFlags()); }
      catch (error) {
        if (error.code === 'ENOENT' && create) {
          await verifyDirectory(anchor, current);
          try { await fsp.mkdir(entryPath); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
          next = await fsp.open(entryPath, directoryFlags());
        } else if (error.code === 'ENOENT' && missing) { return null; }
        else { throw failure('ARCHIVE_CONFLICT', `无法安全打开父目录 ${relative}（拒绝 symlink）：${error.message}`, error); }
      }
      handles.push(next);
      await verifyDirectory(anchor, next);
      current = next;
    }
    await verifyDirectory(anchor, current);
    return await action(current);
  } finally { await closeHandles(handles); }
}

async function withParent(anchor, relative, action, options = {}) {
  absolutePath(anchor.workspace, relative);
  const parts = relative.split('/');
  const name = parts.pop();
  return withDirectory(anchor, parts.join('/'), async (parent) => {
    await verifyDirectory(anchor, parent);
    return action({ parent, name, entryPath: descriptorPath(parent, name) });
  }, options);
}

async function checkedPath(anchor, relative = '', { missing = false } = {}) {
  if (!relative) { await verifyDirectory(anchor, anchor.root); return anchor.root.stat(); }
  return withParent(anchor, relative, async ({ entryPath }) => {
    const stat = await maybeStat(entryPath);
    if (!stat && !missing) throw failure('ARCHIVE_CONFLICT', `路径不存在：${relative}`);
    if (stat?.isSymbolicLink()) throw failure('ARCHIVE_CONFLICT', `拒绝 symlink 路径：${relative}`);
    return stat;
  }, { missing });
}

async function withEntries(anchor, relative, action) {
  return withDirectory(anchor, relative, async (handle) => {
    const directory = await fsp.opendir(descriptorPath(handle));
    try { await verifyDirectory(anchor, handle); return await action(directory); }
    finally {
      try { await directory.close(); } catch (error) { if (error.code !== 'ERR_DIR_CLOSED') throw error; }
    }
  });
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function readPrefix(anchor, relative, limit) {
  return withParent(anchor, relative, async ({ parent, entryPath }) => {
    const before = await maybeStat(entryPath);
    if (!before?.isFile()) throw failure('ARCHIVE_CONFLICT', `不是普通文件（拒绝 symlink）：${relative}`);
    const handle = await fsp.open(entryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      await verifyDirectory(anchor, parent);
      const stat = await handle.stat();
      if (!sameFile(before, stat) || !stat.isFile()) throw failure('ARCHIVE_CONFLICT', `读取前文件已改变：${relative}`);
      const buffer = Buffer.alloc(Math.min(limit, stat.size));
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (!sameFile(stat, await handle.stat()) || length !== buffer.length) throw failure('ARCHIVE_CONFLICT', `读取时文件已改变：${relative}`);
      return { buffer: buffer.subarray(0, length), size: stat.size, clipped: stat.size > limit };
    } finally { await handle.close(); }
  });
}

function plainText(value) {
  return value.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, '$1').replace(/[`*_~]/gu, '').replace(/\s+/gu, ' ').trim();
}

function documentText(buffer, fallback) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/u, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').replace(/<!--[\s\S]*?-->/gu, '');
  const lines = text.split(/\r?\n/u);
  let title = '';
  let fenced = false;
  const paragraphs = [];
  let paragraph = [];
  const flush = () => { if (paragraph.length) paragraphs.push(plainText(paragraph.join(' '))); paragraph = []; };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^(?:```|~~~)/u.test(line)) { flush(); fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/u);
    const setext = line && /^(?:={3,}|-{3,})\s*$/u.test(lines[index + 1]?.trim() || '');
    if (heading || setext) {
      flush();
      if (!title) title = plainText(heading ? heading[1] : line);
      if (setext) index += 1;
      continue;
    }
    if (!line || /^(?:[-*+]\s|\d+[.)]\s|[>|<]|\[[^\]]+\]:|---+$)/u.test(line)) { flush(); continue; }
    paragraph.push(line);
  }
  flush();
  return { title: (title || fallback).slice(0, 300), summary: (paragraphs.find(Boolean) || '').slice(0, 500) };
}

function excluded(relative) {
  const parts = relative.split('/');
  return SOURCE_ROOTS.has(parts[0].toLowerCase()) || parts.some((part) => part.startsWith('.') || EXCLUDED.has(part.toLowerCase()));
}

function unitKind(relative) {
  const name = path.posix.basename(relative);
  if (/^(?:\d{3}-|MP\d+(?:[-_.]|$))/iu.test(name)) return 'experiment';
  if (/^fig(?:ure)?\d[\w.-]*$/iu.test(name)) return 'component';
  return null;
}

/** 只读取有界 Markdown 前缀；识别实验/图版后不进入其产物树。 */
export async function discoverBoardContent(workspacePath, { roots = ['.'], maxEntries = 2500, maxCandidates = 200, maxDepth = 4 } = {}) {
  const anchor = await workspaceRoot(workspacePath);
  const workspace = anchor.workspace;
  try {
  const candidates = [];
  const warnings = [];
  let truncated = false;
  let entriesSeen = 0;
  const seen = new Set();
  const visited = new Set();
  const warn = (message, cap = false) => { if (!warnings.includes(message)) warnings.push(message); if (cap) truncated = true; };
  const bound = (value, fallback, maximum, label) => {
    if (!Number.isInteger(value) || value < 0) { warn(`${label} 无效，使用 ${fallback}`, true); return fallback; }
    if (value > maximum) { warn(`${label} 超出安全上限，限制为 ${maximum}`, true); return maximum; }
    return value;
  };
  maxEntries = bound(maxEntries, 2500, 10000, 'maxEntries');
  maxCandidates = bound(maxCandidates, 200, 1000, 'maxCandidates');
  maxDepth = bound(maxDepth, 4, 12, 'maxDepth');
  const consume = () => {
    if (entriesSeen >= maxEntries) { warn(`达到 maxEntries=${maxEntries}，已停止扫描`, true); return false; }
    entriesSeen += 1;
    return true;
  };
  const add = (candidate) => {
    if (seen.has(candidate.path)) return;
    if (candidates.length >= maxCandidates) { warn(`达到 maxCandidates=${maxCandidates}，已停止添加候选`, true); return; }
    seen.add(candidate.path);
    candidates.push(candidate);
  };
  const readDocument = async (relative) => {
    try {
      const result = await readPrefix(anchor, relative, DOCUMENT_BYTES);
      if (result.clipped) warn(`文档只读取首 64KiB：${relative}`, true);
      return { ...documentText(result.buffer, path.posix.basename(relative, '.md')), fingerprint: sha256(`${relative}\0${result.size}\0${sha256(result.buffer)}`) };
    } catch (error) { warn(`跳过文档 ${relative}：${error.message}`); return null; }
  };
  const addUnit = async (relative, kind, documentPaths) => {
    let document = null;
    for (const documentPath of documentPaths) {
      if (!consume()) break;
      try {
        const stat = await checkedPath(anchor, documentPath, { missing: true });
        if (stat?.isFile()) { document = await readDocument(documentPath); if (document) break; }
      } catch (error) { warn(`跳过文档 ${documentPath}：${error.message}`); }
    }
    add({ path: relative, kind, title: document?.title || path.posix.basename(relative), summary: document?.summary || '', fingerprint: sha256(`${relative}\0${document?.fingerprint || ''}`) });
  };
  const visit = async (relative, depth, summaryOnly = false) => {
    if (visited.has(relative)) return;
    visited.add(relative);
    if (relative && excluded(relative)) return;
    if (entriesSeen >= maxEntries || candidates.length >= maxCandidates) {
      warn(entriesSeen >= maxEntries ? `达到 maxEntries=${maxEntries}，已停止扫描` : `达到 maxCandidates=${maxCandidates}，已停止添加候选`, true);
      return;
    }
    let stat;
    try { stat = await checkedPath(anchor, relative); }
    catch (error) { warn(`跳过路径 ${relative || '.'}：${error.message}`); return; }
    if (stat.isFile()) {
      if (relative.toLowerCase().endsWith('.md')) { if (!consume()) return; const document = await readDocument(relative); if (document) add({ path: relative, kind: 'document', ...document }); }
      return;
    }
    if (!stat.isDirectory()) return;
    const kind = relative ? unitKind(relative) : null;
    if (kind) {
      await addUnit(relative, kind, DIRECT_DOCUMENTS.flatMap((name) => [name, name.toLowerCase()]).map((name) => `${relative}/${name}`));
      if (kind === 'experiment' || summaryOnly) return;
      // 图版既是单元也是摘要容器；只额外查看一层，不进入训练产物树。
    }
    const rows = [];
    try {
      await withEntries(anchor, relative, async (directory) => {
        for await (const entry of directory) { if (!consume()) break; rows.push(entry); }
      });
    } catch (error) { warn(`无法扫描 ${relative || '.'}：${error.message}`); return; }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const docs = rows.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'agents.md' && (relative || entry.name.toLowerCase() !== 'readme.md'));
    const primary = docs.filter((entry) => DIRECT_DOCUMENTS.some((name) => name.toLowerCase() === entry.name.toLowerCase()));
    if (relative && !kind && !CONTAINERS.has(path.posix.basename(relative).toLowerCase()) && primary.length) {
      primary.sort((a, b) => DIRECT_DOCUMENTS.findIndex((name) => name.toLowerCase() === a.name.toLowerCase()) - DIRECT_DOCUMENTS.findIndex((name) => name.toLowerCase() === b.name.toLowerCase()));
      await addUnit(relative, 'component', primary.map((entry) => `${relative}/${entry.name}`));
      return;
    }
    for (const entry of docs) {
      if (kind && primary.includes(entry)) continue;
      if (candidates.length >= maxCandidates) { warn(`达到 maxCandidates=${maxCandidates}，已停止添加候选`, true); break; }
      const documentPath = relative ? `${relative}/${entry.name}` : entry.name;
      const document = await readDocument(documentPath);
      if (document) add({ path: documentPath, kind: 'document', ...document });
    }
    for (const entry of rows) {
      if (summaryOnly || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (excluded(child)) continue;
      if (depth >= maxDepth) { warn(`达到 maxDepth=${maxDepth}，未下降：${child}`, true); continue; }
      await visit(child, depth + 1, kind === 'component');
      if (entriesSeen >= maxEntries || candidates.length >= maxCandidates) {
        warn(entriesSeen >= maxEntries ? `达到 maxEntries=${maxEntries}，已停止扫描` : `达到 maxCandidates=${maxCandidates}，已停止添加候选`, true);
        break;
      }
    }
  };
  if (!Array.isArray(roots)) throw failure('DISCOVERY_INPUT', 'roots 必须是路径数组');
  if (roots.length > 64) warn('roots 超出 64 个，仅处理前 64 个', true);
  for (const value of roots.slice(0, 64)) {
    const relative = value === '.' || value === workspace ? '' : maintenancePath(workspace, value);
    if (relative === null || (relative && excluded(relative))) { warn(`跳过不允许的扫描根：${String(value)}`); continue; }
    await visit(relative, 0);
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { candidates, warnings, truncated };
  } finally { await closeHandles(anchor.handles); }
}

function threadIds(row) {
  const values = [...(Array.isArray(row.threads) ? row.threads : []), row.thread];
  return [...new Set([
    ...values.map((thread) => typeof thread === 'string' ? thread : thread?.sessionId),
    ...(Array.isArray(row.sessionIds) ? row.sessionIds : []), row.sessionId,
  ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

/** 精确索引显式引用，不把任何祖先目录猜成 owned。 */
export function boardFileReferences(board) {
  const references = [];
  const workspace = typeof board?.workspacePath === 'string' && path.isAbsolute(board.workspacePath) ? path.resolve(board.workspacePath) : '/__board_relative_paths__';
  const seen = new Set();
  const add = (row, targetType, value, role) => {
    const raw = typeof value === 'string' ? value : value?.path;
    if (typeof raw !== 'string' || (!board?.workspacePath && path.isAbsolute(raw))) return;
    const relative = maintenancePath(workspace, raw);
    if (!relative || typeof row.id !== 'string' || !row.id) return;
    const key = JSON.stringify([relative, targetType, row.id, role]);
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ path: relative, targetType, targetId: row.id, role, status: typeof row.status === 'string' ? row.status : '', sessionIds: threadIds(row) });
  };
  for (const [collection, targetType] of [['nodes', 'node'], ['tasks', 'task'], ['todos', 'todo']]) {
    for (const row of Array.isArray(board?.[collection]) ? board[collection] : []) {
      if (!object(row)) continue;
      for (const value of Array.isArray(row.ownedPaths) ? row.ownedPaths : []) add(row, targetType, value, 'link');
      if (targetType === 'node') {
        for (const value of Array.isArray(row.links) ? row.links : []) add(row, targetType, value, 'link');
        for (const value of Array.isArray(row.derivedFrom) ? row.derivedFrom : []) add(row, targetType, value, 'source');
      } else {
        for (const value of Array.isArray(row.artifacts) ? row.artifacts : []) add(row, targetType, value, 'artifact');
        add(row, targetType, row.primaryArtifactPath, 'artifact');
        if (targetType === 'task') for (const value of Array.isArray(row.writeScopes) ? row.writeScopes : []) add(row, targetType, value, 'scope');
      }
    }
  }
  return references;
}

async function sourceBoundary(anchor, relative, isDirectory) {
  const parts = relative.split('/');
  const directories = isDirectory ? parts.length : parts.length - 1;
  for (let index = 1; index <= directories; index += 1) {
    const directory = parts.slice(0, index).join('/');
    for (const marker of SOURCE_MARKERS) {
      if (await checkedPath(anchor, `${directory}/${marker}`, { missing: true })) throw failure('ARCHIVE_CONFLICT', `禁止归档源码仓库或公共入口：${directory}（${marker}）`);
    }
  }
}

async function hashFile(anchor, relative, expected) {
  return withParent(anchor, relative, async ({ parent, entryPath }) => {
    const before = await maybeStat(entryPath);
    if (!before?.isFile() || (expected && !sameFile(before, expected))) throw failure('ARCHIVE_CONFLICT', `文件类型或身份已改变：${relative}`);
    const handle = await fsp.open(entryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      await verifyDirectory(anchor, parent);
      const stat = await handle.stat();
      if (!sameFile(before, stat) || !stat.isFile()) throw failure('ARCHIVE_CONFLICT', `计算 SHA 前文件已改变：${relative}`);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(DOCUMENT_BYTES);
      let bytes = 0;
      while (bytes < stat.size) {
        const result = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - bytes), bytes);
        if (!result.bytesRead) break;
        hash.update(buffer.subarray(0, result.bytesRead));
        bytes += result.bytesRead;
      }
      if (bytes !== stat.size || !sameFile(stat, await handle.stat())) throw failure('ARCHIVE_CONFLICT', `计算 SHA 时文件已改变：${relative}`);
      return { bytes, sha256: hash.digest('hex') };
    } finally { await handle.close(); }
  });
}

async function sourceManifest(anchor, paths) {
  const entries = [];
  let bytes = 0;
  let fileCount = 0;
  const visit = async (relative, depth) => {
    if (entries.length >= ARCHIVE_ENTRIES || depth > ARCHIVE_DEPTH) throw failure('ARCHIVE_LIMIT', `归档清单超出上限（${ARCHIVE_ENTRIES} 条 / 深度 ${ARCHIVE_DEPTH}），未开始迁移`);
    const stat = await checkedPath(anchor, relative);
    // 允许实验内部的冻结源码文件；嵌套 Git 仓库仍保守拒绝。
    if (path.posix.basename(relative) === '.git') throw failure('ARCHIVE_CONFLICT', `禁止归档嵌套源码仓库：${relative}`);
    if (stat.isFile()) {
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes) || bytes > ARCHIVE_BYTES) throw failure('ARCHIVE_LIMIT', `归档超过 ${ARCHIVE_BYTES} 字节上限，未开始迁移`);
      entries.push({ path: relative, kind: 'file', ...await hashFile(anchor, relative, stat) });
      fileCount += 1;
    } else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: 'directory' });
      const children = [];
      await withEntries(anchor, relative, async (directory) => {
        for await (const entry of directory) {
          if (children.length + entries.length >= ARCHIVE_ENTRIES) throw failure('ARCHIVE_LIMIT', `归档清单超过 ${ARCHIVE_ENTRIES} 条上限，未开始迁移`);
          const child = `${relative}/${entry.name}`;
          if (maintenancePath(anchor.workspace, child) !== child) throw failure('ARCHIVE_CONFLICT', `不支持的归档路径：${child}`);
          children.push(child);
        }
      });
      children.sort();
      for (const child of children) await visit(child, depth + 1);
    } else { throw failure('ARCHIVE_CONFLICT', `归档只接受普通文件和目录（不含 symlink）：${relative}`); }
  };
  for (const relative of paths) {
    const stat = await checkedPath(anchor, relative);
    await sourceBoundary(anchor, relative, stat.isDirectory());
    await visit(relative, 0);
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { entries, fileCount, bytes };
}

async function ensureDirectory(anchor, relative) {
  return withDirectory(anchor, relative, async () => {}, { create: true });
}

async function mkdirExclusive(anchor, relative) {
  return withParent(anchor, relative, async ({ parent, entryPath }) => {
    await verifyDirectory(anchor, parent);
    await fsp.mkdir(entryPath);
  });
}

async function writeExclusive(anchor, relative, text) {
  return withParent(anchor, relative, async ({ parent, entryPath }) => {
    if (await maybeStat(entryPath)) throw failure('ARCHIVE_CONFLICT', `禁止覆盖已有文件：${relative}`);
    const handle = await fsp.open(entryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await verifyDirectory(anchor, parent);
      if (!(await handle.stat()).isFile()) throw failure('ARCHIVE_CONFLICT', `回执目标不是普通文件：${relative}`);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  });
}

async function renameAnchored(anchor, from, to) {
  // 显式解析并验证原始绝对路径；真正 syscall 只使用同时持有的源/目标父 fd。
  absolutePath(anchor.workspace, from);
  absolutePath(anchor.workspace, to);
  return withParent(anchor, from, async (source) => withParent(anchor, to, async (destination) => {
    const before = await maybeStat(source.entryPath);
    if (!before || before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) throw failure('ARCHIVE_CONFLICT', `迁移前来源缺失或是 symlink：${from}`);
    if (await maybeStat(destination.entryPath)) throw failure('ARCHIVE_CONFLICT', `禁止覆盖归档目标：${to}`);
    await verifyDirectory(anchor, source.parent);
    await verifyDirectory(anchor, destination.parent);
    await fsp.rename(source.entryPath, destination.entryPath);
    const after = await maybeStat(destination.entryPath);
    if (!after || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw failure('ARCHIVE_CONFLICT', `迁移期间来源被替换（拒绝 symlink），保留目标等待核验：${to}`);
    await verifyDirectory(anchor, source.parent);
    await verifyDirectory(anchor, destination.parent);
  }));
}

function receiptResult(receipt, request, receiptPath) {
  if (!object(receipt) || receipt.version !== 1 || receipt.state !== 'completed' || receipt.operationId !== request.operationId || receipt.requestFingerprint !== request.fingerprint || receipt.receiptPath !== receiptPath ||
      !Number.isSafeInteger(receipt.fileCount) || receipt.fileCount < 0 || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 ||
      !Array.isArray(receipt.moves) || JSON.stringify(receipt.moves) !== JSON.stringify(request.moves) || !/^[a-f0-9]{64}$/u.test(receipt.manifestSha256 || '')) {
    throw failure('ARCHIVE_CONFLICT', `操作 ID 已存在，但直接回执与请求不匹配或损坏：${receiptPath}`);
  }
  return { moves: receipt.moves, fileCount: receipt.fileCount, bytes: receipt.bytes, receiptPath };
}

/** 先完整预检再同盘 rename；不扫描既有 archive，只使用本 operation 的直接文件。 */
export async function archiveBoardContent(workspacePath, { operationId, paths, protectedPaths = [], references = [], activePaths = [] } = {}) {
  if (!Array.isArray(paths)) throw failure('ARCHIVE_CONFLICT', 'paths 必须是路径数组');
  if (!paths.length) return { moves: [], fileCount: 0, bytes: 0, receiptPath: null };
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(operationId)) throw failure('ARCHIVE_CONFLICT', 'operationId 必须是稳定的安全标识（不能包含路径分隔符）');
  if (paths.length > 200) throw failure('ARCHIVE_LIMIT', '一次归档最多 200 个候选路径');
  const anchor = await workspaceRoot(workspacePath);
  const workspace = anchor.workspace;
  try {
  const normalize = (value, label) => {
    const relative = maintenancePath(workspace, typeof value === 'string' ? value : value?.path);
    if (!relative) throw failure('ARCHIVE_CONFLICT', `${label} 无效、是根路径或超出 workspace：${String(typeof value === 'string' ? value : value?.path)}`);
    return relative;
  };
  const selected = [...new Set(paths.map((value) => normalize(value, '归档路径')))].sort();
  for (let index = 0; index < selected.length; index += 1) {
    for (const other of selected.slice(index + 1)) if (overlap(selected[index], other)) throw failure('ARCHIVE_CONFLICT', `归档候选存在祖先重叠：${selected[index]} / ${other}`);
    if (['manifest.json', 'receipt.json'].includes(selected[index].split('/')[0])) throw failure('ARCHIVE_CONFLICT', `路径与操作回执保留名称冲突：${selected[index]}`);
  }
  const operationPath = `archive/board/${operationId}`;
  const receiptPath = `${operationPath}/receipt.json`;
  const manifestPath = `${operationPath}/manifest.json`;
  const moves = selected.map((from) => ({ from, to: `${operationPath}/${from}` }));
  const request = { operationId, moves, fingerprint: sha256(JSON.stringify({ workspace, operationId, paths: selected })) };
  const existingOperation = await checkedPath(anchor, operationPath, { missing: true });
  if (existingOperation) {
    if (!existingOperation.isDirectory()) throw failure('ARCHIVE_CONFLICT', `操作路径不是目录：${operationPath}`);
    const receipt = await checkedPath(anchor, receiptPath, { missing: true });
    if (receipt) {
      let parsed;
      try {
        const result = await readPrefix(anchor, receiptPath, CONTROL_BYTES);
        if (result.clipped) throw new Error('回执过大');
        parsed = JSON.parse(result.buffer.toString('utf8'));
      } catch (error) { throw failure('ARCHIVE_INCOMPLETE', `直接回执不完整或不可读；保留现有文件，需核验 ${receiptPath}：${error.message}`, error); }
      return receiptResult(parsed, request, receiptPath);
    }
    throw failure('ARCHIVE_INCOMPLETE', `操作 ${operationId} 已存在但没有完成回执；不覆盖或重试迁移，请按 ${manifestPath} 核验原路径及目标路径后恢复`);
  }
  const guards = [...PROTECTED.map((value) => ({ path: value, label: '保护入口' }))];
  for (const [values, label] of [[protectedPaths, 'protectedPaths'], [references, '共享引用'], [activePaths, '活动路径']]) {
    if (!Array.isArray(values)) throw failure('ARCHIVE_CONFLICT', `${label} 必须是数组`);
    for (const value of values) {
      const relative = normalize(value, label);
      const target = object(value) && value.targetId ? ` ${value.targetType || 'entry'}:${value.targetId}` : '';
      guards.push({ path: relative, label: `${label}${target}` });
    }
  }
  for (const { from, to } of moves) {
    for (const guard of guards) if (overlap(from, guard.path)) throw failure('ARCHIVE_CONFLICT', `归档冲突：${from} 与${guard.label} ${guard.path} 存在相同或祖先路径重叠`);
    await checkedPath(anchor, from);
    if (await checkedPath(anchor, to, { missing: true })) throw failure('ARCHIVE_CONFLICT', `禁止覆盖已有归档目标：${to}`);
    // 显式验证用于 rename 的两个绝对路径，即使目标尚未创建。
    absolutePath(workspace, from);
    absolutePath(workspace, to);
  }
  const manifest = await sourceManifest(anchor, selected);
  const manifestText = `${JSON.stringify({ version: 1, operationId, requestFingerprint: request.fingerprint, moves, ...manifest }, null, 2)}\n`;
  const manifestSha256 = sha256(manifestText);
  const completedMoves = [];
  let created = false;
  try {
    await ensureDirectory(anchor, 'archive/board');
    // exclusive mkdir 是同一 operation 的并发屏障；不清理遗留目录。
    await checkedPath(anchor, operationPath, { missing: true });
    await mkdirExclusive(anchor, operationPath);
    created = true;
    await checkedPath(anchor, operationPath);
    await writeExclusive(anchor, manifestPath, manifestText);
    for (const move of moves) {
      const expectedEntries = manifest.entries.filter((entry) => entry.path === move.from || entry.path.startsWith(`${move.from}/`));
      const current = await sourceManifest(anchor, [move.from]);
      if (JSON.stringify(current.entries) !== JSON.stringify(expectedEntries)) throw failure('ARCHIVE_CONFLICT', `预检后来源发生改变：${move.from}`);
      await ensureDirectory(anchor, path.posix.dirname(move.to));
      await checkedPath(anchor, move.from);
      if (await checkedPath(anchor, move.to, { missing: true })) throw failure('ARCHIVE_CONFLICT', `禁止覆盖归档目标：${move.to}`);
      await renameAnchored(anchor, move.from, move.to);
      completedMoves.push(move);
    }
    // 仅验证本次清单中的直接目标；不枚举任何既有归档。
    for (const entry of manifest.entries) {
      const destination = `${operationPath}/${entry.path}`;
      const stat = await checkedPath(anchor, destination);
      if (entry.kind === 'directory') {
        if (!stat.isDirectory()) throw failure('ARCHIVE_CONFLICT', `迁移后目录类型不一致：${destination}`);
      } else {
        const actual = await hashFile(anchor, destination);
        if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256) throw failure('ARCHIVE_CONFLICT', `迁移后 SHA/size 不一致：${destination}`);
      }
    }
    const receipt = { version: 1, state: 'completed', operationId, requestFingerprint: request.fingerprint, moves, fileCount: manifest.fileCount, bytes: manifest.bytes, receiptPath, manifestPath, manifestSha256, manifestBytes: Buffer.byteLength(manifestText), completedAt: new Date().toISOString() };
    await writeExclusive(anchor, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receiptResult(receipt, request, receiptPath);
  } catch (error) {
    if (!created && error.code !== 'EEXIST') throw error;
    const interrupted = failure('ARCHIVE_INCOMPLETE', `归档操作 ${operationId} 未完成（已迁移 ${completedMoves.length}/${moves.length}）；不丢弃、不覆盖任何原文件或已迁移内容。请核验 ${manifestPath} 与原/目标路径后恢复：${error.message}`, error);
    interrupted.moves = completedMoves;
    interrupted.manifestPath = manifestPath;
    throw interrupted;
  }
  } finally { await closeHandles(anchor.handles); }
}
