// dsh-project-board host plugin.
// Registers the per-workspace project board API, model-facing tools, and the
// board digest injected into each agent's runtime context.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  BoardError,
  boardDigest,
  normalizeBoard,
} from './schema.mjs';
import { BoardService } from './service.mjs';
import { readThread } from './thread.mjs';

export const name = 'project-board';
export const inject = ['connection', 'tools', 'systemPrompt', 'agents', 'agentTeams', 'workspaceRegistry', 'sessionQuery'];

async function runtimeModule(specifier) {
  const candidates = [process.argv[1] && path.resolve(process.argv[1]), import.meta.url];
  let resolved;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      resolved = createRequire(candidate).resolve(specifier);
      break;
    } catch { /* try the next owner */ }
  }
  if (!resolved) resolved = createRequire(import.meta.url).resolve(specifier);
  return import(pathToFileURL(resolved).href);
}

const MAX_BODY_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const digestCache = new Map();

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function errorResponse(error) {
  if (error instanceof BoardError) {
    return jsonResponse(error.status, { error: { code: error.code, message: error.message, details: error.details } });
  }
  return jsonResponse(500, { error: { code: 'INTERNAL', message: String(error?.message || error) } });
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BoardError('BODY_TOO_LARGE', '请求体过大', 413);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BoardError('INVALID_JSON', '请求体不是合法 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BoardError('INVALID_INPUT', '请求体必须是对象');
  return value;
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const table = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
    '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.json': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
    '.yml': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  };
  return table[ext] || 'application/octet-stream';
}

const jsonSafe = (value) => JSON.parse(JSON.stringify(value));

