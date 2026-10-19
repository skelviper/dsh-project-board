# dsh-project-board

A project board for DSH Web: one independent board per workspace, with a draggable canvas, tasks, todos, linked DSH conversations, and Agent Team dispatch.

Version **0.2.0** · **MIT** · **Chinese UI**. This standalone repository contains the plugin source copied through an explicit file allowlist. It includes no live workspace boards, conversation histories, or project screenshots.

## Features

- Organize milestones, components, documents, and other work as nodes; connect them with containment, dependency, or output relationships.
- Break nodes into tasks and todos with acceptance criteria, owners, dependencies, advisory write scopes, notes, decisions, and artifact references.
- Link multiple DSH sessions to each task or todo. Read and continue conversations inside the board, using native DSH history, drafts, attachments, model selection, and reasoning settings.
- Give agents a board summary in their runtime context; use `project_board_get`, `project_board_update`, and `project_board_dispatch` to coordinate planning and execution.
- Preview workspace files and folders in place, including text, code, JSON, images, PDF, and rendered Markdown.
- Create a separate empty board for each registered workspace. Data stays in that workspace at `board/project-board.json`.
- Review a needs-attention inbox, search a list of work items, and filter by branch, status, node kind, or delivery outcome.
- Record delivery summaries, review decisions, and a primary artifact independently of acceptance requirements.
- Inspect bounded change history and undo individual changes when their fields and relationships still match.
- Use consistent descendant and leaf-work statistics across the canvas, lists, and agent summaries.

Node kinds include `theme`, `milestone`, `component`, `document`, `experiment`, `figure`, `manuscript`, `infra`, and `historical`. The original kinds remain available alongside the three general-purpose additions.

For a software delivery project, use a `milestone` node for “Release 1.0”, `component` nodes for “API” and “Web client”, and a `document` node for “Release guide”. Add reviewable tasks and link their implementation or review sessions. See the [usage guide](docs/usage.md) for the workflow and data model.

## Requirements and compatibility

| Requirement | Supported configuration |
| --- | --- |
| Node.js | `>=22` |
| DSH | Validated only with `0.2.1-rc.2`; `engines.dsh` declares exactly `0.2.1-rc.2` |
| Profile | DSH `web` profile with the required host and browser services |
| Interface language | Chinese; this documentation is in English |

The host plugin requires `connection`, `tools`, `systemPrompt`, `agents`, `agentTeams`, `workspaceRegistry`, and `sessionQuery`. Embedded conversations, file access, and Markdown rendering depend on the DSH runtime and its browser module loader. Zero external build dependencies does not make the plugin a standalone web application.

Other DSH versions are unverified. Revalidate the integration before changing the declared version, especially the sidebar DOM and native UI hooks described below.

## Install

With Node.js and DSH available, build a local source checkout from its repository root:

```sh
npm run build
```

