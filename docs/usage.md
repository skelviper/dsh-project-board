# Usage guide

`dsh-project-board` 0.2.1 adds a project board to DSH Web. The UI is Chinese; the labels below include English explanations. Follow the [installation and migration instructions](../README.md) first. Compatibility is validated only with DSH `0.2.1-rc.2` and Node.js `>=22`.

## Create a board for a workspace

1. Register your project directory as a workspace in DSH.
2. Open **看板** (Board) from the global sidebar, or **项目看板** (Project board) beneath an expanded workspace header.
3. Select the intended workspace in the board's header and click **创建看板** (Create board).
4. Add nodes, tasks, and todos. Repeat for other workspaces to create independent empty boards.

The plugin creates `board/project-board.json` inside the selected workspace. It does not seed a board with demonstration or private project content. Switching workspaces loads that workspace's board.

The right pane has **看板 Lead** (Board Lead) and **节点检查器** (Node inspector) tabs. On first opening the Lead pane, the plugin creates and binds a DSH session if the board has none. Task and todo sessions are created only through their explicit **新建会话** (New session) action.

## Plan a software delivery

For example, create these nodes for a fictional application release:

| Node kind | UI label | Example title | Purpose |
| --- | --- | --- | --- |
| `theme` | 主题 | Product delivery | A broad project branch |
| `milestone` | 里程碑 | Release 1.0 | A delivery checkpoint |
| `component` | 模块 | API | A software component or workstream |
| `component` | 模块 | Web client | Another implementation workstream |
| `document` | 文档 | Release guide | A document to deliver |
| `infra` | 基建 | Build pipeline | Supporting infrastructure |

The original node kinds remain available: `theme`, `experiment`, `figure`, `manuscript`, `infra`, and `historical`. Version 0.1.0 also provides the general-purpose `milestone`, `component`, and `document` kinds. Choose a kind for organization; acceptance criteria belong on tasks and todos.

Add a task such as “Publish the API contract” under “API”, with acceptance criteria such as “The contract describes all public endpoints and has a completed review.” Split it into todos for drafting, review, and final approval. Register the resulting document as an artifact when it exists.

In the Board Lead conversation, requests can be written in English, for example:

> Create a Release 1.0 milestone, API and Web client components, and a Release guide document. Add a task to review the API contract, with drafting and review todos. Read the current board before making changes.

The Board Lead can change the board through the plugin tools. Opening a conversation restores its history and your draft without sending a request. Enter your next instruction and submit it through DSH when ready.

## Work with the canvas and inspector

- Click **节点** (Node) or double-click empty canvas space to create a node. Drag nodes to position them; positions save automatically.
- Use the mouse wheel and the lower-left controls to zoom, or **适应** (Fit) to fit the board. **自动整理** (Auto arrange) reorganizes node positions.
- Choose **连线** (Connect), select a relationship type, then click the source and target nodes. **归属** (`contains`) runs from parent to child; **依赖** (`depends`) from prerequisite to dependent; **产出** (`produces`) from source to output. The containment UI prevents multiple parents and cycles.
- Click or right-click an edge to select it and open its menu. **删除连线** (Delete edge) removes that edge. Press Esc or click empty space to dismiss the selection.
- Select a node to open its inspector. **概览和任务** (Overview and tasks) contains the editable summary and task list; **产物** (Artifacts) collects registered files; **历史** (History) contains notes and decisions.
- Figure, milestone, and component cards preview three tasks by default. **展开全部 N 项** (Expand all N items) shows the full list, including completed and dropped tasks. Expansion temporarily shifts nearby cards without changing their saved positions.

The Lead pane, inspector, and item conversations share a resizable right pane. Drag its divider or focus it and use the arrow keys; double-click to restore the default 400 px width. The width is saved in the browser's local storage.

## Use task and todo conversations

Each task and todo can link up to 20 DSH sessions. Click **会话** (Conversation) to open the sole linked session or choose among several; use the adjacent arrow to manage links or select **新建会话** (New session). The native composer retains each session's history, draft, attachments, model, and reasoning settings.

