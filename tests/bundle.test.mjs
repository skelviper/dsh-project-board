import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
test('实际宿主bundle保留所需原生导入，命令与持久历史撤销可往返', async () => {
  const code = await fs.readFile(new URL('../host.mjs', import.meta.url), 'utf8');
  const { BoardService, normalizeBoard } = await import('data:text/javascript;base64,' + Buffer.from(code + '\nexport { BoardService, normalizeBoard };').toString('base64'));
  let value = normalizeBoard({ nodes: [{ id: 'n', title: '节点' }] }, { workspacePath: '/tmp/board-bundle-only' });
  const store = { async read() { return { exists: true, board: normalizeBoard(JSON.parse(JSON.stringify(value))) }; }, async mutate(_root, fn) { return fn(); }, async write(_root, board) { value = board; }, notify() {} };
  const service = new BoardService({ store, ctx: { workspaceRegistry: { list: () => [{ id: 'ws', path: '/tmp/board-bundle-only' }] } } });
  const result = await service.command({ workspacePath: '/tmp/board-bundle-only', action: 'upsert_node', input: { node: { id: 'n', title: '已修改' } } });
  assert.equal(value.nodes[0].title, '已修改'); assert.equal(result.lastChange.undo.status, 'available');
  await service.command({ workspacePath: '/tmp/board-bundle-only', action: 'undo_change', input: { changeId: result.changeId } });
  assert.equal(value.nodes[0].title, '节点');
});
