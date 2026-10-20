# Changelog

## 0.2.2

- Add canvas marquee selection and Shift/Ctrl/Command selection adjustments.
- Move selected nodes together in one position save, retaining their preview until the save completes.
- Keep selection while panning with the middle button, Alt-drag, or touch; clear it with Esc or an empty click.
- Arrange nested branches using measured card heights, with direct horizontal links for single-child chains.
- Clear stale selections after project changes and external node deletion.
- Correct modifier-click removal of a nonfirst selected node and preserve the displayed origin during rapid consecutive drags.
- Keep input-field and dialog Escape actions from clearing the underlying canvas selection.
- Preserve the archive permission and conversation-context boundary fixes from 0.2.1.

## 0.2.1

- Add on-demand disk discovery, persistent source baselines, and field-level three-way merges through the Board Lead and a maintenance API/tool.
- Add update/notify controls, archive records, and explicit choices for unresolved maintenance conflicts.
- Record durable deletion markers and archive explicitly owned outputs with SHA manifests, shared-reference and running-job checks; late upserts cannot recreate deleted work.
- Preserve draft field bases across remote updates, so an old editor cannot silently replace a concurrent edit.
- Keep scans bounded and exclude historical archives, public-input payloads, source repositories, and training output trees; file presence never establishes completion or acceptance.
- Supply linked task context separately from user drafts, send only changed context on later steps, and restore the full baseline after compaction when needed.
- Preserve user text and attachments when removing a complete legacy task-background draft template.
- Constrain model-triggered file archiving to the calling workspace and its standing writable sandbox boundary; keep maintenance notices distinct from real user prompts in compact transcripts.
- Preserve task associations on board read failures and honor downstream rejection of offered continuation input.

## 0.2.0

- Add task and todo delivery summaries, outcomes, review states, and primary artifacts.
- Add a needs-attention inbox, searchable list view, and branch/status/type/outcome filters.
- Record bounded change history with conflict-checked field-level undo.
- Share leaf-work progress statistics across the canvas, lists, and agent digests.
- Preserve per-workspace viewport and card expansion state.
- Keep standalone milestone/component/document nodes, explicit workspace digest reads, canonical artifact path checks, and portable deterministic builds.

## 0.1.0

- First standalone DSH Web plugin bundle with workspace-local boards.
- Graph navigation, tasks, todos, decisions, notes, and artifact previews.
- Linked conversations, board assistant, and Agent Team dispatch.
- Agent tools and automatic board context.
- General-purpose milestone, component, and document nodes alongside research node types.
- Reproducible host and browser builds with no external build tools.
- Compatibility target: DSH 0.2.1-rc.2.