A todo with no session of its own can use its parent task's sessions, shown as **所属任务会话** (Parent task conversation). This is a fallback for viewing and navigation, not an extra stored binding. A todo's own links take priority; removing its last own link restores the fallback. Remove inherited links from the parent task, not from the todo.

**任务背景 · 已自动关联** (Task background · Automatically linked) is a collapsed preview of the background associated with the selected session. Your composer contains only your own draft. The host supplies necessary requirements as a separate context message when you send: the first message includes the background, later messages include only relevant changes, and unchanged background is retained. If compaction removes the complete baseline, the host supplies it again. An inherited task session receives its actual task association rather than an extra todo binding. Opening the page itself does not start work.

Complete legacy task-background templates are removed from the start of a draft using a revision-checked range edit. Text you added after the template, reference chips, and attachments are retained. Drafts that do not match the known template remain unchanged.

**打开完整会话** (Open full conversation) navigates to the same session ID after it finishes loading. Loading failures are shown with a retry action. Removing a session link, task, or todo does not delete the actual DSH conversation. Deleting a task also removes its todos and their board references.

## Dispatch work and interpret status

Use **派发** (Dispatch) on a task, or ask the Board Lead to dispatch a task or todo through `project_board_dispatch`. Dispatch requires an Agent Team Lead session. The plugin attempts to resume an inactive bound Lead before dispatching; if it cannot obtain a live Lead, send a message in the Board Lead conversation and retry.

Dispatch creates an Agent Team task and stores a reference on the board item. The board reads current team ownership and execution state from DSH's session projections. The board's planning status remains a separate record that agents or users should update after reviewing progress and acceptance criteria.

Task and todo statuses are `todo`, `doing`, `blocked`, `done`, `deferred`, `dropped`, and `historical`. Execution badges include **运行中** (Running), **可查看** (Result available), **待你处理** (Needs your input), **待运行/待继续** (Waiting to run or continue), and **需检查** (Needs inspection). A result being available is a reason to inspect it, not evidence that the task meets its acceptance criteria. Linking a conversation does not start or complete an item.

## Attention, deliveries, and change history

The **待我处理** (Needs my attention) inbox combines linked conversations waiting for input, unresolved questions, explicitly submitted deliveries, and blocked work. A normal conversation reply does not create a review request. Marking an entry as viewed is browser-local; accepting or requesting changes is a separate saved review decision.

**画布 / 列表** (Canvas / List) share search and filters for branch, progress status, node kind, and delivery outcome. Search includes titles, requirements, delivery summaries, artifact paths, and linked conversations. Choosing a list item locates its node and task. Unassigned nodes have their own filter; reparenting remains an explicit edit. Viewport and expanded-card state are stored separately for each workspace.

`acceptance` holds the requirement. Record the actual result in `delivery.summary`, with an independent `delivery.outcome` of `unspecified`, `supported`, `not_supported`, `not_triggered`, or `inconclusive`. These outcomes do not change task progress. `delivery.review` is `none`, `pending`, `accepted`, or `changes_requested`; **提交验收** (Submit for review) explicitly sets `pending` and an ISO `submittedAt` timestamp. Existing entries begin unspecified rather than inferring a result from older text.

Select `primaryArtifactPath` from the item's registered artifact paths, or clear it. The primary-artifact shortcut reuses the existing file preview. Long requirements and notes show a summary with an option to expand their original text.

Statistics include a node itself and every descendant reached through `contains` edges, with each task and todo counted once. A task with todos contributes its todos; a task without todos contributes itself. **完成** (Done) counts only `done`; **已结束** (Closed) includes `done`, `dropped`, and `historical`. Closure percentage describes workflow progress and does not imply that a hypothesis was supported.

The **变更** (Changes) view and item history show actor, time, affected entries, and eligible undo actions. Call `project_board_update` with `action: "undo_change"` and `input: {"changeId": "…"}` to undo one change. Undo restores only the original fields and first checks their current values, entry identity, and relationships; any conflict rejects the entire undo. Cascaded data from an empty board-only node or task deletion can be restored together. Deletions with files, session associations, team dispatch, and other external actions cannot use this JSON-only undo.

