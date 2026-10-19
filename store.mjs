// Per-workspace board store: <workspace>/board/project-board.json.
// Writes are serialized per workspace and replace the file atomically.
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  BOARD_RELATIVE_PATH,
  BoardError,
  normalizeBoard,
} from './schema.mjs';

const TMP_PREFIX = '.project-board.json.tmp-';

async function readJson(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (text.length > 8 * 1024 * 1024) throw new BoardError('BOARD_TOO_LARGE', '看板文件超过 8MB', 413);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BoardError('BOARD_CORRUPT', '看板 JSON 无法解析，请检查 board/project-board.json', 422, { cause: error.message });
  }
}

export class BoardStore {
  constructor() {
    this.queues = new Map();
    this.listeners = new Set();
  }

  boardPath(workspacePath) {
    return path.join(workspacePath, BOARD_RELATIVE_PATH);
  }

  /** Read one board. Returns {exists, board, mtimeMs}. */
  async read(workspacePath) {
    const file = this.boardPath(workspacePath);
    let stat = null;
    try {
      stat = await fsp.stat(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, board: null, mtimeMs: 0 };
      throw error;
    }
    const raw = await readJson(file);
    const board = normalizeBoard(raw, { workspacePath, title: path.basename(workspacePath) });
    return { exists: true, board, mtimeMs: stat.mtimeMs };
  }

  /** Replace one board atomically. Creates the board directory when missing. */
  async write(workspacePath, board) {
    const file = this.boardPath(workspacePath);
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, TMP_PREFIX + process.pid + '-' + Math.random().toString(36).slice(2));
    const text = JSON.stringify(board, null, 2) + '\n';
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new BoardError('BOARD_TOO_LARGE', '看板将超过8MB，未覆盖现有记录；请先整理交付正文或维护记录', 413);
    try {
      await fsp.writeFile(tmp, text, { mode: 0o644 });
      await fsp.rename(tmp, file);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    return file;
  }

  /** Serialize one read-modify-write cycle per workspace. */
  async mutate(workspacePath, task) {
    const previous = this.queues.get(workspacePath) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.queues.set(workspacePath, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(workspacePath) === tail) this.queues.delete(workspacePath);
    }
  }

  /** Subscribe to committed board changes: fn({workspacePath, board, actor}). */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event) {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a subscriber must not break storage */ }
    }
  }
}

export function defaultBoard(workspacePath, title) {
  const now = new Date().toISOString();
  return normalizeBoard({}, { workspacePath, title, now });
}