export async function apply(ctx) {
  const service = new BoardService({ ctx });
  const { defineTool } = await runtimeModule('@deepseek-ai/dsh-tools');

  // ---- authenticated HTTP routes -------------------------------------------
  const routes = [];

  routes.push(['GET', '/api/project-board/workspaces', async () => {
    const workspaces = [];
    for (const workspace of service.registryWorkspaces()) {
      let exists = false;
      try {
        exists = (await service.read(workspace.path)).exists;
      } catch { exists = false; }
      workspaces.push({ ...workspace, hasBoard: exists });
    }
    return jsonResponse(200, { workspaces });
  }]);

  routes.push(['GET', '/api/project-board/state', async (request) => {
    const url = new URL(request.url);
    const workspacePath = url.searchParams.get('workspacePath');
    if (!workspacePath) throw new BoardError('INVALID_INPUT', '缺少 workspacePath');
    return jsonResponse(200, await service.state(workspacePath));
  }]);

  routes.push(['POST', '/api/project-board/command', async (request) => {
    const body = await readJsonBody(request);
    const result = await service.command({
      workspacePath: body.workspacePath,
      expectedRevision: body.expectedRevision,
      commandId: body.commandId,
      action: body.action,
      input: body.input,
      actor: typeof body.actor === 'string' ? body.actor : 'user',
    });
    return jsonResponse(200, { board: result.board, workspace: result.workspace, replayed: Boolean(result.replayed) });
  }]);

  routes.push(['POST', '/api/project-board/dispatch', async (request) => {
    const body = await readJsonBody(request);
    const result = await service.dispatch({
      workspacePath: body.workspacePath,
      expectedRevision: body.expectedRevision,
      commandId: body.commandId,
      leadSessionId: body.leadSessionId,
      items: body.items,
      actor: typeof body.actor === 'string' ? body.actor : 'user',
    });
    return jsonResponse(200, { board: result.board, created: result.created });
  }]);

  routes.push(['GET', '/api/project-board/thread', async (request) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 200)));
    const startSeq = Math.max(0, Number(url.searchParams.get('startSeq') || 0));
    return jsonResponse(200, await readThread(ctx, sessionId, { limit, startSeq }));
  }]);

  routes.push(['GET', '/api/project-board/artifact', async (request) => {
    const url = new URL(request.url);
    const workspacePath = url.searchParams.get('workspacePath');
    const relative = url.searchParams.get('path');
    if (!workspacePath || !relative) throw new BoardError('INVALID_INPUT', '缺少 workspacePath 或 path');
    const workspace = service.findWorkspace(workspacePath);
    const root = workspace.path;
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new BoardError('PATH_OUTSIDE_WORKSPACE', '路径必须在 workspace 内', 403);
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch {
      throw new BoardError('FILE_NOT_FOUND', '文件不存在', 404);
    }
    if (stat.isSymbolicLink()) throw new BoardError('SYMLINK_REFUSED', '不跟随符号链接', 403);
    // 父目录也可能是符号链接；读取前核对真实路径归属。
    const realRoot = await fsp.realpath(root);
    const realTarget = await fsp.realpath(target);
    const fromRoot = path.relative(realRoot, realTarget);
    if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) {
      throw new BoardError('PATH_OUTSIDE_WORKSPACE', '路径必须在 workspace 内', 403);
    }
    if (!stat.isFile()) throw new BoardError('NOT_A_FILE', '不是普通文件', 422);
    if (stat.size > MAX_ARTIFACT_BYTES) throw new BoardError('FILE_TOO_LARGE', '文件超过预览上限', 413);
    const bytes = await fsp.readFile(target);
    const contentType = contentTypeFor(target);
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (contentType === 'image/svg+xml' || contentType.startsWith('text/')) {
      headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:";
    }
    if (contentType === 'application/octet-stream') headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
    return new Response(bytes, { status: 200, headers });
  }]);

  routes.push(['GET', '/api/project-board/events', async (request) => {
    const url = new URL(request.url);
    const workspacePath = url.searchParams.get('workspacePath');
    if (!workspacePath) throw new BoardError('INVALID_INPUT', '缺少 workspacePath');
    const workspace = service.findWorkspace(workspacePath);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let unsubscribe = () => {};
        const send = (event, value) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
          } catch { closed = true; }
        };
        send('hello', { workspacePath: workspace.path, timestamp: Date.now() });
        unsubscribe = service.store.onChange((event) => {
          if (event.workspacePath !== workspace.path) return;
          send('board', { revision: event.board.revision, updatedAt: event.board.updatedAt, actor: event.actor });
        });
        const keepalive = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { closed = true; }
        }, 20000);
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepalive);
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        };
        request.signal.addEventListener('abort', cleanup);
      },
      cancel() {
        // The start() closure owns the subscription; the request abort cleanup
        // runs for browser disconnects as well.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }]);

  for (const [method, routePath, handler] of routes) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({
        path: routePath,
        methods: [method],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request);
          } catch (error) {
            if (!(error instanceof BoardError)) ctx.logger?.warn?.(`project-board route ${routePath} failed: ${error?.stack || error}`);
            return errorResponse(error);
          }
        },
      });
      return async () => { await dispose(); };
    }, `project-board route ${routePath}`);
  }

  // ---- model-facing tools --------------------------------------------------
  const jsonOutput = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  const workspaceArg = { type: 'string', description: '目标 workspace 的绝对路径；省略时使用当前会话工作目录所属的 workspace' };

  function toolWorkspace(agent, requested) {
    if (requested) {
      const absolute = path.resolve(requested);
      const workspace = service.registryWorkspaces().find((row) => row.path === absolute);
      return workspace || { workspaceId: '', path: absolute, title: path.basename(absolute), unregistered: true };
    }
    return service.workspaceForAgent(agent);
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_board_get',
    description: '读取项目看板：摘要（digest）、完整看板、节点/任务/待办详情，或某个任务或待办绑定会话的对话记录。规划项目或汇报状态前先调用。',
    parameters: {
      workspacePath: workspaceArg,
      view: { type: 'string', enum: ['digest', 'board', 'node', 'tasks', 'todos', 'thread'], description: '读取视图，默认 digest' },
      nodeId: { type: 'string', description: 'view=node 时的节点 id' },
      taskId: { type: 'string', description: '筛选某个任务下的待办' },
      sessionId: { type: 'string', description: 'view=thread 时的会话 id' },
      limit: { type: 'integer', description: 'view=thread 时最多返回的消息条数（默认 120）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: typeof value?.digest === 'string' ? value.digest : JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30000,
    execute: async (args, exec) => {
      const agent = exec.agent;
      const workspace = toolWorkspace(agent, args.workspacePath);
      const view = args.view || 'digest';
      if (view === 'digest') {
        const { digest, board } = await service.digestFor(agent, workspace);
        return jsonSafe({ workspacePath: workspace.path, revision: board?.revision, digest: digest || '（该 workspace 还没有项目看板）' });
      }
      if (view === 'thread') {
        return jsonSafe(await readThread(ctx, args.sessionId, { limit: Math.max(1, Math.min(500, args.limit || 120)) }));
      }
      const { exists, board } = await service.read(workspace.path);
      if (!exists) return jsonSafe({ workspacePath: workspace.path, exists: false, board: null });
      if (view === 'board') return jsonSafe({ workspacePath: workspace.path, revision: board.revision, board });
      if (view === 'node') {
        const node = board.nodes.find((row) => row.id === args.nodeId);
        if (!node) throw new BoardError('NODE_NOT_FOUND', `节点不存在：${args.nodeId}`, 404);
        return jsonSafe({
          workspacePath: workspace.path,
          revision: board.revision,
          node,
          tasks: board.tasks.filter((row) => row.nodeId === node.id),
          todos: board.todos.filter((row) => board.tasks.some((task) => task.id === row.taskId && task.nodeId === node.id)),
          edges: board.edges.filter((row) => row.from === node.id || row.to === node.id),
        });
      }
      if (view === 'tasks') return jsonSafe({ workspacePath: workspace.path, revision: board.revision, tasks: board.tasks, todos: board.todos });
      const todos = args.taskId ? board.todos.filter((row) => row.taskId === args.taskId) : board.todos;
      return jsonSafe({ workspacePath: workspace.path, revision: board.revision, todos });
    },
  })), 'project-board tool: get');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_board_update',
    description: '修改项目看板：节点/连线/任务/待办/备注/决策的增删改、保存节点位置、给任务或待办绑定或解绑多个会话线程。绑定会话不改变条目状态。写操作带 expectedRevision 可避免覆盖他人修改。',
    parameters: {
      workspacePath: workspaceArg,
      expectedRevision: { type: 'integer', description: '当前看板 revision；省略则不做并发检查' },
      commandId: { type: 'string', description: '幂等命令 id，重试时复用同一个值' },
      action: {
        type: 'string',
        required: true,
        enum: [
          'create_board', 'rename_board', 'upsert_node', 'delete_node', 'upsert_edge', 'delete_edge',
          'upsert_task', 'delete_task', 'upsert_todo', 'delete_todo', 'move_todo', 'save_positions',
          'add_note', 'delete_note', 'upsert_decision', 'delete_decision', 'bind_thread', 'unbind_thread',
        ],
        description: '看板操作类型',
      },
      input: { type: 'json', description: '操作参数，例如 {node:{...}}、{id:"..."}、{positions:[{id,x,y}]}。bind_thread/unbind_thread 的 taskId 和 todoId 恰好提供一个，并提供 sessionId；绑定追加且幂等，不覆盖已有会话。仅旧 unbind_thread({todoId}) 可省略 sessionId 清空待办会话。upsert_task/upsert_todo 可保存 threads 数组。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify({ revision: value?.revision, action: value?.action, ok: value?.ok }, null, 2) }],
    },
    timeoutMs: 30000,
    execute: async (args, exec) => {
      const agent = exec.agent;
      const workspace = toolWorkspace(agent, args.workspacePath);
      const result = await service.command({
        workspacePath: workspace.path,
        expectedRevision: args.expectedRevision,
        commandId: args.commandId,
        action: args.action,
        input: args.input,
        actor: `agent:${agent?.id || 'unknown'}`,
        allowCreate: args.action === 'create_board',
      });
      return jsonSafe({ ok: true, action: args.action, revision: result.board.revision, workspacePath: workspace.path, board: result.board });
    },
  })), 'project-board tool: update');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_board_dispatch',
    description: '把项目看板上的任务或待办派发为 Agent Team 任务，并把 team task id 回写到看板。只能在 Agent Team 的 Lead 会话中调用。',
    parameters: {
      workspacePath: workspaceArg,
      expectedRevision: { type: 'integer', description: '当前看板 revision；省略则不检查' },
      commandId: { type: 'string', description: '幂等命令 id' },
      leadSessionId: { type: 'string', description: 'Team Lead 会话 id；省略时使用当前会话（必须是 Team Lead）' },
      items: {
        type: 'array',
        description: '要派发的条目：{taskId} 或 {todoId}',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string' },
            todoId: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 120000,
    execute: async (args, exec) => {
      const agent = exec.agent;
      const workspace = toolWorkspace(agent, args.workspacePath);
      const leadSessionId = args.leadSessionId || agent?.id;
      const result = await service.dispatch({
        workspacePath: workspace.path,
        expectedRevision: args.expectedRevision,
        commandId: args.commandId,
        leadSessionId,
        items: args.items || [],
        actor: `agent:${agent?.id || 'unknown'}`,
      });
      return jsonSafe({ workspacePath: workspace.path, revision: result.board.revision, created: result.created });
    },
  })), 'project-board tool: dispatch');

  // ---- per-agent board digest ---------------------------------------------
  const installed = new WeakSet();
  const installDigest = (agent) => {
    if (!agent || installed.has(agent)) return;
    installed.add(agent);
    try {
      agent.ctx.systemPrompt.context({
        name: 'project_board',
        order: 150,
        text: () => {
          try {
            return digestForAgent(agent);
          } catch {
            return '';
          }
        },
      });
    } catch (error) {
      ctx.logger?.warn?.(`project-board prompt context failed: ${error?.message || error}`);
    }
  };
  ctx.effect(() => {
    for (const agent of ctx.agents.list()) installDigest(agent);
    const off = ctx.on('agent/created', ({ agent }) => installDigest(agent));
    return () => { if (typeof off === 'function') off(); };
  }, 'project-board prompt context');

  /** Synchronous digest computation used from the prompt provider. */
  function digestForAgent(agent) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return '';
    const workspaces = service.registryWorkspaces();
    const matches = workspaces.filter((row) => cwd === row.path || cwd.startsWith(row.path + path.sep));
    const root = matches.length ? matches.sort((a, b) => b.path.length - a.path.length)[0].path : cwd;
    const file = path.join(root, 'board', 'project-board.json');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return '';
    }
    const cached = digestCache.get(file);
    let board = cached && cached.mtimeMs === stat.mtimeMs ? cached.board : null;
    if (!board) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        board = normalizeBoard(raw, { workspacePath: root, title: path.basename(root) });
        digestCache.set(file, { mtimeMs: stat.mtimeMs, board });
      } catch {
        return '';
      }
    }
    const teamTasks = service.teamTasksFor(agent);
    const sessionId = agent?.id;
    // 摘要统一识别任务和待办的全部绑定，系统提示与读取工具保持一致。
    let digest = boardDigest(board, { workspacePath: root, teamTasks, sessionId });
    if (board.assistant && board.assistant.sessionId === sessionId) {
      digest = '你是这个 workspace 的「项目看板 Lead」（Agent Team Lead），用户正在看板页面与你对话。你可以用 project_board_get 读取看板、project_board_update 直接修改节点/连线/任务/待办（用户的语言调整请求直接执行，不要只给建议）；也可以用 spawn_teammate、team_task_*、send_message、wait_agent 组织 Agent Team 执行看板任务；用 project_board_dispatch 把看板任务派发成 Team 任务。修改后简短说明改了什么。除非用户明确要求，不要修改项目文件或运行实验。\n' + digest;
    }
    return digest;
  }
}