History is stored in `changes[]` within the same board, bounded to 80 records and 2 MiB. Large changes retain a summary without undo data. History is recorded for new operations; old operations cannot be reconstructed retroactively. History can retain deleted content and its actor until it ages out, so deleting an item does not immediately erase its history. These records are project data and must not be included when sharing the plugin source.

## Preview artifacts and source files

Register file or directory paths on nodes, tasks, or todos. In **产物** (Artifacts) or **链接与来源** (Links and sources), click a path to open an in-board preview:

- Browse directories with Back, Up, and breadcrumb navigation.
- Read text, code, and JSON in pages; display supported images and PDFs directly.
- Use **渲染 Markdown** (Render Markdown) to render a complete Markdown document, or **查看源码** (View source) for paged source text. Local links and images resolve relative to the document's directory within the workspace.
- Drag the bottom-right handle to resize the preview, use arrow keys for small changes and Shift for larger ones, or double-click to reset. **最大化** (Maximize) and **还原** (Restore) preserve the manual size. Esc closes the preview.

File links, image cards, and `@file` references inside embedded conversations use the same preview. It uses an existing session as the context for DSH's read-only `remote.workspaceFiles` service; previewing a file does not create or activate an agent. The service controls access, read limits, and errors. Manual downloads and artifact thumbnails use the plugin's artifact endpoint, which limits files to 25 MiB.

The board stores references to artifacts, not copies of their contents. **刷新** (Refresh) only reloads board data. **更新看板** (Update board) checks the selected active scope and sends an organization request to the existing Board Lead session. The Lead prioritizes updating existing tasks and sources against the current project goals and adds a node only for a clearly independent work item. Newly discovered directories and documents become candidate clues in `maintenance.candidates`; discovery does not create a card for each path. Independent changes to an already linked source can still merge automatically. Unchanged source fields preserve manual edits; conflicting edits keep the board value and create an explicit decision.

## Maintain disk content and archive deleted work

Open **维护记录** (Maintenance records) to see the last check, the number of **待整理** (Awaiting organization) clues, unresolved conflicts, and deletion/archive records. The clue count includes only candidates with `status: "pending"`; candidates already linked to work are excluded. The panel keeps this information compact instead of listing every discovered directory or document. Follow the existing Lead conversation for organization progress. Choose **保留看板 / 采用盘上** to resolve a field conflict. The service checks the current board value and source fingerprint before applying the choice; if either changed, check again and decide from the new context.

Both **更新看板** (Update board) and the separate **通知看板 Lead** (Notify Board Lead) form use `operation: "notify"`: check disk content, then queue a request in the existing Lead session. The main button supplies the project-oriented organization instruction; the separate form retains an optional message for the user. The same conversation, model settings, and history remain available. **已通知** (Notified) means that the request was queued, not that organization has finished. Notifications do not interrupt the Lead's current turn. Agents working in the same workspace can call `project_board_maintain` with `operation: "notify"`, a stable `commandId`, and a short `message` after creating a report or completing a task. `operation: "scan"` remains available as a bounded check without waking the Lead. The Lead can inspect unresolved choices and ask the user when interpretation is needed. Board changes arrive through SSE; there is no polling or continuous file watcher.

The collapsed scope configuration is empty by default: `scope: "linked"` with `roots: []` checks already linked active entries. Enter project-relative directories, one per line, to use a custom scope (`scope: "custom"`). Clearing the input and saving sends `roots: []` and restores the linked scope. Checks have bounded depth, entry, candidate, and document-size limits. Discovery reads Markdown metadata and project-unit names; it excludes historical archives, public-input payloads, source repositories, hidden/control directories, and deep training output trees. Limits and skipped paths are reported in the summary. Unknown content remains a candidate for the Lead to organize; its existence never marks a task completed, accepted, or scientifically supported.

**删除并归档** (Delete and archive) removes the selected board item and its directly attached work. Deleting a node preserves its contained child nodes. The service first persists a durable deletion marker; late agent updates and future scans cannot recreate that item or its recorded source paths. Session histories remain available in DSH.