No dependency installation is needed to build or test the source. The target Web profile must have the official Agent Team bundle enabled. In a fresh profile, install it before the board:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.2
dsh plugin --profile web add /absolute/path/to/dsh-project-board
```

Skip the first command if that bundle is already enabled. Agent Team replaces the profile's direct subagent delegation tools with Team tools; this affects all sessions in that profile. The board requires its service and does not enable it silently.

Replace the absolute path with your checkout location. The [package manifest](package.json) declares `dsh.bundle.patch = "./cordis.patch.yml"`; the plugin manager uses the [bundle patch](cordis.patch.yml) to register the plugin. The default package entry is [entry.mjs](entry.mjs), which loads [host.mjs](host.mjs). Do not add a second manual registration for the same plugin.

Once DSH Web has loaded the plugin, refresh its existing page. Open **看板** (Board) in the sidebar, select a registered workspace, and click **创建看板** (Create board). An expanded workspace also has a **项目看板** (Project board) entry beneath its header.

### Install from GitHub

With the required Agent Team bundle enabled, install the tagged release directly:

```sh
dsh plugin --profile web add github:skelviper/dsh-project-board#v0.2.0
```

Source and release assets are available from [skelviper/dsh-project-board](https://github.com/skelviper/dsh-project-board) and its [v0.2.0 release](https://github.com/skelviper/dsh-project-board/releases/tag/v0.2.0). For an offline plugin archive, download `dsh-project-board-0.2.0.tgz` and pass its absolute path to the same `dsh plugin --profile web add` command.

### Migrate an existing manual installation

1. Back up each workspace's `board/project-board.json` and retain the existing DSH profile and session storage.
2. Remove or disable the old manual registration in the Web profile's Cordis patch, including an entry such as `./project-board/entry-vN.mjs`. Ensure the old plugin is no longer loaded before adding this package.
3. Build and install this package with the standard command above. Keep exactly one active project-board registration, then restart the DSH Web service and refresh its page.
4. Open the existing workspace and confirm its board and linked sessions. The board location and schema version remain the same; the old single-session `thread` field is normalized to `threads` when read.

Installing this package does not copy boards or session histories. Boards remain in their workspaces, while the referenced sessions remain in DSH storage. Loading both installations can duplicate routes, tools, and UI entries. Back up before upgrading: although the schema number remains 1, a 0.1.x writer does not preserve the delivery and history fields added in 0.2.0. Do not downgrade a live board or run old and new writers concurrently.

## Maintain and build

Run these commands from the repository root; none requires `npm install`:

```sh
npm run build
npm test
npm pack
```

[build-host.mjs](build-host.mjs) and [build-client.mjs](build-client.mjs) manually concatenate the ordered host modules and browser source fragments using Node.js built-ins. They produce [host.mjs](host.mjs), the default loader [entry.mjs](entry.mjs), and [client.js](client.js); no external bundler is needed. Host code is maintained in the root modules, and browser code in [client-src/](client-src/). Edit source modules and rebuild the generated bundles. `npm pack` also runs the build and syntax checks through `prepack`.

After host changes, restart DSH Web to clear the ESM module cache. After browser changes, rebuild and refresh the existing DSH Web page. Automatic browser updates require the matching DSH checkout's `pnpm run dev:web` watcher; do not assume it is running. Source regression tests do not replace validation inside the supported DSH Web runtime.

## Validation

The standalone source passes 140 automated tests on Node.js 24, including independent workspaces with identical entity and command IDs, explicit cross-workspace digest reads, artifact path boundaries, conflict-checked undo, shared progress statistics, delivery forms, general-purpose node previews, and reproducible builds from paths containing spaces and Unicode. The DSH `0.2.1-rc.2` profile loader also composes the bundle once and its real tool definitions register all three tools and seven routes. CI checks Node.js 22 and 24; pushed version tags publish release archives only after both checks pass.

These checks use isolated temporary projects. The extracted release has not replaced an existing live installation or received a new browser acceptance run.

## Known limits

- **Sidebar DOM:** per-workspace entries use a `MutationObserver` and DSH's workspace tree selectors, including `[data-row-key^="workspace:"]`, `aria-expanded`, and `role="tree"`. They are hidden in search, single-list, and collapsed-workspace views; use the global **看板** button there.
- **Native UI:** embedded sessions depend on DSH session providers and factory slots. In `0.2.1-rc.2`, local file previews wrap the native `conversation.view` chat component and user file-reference component during the plugin lifecycle, restoring them on disposal. These integration points require revalidation after a DSH upgrade.
- **Runtime imports:** React, React DOM, DSH tools, and the native Markdown components come from DSH. Opening the browser bundle directly or serving it as a separate app is unsupported.
- **Platform:** runtime integration has been checked on Linux. macOS is unverified; Windows workspace paths and reverse proxies mounted below a URL subpath are not supported by this release.
- **Storage:** use one DSH server process per workspace. Writes are atomic and serialized within a plugin instance; they do not coordinate CAS locks across separate servers.
- **Status:** session activity and team badges provide execution hints. A reply, a completed background job, or a dispatched item does not establish task acceptance; update board status after reviewing the result.
- **Data:** there is no automatic project-file scan or file-to-board synchronization. Ask an agent to inspect the relevant files and update the board. Preview limits and permissions come from DSH's file service; the artifact HTTP endpoint has a 25 MiB limit.
- **Sessions:** each item supports up to 20 linked sessions. Removing a link or deleting a board item preserves the underlying DSH session. A board file alone is not a session-history backup.

## License

MIT. See [LICENSE](LICENSE).
