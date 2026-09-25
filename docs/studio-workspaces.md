# Directory workspaces and native execution

The plugin supports native Codex task cards. Saved legacy workflow definitions remain readable, but their execution integration has been removed.

Studio can open a small entry file that points to a generated graph in an adjacent
directory. It keeps the existing project identity and uses the same persistence
and conflict checks as a single-file project:

```json
{
  "schema": "studio.entry.v1",
  "id": "stable-project-id",
  "projection": "Example.studio/views/graph.systemsculpt"
}
```

The external workspace adapter owns `studio.json`, source records, reusable role
definitions in `roles/*.yaml`, workflow modules and shared prompt files. It validates an entire revision before publishing. Existing runs
retain their admitted revision. An invalid definition retains the last valid view
and blocks new runs until repaired. Keep the entry and directory together; connector
workspaces currently require renaming through their configuration.

The graph remains the single view. Canvas placement is manual: agents preserve
existing coordinates and specify positions for new nodes. Connections, parents
and ordinary groups never reposition cards. Generator-owned Outputs containers
arrange only their generated media cards. Collection
nodes provide Kanban grouping, filtering and bounded card rendering over a snapshot.
Grouping changes presentation; source mutations use the owning adapter.

## Automatic source collections

External connectors publish collection snapshots into the vault. Studio observes
changes to the open graph and redraws source data without requiring a manual node
run. A source-owned snapshot takes priority over old run output. Search, expanded
details, pagination and scroll are retained within the document and project.

A connector can add this reusable envelope beside its `items` (or configured path):

```json
{
  "source": {
    "schema": "studio.source.v1",
    "label": "Issue tracker",
    "mode": "automatic",
    "status": "ok",
    "observedAt": "2026-09-08T12:00:00Z",
    "checkedAt": "2026-09-08T12:00:30Z",
    "maxAgeSeconds": 360,
    "url": "https://example.com/project"
  },
  "items": []
}
```

Use `error`, `unavailable` or `partial` with a `message` when refreshes fail. Keep the
last complete records and their observation time. Studio distinguishes a recent
check from fresh evidence, ages the status while idle, and releases its timer when
the card closes. Source-managed cards link to the source; their connector owns
refreshing and writes. Display remains portable across synced desktop/mobile vaults.

Items can carry `description`, `comments` (body, author, updatedAt, url),
`moreComments`, `detailsTruncated` and per-item `observedAt`. Details expand lazily;
descriptions are capped at 20,000 characters and ten comments at 4,000 each. Text is
rendered safely, with HTTPS links to the complete source. Existing custom field
paths remain configurable.

The benchmark connector refreshes Linear and derived registry summaries every two
minutes while the source Mac is awake. Maintenance checks reuse that schedule with
a 15-minute interval. Only actual evidence changes its observation date. New issues
match declared title/label rules, with unmatched or ambiguous tickets visible in a
separate collection. Participation and exclusions remain explicit registry records.

Workflow definitions can declare `availability: {status: "unavailable", message:
"..."}`. Both the card and graph execution respect it, preserving saved definitions
without offering an action against an unavailable execution connection.

## One surface per card

Studio adapts each card to its content and never shows tabs. Images and videos are the card. Text is chromeless Markdown. Scripts, JSON, values, processes, CLI commands and terminals show their source directly; a compact toolbar identifies the language and provides editing controls, and Apply saves an edit without running it. Image generation, video generation, text generation, Codex and other typed nodes show their fields as controls with the result beneath, and have no source view. Collections, run boards, buttons, command centers and workflows open on their panel; a single **Source** toggle in the header shows the definition and back. Invalid drafts and concurrent external edits cannot silently replace canonical source. Connector updates keep flowing to live collection results while presentation source is edited.

New custom actions use `script` nodes with the complete JavaScript module in `config.source`. Declare typed ports in a leading `/* studio` YAML comment and export a default function returning an output object. The generated vault `SystemSculpt/Studio/AGENTS.md` documents the module protocol, limits, runtime settings, and all built-in typed nodes. Stable graph IDs and ordinary text source let agents create or revise a node through file edits.

Benchmark actions are now **Sync ticket data**, **Plan ticket change**, and **Write ticket change**, each with its own source and result. **Ticket change data** is editable JSON. The automatic connector refresh remains read-only. Custom edits to action source survive subsequent connector refreshes; conflicting generator changes fail closed.