Model calls that can process the archive queue (`delete_node`, `delete_task`, `delete_todo`, `undo_change`, and maintenance `scan`/`notify`/`resolve`) are restricted to the caller's current workspace and standing writable sandbox boundary. Read-only, missing-policy, and out-of-boundary calls are rejected before board mutation or file moves. Authenticated user actions in the Web UI remain separate from these model-tool checks.

Only explicitly owned paths can archive automatically. A top-level theme's directory-navigation link does not claim every descendant as a shared input; actual source/artifact/scope/ownership references remain protected. Candidate discovery and pre-existing links alone do not establish ownership; exclusive paths must be recorded explicitly in `ownedPaths`. Unclear ownership, protected/shared paths, ongoing sessions/jobs, limits, or filesystem errors preserve the files and create a choice. **保留文件** retains disk content while keeping the deletion marker; **重试归档** confirms the listed scope and rechecks occupancy and sharing. It cannot override those protections.

Archives are written beneath `archive/board/<operation-id>/` with a per-file size/SHA manifest and direct completion receipt. Normal maintenance never enumerates an existing archive. Same-filesystem renames retain the original bytes; interrupted operations retain moved and unmoved content and report the exact manifest for review. They are not silently resumed or overwritten. A deletion with files cannot use JSON-only undo. Empty board-only deletions remain eligible for checked undo; there is no automatic restoration of archived files.

Maintenance scope, candidate clues, linked sources, field baselines, choices, and durable deletion markers are stored inside the original board, rather than in a parallel project-status file. Each candidate records `path`, `kind`, `title`, `summary`, `fingerprint`, and a `pending`, `linked`, or `dismissed` status; a linked candidate may also record `targetType` and `targetId`. The Lead can use `operation: "dismiss"` with `paths` and a brief `message` to ignore unrelated clues without recreating them on a later check.

## Agent tools

Agents receive a compact board summary in their runtime context when their workspace has a board. Read the latest board before planning or reporting progress, then update the relevant entries when work changes.

| Tool | Purpose |
| --- | --- |
| `project_board_get` | Read `digest`, `board`, `node`, `tasks`, `todos`, or a compact session `thread` |
| `project_board_update` | Create or rename a board; edit nodes, edges, tasks, todos, notes, decisions, positions, and session bindings |
| `project_board_dispatch` | Create Agent Team tasks from board tasks or todos, using a Lead session |
| `project_board_maintain` | `state`, bounded `scan`, `notify` the persistent Lead, `resolve` a conflict, or `configure` roots; current workspace only |

`workspacePath` selects a registered workspace by absolute path. When omitted, the tools resolve the workspace from the current session's working directory. For another workspace, request `view: "board"` explicitly to inspect its full state.

For example, read the current board with:

```json
{"view":"board"}
```

Then pass the returned revision to `project_board_update`. This illustrative call creates a component; replace `7` with the actual revision:

```json
{
  "expectedRevision": 7,
  "commandId": "add-api-component-1",
  "action": "upsert_node",
  "input": {
    "node": {
      "id": "component-api",
      "kind": "component",
      "title": "API",
      "status": "todo",
      "x": 120,
      "y": 160
    }
  }
}
```

Use `expectedRevision` for optimistic concurrency. On `STALE_REVISION`, read the current state and reconcile the intended edit before retrying. Reuse the same `commandId` when retrying the same mutation; successful command IDs are retained in a bounded history. A different edit needs a different command ID.

For session bindings, use `action: "bind_thread"` with `input` containing exactly one of `taskId` or `todoId`, plus `sessionId`. Use `unbind_thread` with the same target and session ID to remove only that link. Binding a session does not change item status.

## Stored data model

The schema version remains `1`; the package version is `0.2.1`. The main structures are:

```text
board:  { version, revision, workspacePath, title, nodes[], edges[], tasks[],
          todos[], decisions[], notes[], changes[], assistant?, maintenance?, applied[], timestamps… }
node:   { id, kind, title, summary, status, x, y, w, links[], derivedFrom[], tags[] }
edge:   { id, from, to, kind: contains|depends|produces, label }
task:   { id, nodeId, title, status, owner, acceptance, blockedBy[],
          writeScopes[], artifacts[], primaryArtifactPath, delivery, threads[], team?, order }
todo:   { id, taskId, title, status, owner, acceptance, artifacts[],
          primaryArtifactPath, delivery, threads[], team?, order }
delivery: { summary, outcome, review, submittedAt }
thread: { sessionId, title, createdAt, updatedAt }
team:   { leadSessionId, taskId, ownerName?, status?, revision?, linkedAt }
```

Nodes organize work; each task belongs to one node and each todo to one task. `blockedBy` references task IDs. `links` and `artifacts` hold paths and labels. Notes attach to a board, node, task, or todo; decisions hold a question, an `open` or `answered` status, and an answer. Node statuses additionally support `active`, `deferred`, and `historical`.

`board.assistant.sessionId` references the Board Lead. `task.team` and `todo.team` reference Agent Team tasks; live team state comes from DSH. Session histories and artifact contents are not embedded in the board JSON.

Writes are serialized per workspace within the plugin instance and replace the board file atomically. Revisions support compare-and-swap checks; command IDs provide bounded retry deduplication. Use the UI or tools for edits so these controls apply. Back up the board file as project data, and retain DSH session storage separately if linked histories must remain available. Do not assume coordination between independent DSH server processes writing the same workspace.

## HTTP integration

The following routes are registered through DSH's authenticated `connection.fetch` service. Use them within the DSH runtime and its authentication context.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/project-board/workspaces` | Registered workspaces and board existence |
| GET | `/api/project-board/state?workspacePath=…` | Board state |
| POST | `/api/project-board/command` | Mutation with optional `expectedRevision` and `commandId` |
| POST | `/api/project-board/dispatch` | Agent Team dispatch |
| POST | `/api/project-board/maintenance` | On-demand scan/notify/configure/resolve/state with `workspacePath` and `operation` |
| GET | `/api/project-board/thread?sessionId=…&limit=…` | Compact session transcript |
| GET | `/api/project-board/artifact?workspacePath=…&path=…` | Workspace artifact download or preview, up to 25 MiB |
| GET | `/api/project-board/events?workspacePath=…` | Server-sent board change notifications |

Encode query values. A command body contains `workspacePath`, `action`, `input`, and optionally `expectedRevision` and `commandId`; it follows the same mutation model as the tools.

## Compatibility and troubleshooting

| Symptom | What to check |
| --- | --- |
| No per-workspace sidebar entry | Expand the workspace in the standard tree, or use the global **看板** button. Search and single-list views do not show injected rows. |
| Workspace absent from the selector | Register the directory in DSH; the HTTP/UI surface uses the workspace registry. |
| Duplicate tools, routes, or board entries after migration | Disable the old manual Cordis registration, keep one package registration, restart DSH Web, and refresh the page. |
| A board edit reports a revision conflict | Reload the board and apply the edit to the latest state. |
| An embedded conversation or Markdown preview fails | Confirm DSH `0.2.1-rc.2`, its native session/slot services, and runtime module imports; this package does not provide standalone replacements. |
| Dispatch cannot find a live Lead | Open the Board Lead conversation, send a message, and retry; dispatch requires Agent Team Lead membership. |
| A file preview fails | Confirm the file is inside the selected workspace, the session is available, and DSH permits the read. Large or unsupported files may require download. |
| Changes to source do not appear | Rebuild the bundles. Restart DSH Web for host changes and refresh its existing page for client changes. |

The per-workspace sidebar entry depends on DSH DOM selectors and a `MutationObserver`. Native UI embedding depends on session providers and factory slots; in-board file previews temporarily wrap native chat and file-reference slot components because DSH `0.2.1-rc.2` lacks per-instance preview callback configuration. Markdown imports are supplied by DSH's browser module loader. These are version-sensitive integration points. Only `0.2.1-rc.2` has been validated, and the package declares that exact DSH engine version.

Maintenance commands, installation paths, and the MIT license are described in the [README](../README.md).
