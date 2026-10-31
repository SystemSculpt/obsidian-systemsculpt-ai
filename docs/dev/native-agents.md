# Native agents

Repository instructions for backend selection, detection, Claude Code, Codex,
native chat lifetime and Studio native execution. Read with
[the core](../../AGENTS.md); hosted execution is covered in
[managed execution](managed-execution.md).

## Repository boundary

Michael's 2026-09-05 direction revives this plugin as the SystemSculpt product surface and retires development of the standalone desktop app. Personal agent execution uses Codex and T3 Code directly. Preserve saved projects, drafts, and history. Michael’s 2026-09-08 direction authorizes selectable on-machine Codex for ChatView, Studio text generation and desktop Studio Codex task cards through the installed Codex app-server and the machine’s existing Codex login, as in T3 Code. This is a thin local protocol client exception: Codex owns its agent loop, credentials, approval review, tools and authoritative thread history; never copy tokens or introduce a separate agent runtime. Michael’s 2026-10-14 direction adds on-machine Claude Code to ChatView and Studio text generation under the same exception: the installed `claude` CLI owns its login, settings, permissions, tools and session history; the plugin never reads file contents under ~/.claude or ~/.codex; agent detection may list session-store names and timestamps (Michael, 2026-10-23). It never passes `bypassPermissions` or `dontAsk`. Michael’s 2026-09-08 run-board direction also authorizes independent explicit native Codex run instances and project-scoped message/handoff tools. The plugin projects public native activity, stores a bounded presentation cache, and forwards explicit messages as native turns; ordinary independent runs must not infer completion or schedule autonomous continuation. Michael’s 2026-09-08 Command Center direction authorizes owner-started native Codex orchestrators: persist the model-authored plan, dispatch bounded assignments, deliver child results and resume interrupted workflow threads. Codex chooses every next step and explicitly declares the objective outcome; Studio handles event delivery and recovery only. Managed SystemSculpt AI keeps the API boundary above. Preserve existing standalone work while reusing applicable portable Studio behavior here.

## Product contracts

- New desktop chats honor an explicit execution-backend choice first and preserve
  paid hosted users' selection during migration. Otherwise, choose among installed,
  usable Claude Code and Codex by primary session-file count in the last 30 days
  (using file modification times), then newest session-file mtime; Claude Code wins
  an exact tie. If neither is usable, use hosted SystemSculpt. Saved chats retain
  their backend. Desktop users need no SystemSculpt account or license to use their
  own agents; mobile uses hosted execution.
- Agent detection is cached for the Obsidian session. A timed-out sign-in probe
  is unknown, not signed out: an installed agent with sessions in the last 30 days
  remains usable. Retry unknown probes once in the background with the same 3-second
  window; refresh status without switching an open chat's backend. Otherwise refresh
  with **Detect again** or after a native run fails because the agent is missing or
  signed out; do not poll. Usage detection may only list/stat native session-store names and timestamps,
  never read file contents or credentials. Chat states what runs where in one run
  line under the composer (backend, mode, model or hosted credits), each part a
  one-click menu; **Detect again** lives in its backend menu on desktop.
- Codex catalog reads, native chats and Studio runs share one app-server for the
  plugin session. Each caller owns its own native threads, event stream and approval
  requests; stopping one turn never stops another caller's work. Completed standalone
  runs unsubscribe their threads. After 60 seconds with no catalog read or active turn
  (including a turn waiting on a tool), the process closes; plugin unload also drains
  it. Retained chats then resume their native thread with a reconnect notice, without
  replaying prior approval answers. Codex owns session-scoped grants: unsubscribing
  detaches a caller but does not promise to clear native grants before native unload.
  Reconnect and changed launch preferences drain active callers before starting a
  replacement process; new connections never silently use the previous launch configuration.
- Native chat turns belong to the plugin, not a view. Switching history, starting
  New chat, or closing a view leaves an admitted Claude Code or Codex turn running
  and saves its answer to the original Markdown transcript. Reopening attaches to
  the live session, including pending approvals. Stop, deleting the chat, and
  unloading the plugin cancel the turn; navigation never implies approval.
- New Claude Code chats default to **Auto** (`auto`), using Claude Code's native
  safety checks, not permission bypass. Manual choices are **Ask before edits**
  (`manual`), **Accept edits** (`acceptEdits`), **Plan only** (`plan`), and **Claude
  Code settings** (no permission-mode override). If Auto is unavailable, use Accept
  edits with a visible Auto-unavailable notice. Never pass `bypassPermissions` or
  `dontAsk`; ChatView answers native permission requests in inline approval
  cards. Studio retains its native request dialog.
- New Codex chats default to **Auto**: `on-request`, `workspace-write` rooted in the
  vault, and `approvalsReviewer: auto_review`. **Ask** keeps the same approval policy
  and sandbox with reviewer `user`; **Read only** uses `read-only` and `never`.
  Plugin-defined modes never request `danger-full-access` or pair `never` with a
  writable sandbox. **Codex settings** inherits native approval policy, sandbox,
  permission profiles and reviewer unchanged. Resuming in settings mode resolves
  current native configuration through an ephemeral thread without a model turn.
- Unset Codex model and thinking selections inherit the installed Codex configuration:
  omit both overrides from native thread and turn requests. Catalog defaults are
  display hints, never persisted model overrides. Explicit selections remain overrides.
- Chat's Codex approval-mode override does not apply to Studio. Studio continues to
  inherit native Codex configuration, including on resume; `CodexExecutionOptions`
  carries model, effort and service tier, not the plugin chat approval mode.