## On-machine Codex

Above the chat composer or in **Settings → SystemSculpt → Chat**, choose **SystemSculpt API** or **On-machine Codex**. The choice applies to new chats and Studio text generation. Saved chats retain their backend. Switching provider from the composer opens a fresh tab and preserves the original chat and its draft. Provider and Codex options are saved across restarts. Narrow panes use a two-column layout; very small panes stack the controls, and touch devices use larger targets. On mobile, new chats and Studio text generation use SystemSculpt API even if the synced preference is Codex; the desktop preference is retained until you explicitly change it. Saved native chats remain readable with an API option to start a new conversation. Codex requires Obsidian Desktop and an installed `codex` CLI. By default it uses your existing login in `~/.codex` (`codex login`); custom providers can connect without an OpenAI login when Codex reports that authentication is not required. See [native Codex discovery](development.md#native-codex-discovery) for machine-local executable and home overrides. Studio does not store or copy Codex credentials. Native execution defaults to gpt-6-astra with high reasoning and Normal speed. When Codex is selected, model, thinking-level and Normal/Fast selectors appear above the chat composer and in plugin settings. Available choices come from the installed Codex; hidden platform-only models are excluded. Fast uses the native priority tier and more of the Codex allowance. Changes apply to the next turn, including resumed chats and Studio text generation. Image generation, document processing and transcription remain managed API features.

A `codex` card is a direct native task, with editable YAML fields `prompt`, `workingDirectory` (relative to the open vault; `.` means the vault root, with explicit absolute paths supported for local external repositories), optional `threadId`, and `input`. Optional `model`, `effort` and `serviceTier` fields override the selected defaults for this card (`default` is Normal and `priority` is Fast). Run starts a new native thread unless `threadId` is set. Connected JSON context is added to the prompt. Result shows the answer and thread ID, and can select that thread for the next run. Stop Codex interrupts the native turn. On-machine execution inherits approval policy, sandbox, permission profiles and approval reviewer from Codex’s own configuration, including the global `config.toml` and applicable native project/managed layers. New threads inherit native settings directly. For resumed threads, the plugin asks Codex to resolve current permissions in an ephemeral thread without executing a model turn, then passes those native values unchanged so saved permissions cannot override current configuration. The chat composer shows a read-only configured-permissions summary instead of the managed API’s Ask Approval/Full Access selector. Change permissions in Codex; the next native turn reloads its configuration. Native command, file-change and question requests appear as plugin dialogs; unsupported native client requests fail closed.

The installed Codex app-server owns tool execution, authentication, reasoning, compaction and durable thread history. The plugin only transports protocol messages and renders results. Closing a running chat, unloading the plugin, or stopping a task interrupts its local connection; completed history remains in Codex and the vault's transcript or Studio run output. Reopening a saved Codex chat on this machine resumes its native thread.

### Independent Codex runs

A Codex card is a reusable role. Each click on Run creates a separate run instance, including when that role already has active instances. The Runs collection observes connected roles without executing them. Double-click a run (or use Open) for public activity, the latest response, native thread identity and message receipts. Stop affects only that instance. Native approval and question requests remain pending until Review request is opened.

Roles can discover project peers with `studio_runs`, send an explicit handoff with `studio_send_message`, and start an existing role with `studio_start_run`. Messages to an active turn use native steering; an explicit message to a finished run resumes one native turn. Delivery means Codex accepted the input, not that the requested work finished. Ordinary independent runs do not restart automatically; owner-started workflows use the explicit child-result handoff described below. Native Codex owns configuration, safety controls, tools and authoritative thread history.

The client allows eight concurrent turns and 100 active or queued instances, limits child depth to eight and children per run to sixteen, and keeps at most 1,000 presentation records in memory. Individual inputs are limited to 64 KB; large context belongs in linked files. Run records live beside the project assets and sync with the vault. Saved runs are readable on mobile; execution and controls require their originating desktop machine. An interrupted independent run leaves an interrupted record, and a new explicit message can resume its native thread. Owner-started workflows recover their interrupted threads automatically when the Studio reopens on the execution machine.

### Buttons and command centers

Add **Button** for one action, or **Command Center** for a panel of actions. They open on Actions. Configure a Button's `label`, `action` (`run` or `focus`), and target node ID in Source. Command Center stores up to 40 actions in `actions.items`, each with an ID, label, kind, target, optional section and description. Run reuses the existing node execution and approval path; focus selects and frames the target. Missing targets and unavailable desktop actions are disabled. Neither node participates in graph execution.

The benchmark canvas separates Command Center, Results & data, and Infrastructure & workflows. Command Center starts independent role instances, refreshes ticket data, links to result collections, and exposes the existing ticket-change actions. Prompts, scripts, request data and reference text belong in Infrastructure. The initial section migration preserves authored content, unrelated groups and drawings; later manual layout changes remain owned by the user.

Command Center exposes Model and Reasoning selectors above its actions. The native Codex catalog supplies available choices; the selection is saved with the project. Associated role launches use that selection and always use Standard service, overriding role or global speed settings. Child runs retain their parent’s model and reasoning snapshot and use Standard. Changing the selectors affects future launches, not active runs. Desktop is required to change or execute these settings; mobile displays the saved selection.

Run details open in a spacious, window-sized modal. Finished runs open on Response, showing the complete retained public response with rendered Markdown tables, links, lists and code blocks. Show source switches to the original text. Conversation and Messages also render Markdown; Activity renders public messages while preserving literal command output. The content scrolls independently above the message composer.

Native agent run records are written independently from the project document. Project saves, external refreshes and reload reconciliation preserve the `agent-runs` directory, including newer records than an older project revision. Codex retains the authoritative thread separately.

A run board opens with the newest 50 records plus every live run: active runs, open workflows and their assignments, and their parents. **Load older runs** reads the next 50 and shows every run loaded so far, up to 1,000 loaded runs. Past that, Studio drops the least recently changed runs that are not live, stops offering older pages and says it shows only the newest runs; **Refresh** starts over. A small `agent-runs/index.json` records each run's status, last-changed day and workflow links, so opening a board does not read every record to find the live ones. If the index is missing or damaged, Studio rebuilds it from every record once before it decides which runs are live. Once per session, in the background, Studio removes records beyond the newest 1,000 per project, or unchanged for 90 days, working through the whole backlog in batches. It never removes a live run or a run that is loaded, and it re-reads each record before removing it, so a run another machine resumed is kept.

### Prompt-driven workflows

At the top of Command Center, describe an objective and select **Start workflow** (or press Command/Ctrl+Enter). The native Codex orchestrator uses the selected model and reasoning with Standard service. It can inspect the saved Studio resource inventory, work directly, or assign existing roles. Examples include finding and testing a benchmark through a local branch, auditing existing integrations, and diagnosing a failed run. The prompt's scope and stopping conditions remain the authority; a local-branch request does not authorize a PR or merge.

The live workflow card shows the objective, stopping conditions, model-authored plan, dependencies, child runs and final outcome. Open a child or the orchestrator for its public activity, Markdown response and native request controls. Follow-ups steer the same orchestrator thread. **Stop workflow** cancels its outstanding children and prevents automatic continuation. Mobile can read saved plans and results; execution remains on the originating desktop machine.

The orchestrator publishes its plan with `studio_workflow_plan`, dispatches stable step IDs with `studio_start_run`, and waits for evidence with `studio_workflow_wait`. The wait resolves on a child result or owner steering without polling. If its native turn ends while children are working, new child evidence resumes the same orchestrator. Codex then chooses the next step. `studio_workflow_finish` explicitly records either verified completion or the precise owner decision needed; native-turn completion alone never marks the objective complete. One orchestrator dispatches at most sixteen child assignments; children return evidence rather than creating their own fanout.

Workflow state is retained with the run in the generation-independent run store. Reload recovery reuses native thread IDs and stable assignment IDs. It reads native history before resuming an interrupted turn, adopts an already-completed native result, and refuses to start a duplicate while native history reports the turn still active. Stopped and completed workflows do not restart. A transport or persistence error remains visible for owner follow-up. If a reload leaves a message’s native acceptance uncertain, Studio preserves the message and pauses the workflow for review instead of replaying it. Check the native thread history, then send a fresh follow-up to continue. Recovery requires the execution machine and the Studio project to be open; closing Obsidian does not provide background execution.

The protocol transport uses the installed Codex app-server and its native permission configuration. See [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
