---
name: e2e-driving
description: Drive the real Obsidian GUI from the CLI for SystemSculpt plugin testing — click, type, submit, attach files, change settings, run scripted scenarios, and read live UI state deterministically via data-testid targets. Use whenever testing plugin UI behavior, verifying a UI change in the live app, reproducing a user journey, debugging ChatView/settings/Studio interactions, or authoring E2E scenarios. Replaces Computer Use for this plugin.
---

# E2E driving: CLI control of the live Obsidian GUI

Every action is a synthesized user event (pointer, keyboard, input,
file-picker change) on the real DOM — never a service shortcut — so a scripted
run exercises exactly what a human's clicks would. Round trips are 1–10ms.
Full docs: "CLI E2E driving" in docs/development.md.

## Preconditions

- Obsidian must be running a development/staging build. Release builds exclude
  the driver (`__SS_TEST_DRIVER__` define; artifact-gated both directions).
- The dev watcher builds, syncs, and hot-reloads automatically on source
  changes; the driver reconnects within ~1s. Verify the loop is alive with
  `npm run e2e -- status` (shows vault, version, build stamp).
- If the driver never connects: the loaded bundle predates the driver, or the
  watcher process predates a build-config change — `npm run dev:watch:install`
  restarts it from the canonical checkout, then check
  `~/Library/Logs/SystemSculpt/obsidian-plugin-dev.log` for the sync+reload.
- A plugin reload (every watcher sync) resets in-flight UI state — sequence
  scenarios after the reload settles, and never mid-edit of driver source.

## Targets

Canonical addressing is `data-testid`: dot-namespaced, product-shaped ids
stamped by the UI factories (`chat.composer.send`, `chat.turn.edit-resubmit`,
`settings.tab.chat`, `studio.node.run`).

- `npm run e2e -- targets` — full generated catalog (174+ ids).
- `npm run e2e -- targets --live` — what is in the DOM right now, with
  per-element visibility. Zero results usually means the surface isn't open.
- Escape hatches: `css:<selector>`, `chat:<selector>` (chat view scope),
  `label:<aria-label>`, `setting:<row name>` (any Obsidian settings row by its
  visible name — resolves to the row's toggle/dropdown/input), and
  `settings.tab:<label>`.

## Verbs

```bash
npm run e2e -- status
npm run e2e -- open-chat
npm run e2e -- click chat.header.new
npm run e2e -- type "Draft text" [--append] [--submit] [--target <t>]
npm run e2e -- press Enter [--shift|--ctrl|--alt|--meta]
npm run e2e -- attach ./diagram.png [--via picker|drop]
npm run e2e -- select chat.composer.approval-mode full-access
npm run e2e -- select "setting:Default chat font size" large
npm run e2e -- scroll top|bottom|<deltaY>
npm run e2e -- read <target>          # element summary incl. value/disabled
npm run e2e -- query "css:.systemsculpt-agent-turn" [--limit N]
npm run e2e -- snapshot chat|settings # structured GUI state
npm run e2e -- wait <target> exists|gone|visible|hidden|enabled|disabled|textContains [--text T] [--timeout MS]
npm run e2e -- wait-run [--timeout MS] [--stall MS]   # wait for a chat run to finish
npm run e2e -- command <obsidian-command-id>
npm run e2e -- settings [--tab Chat] / settings-close
npm run e2e -- script <file.mjs|json> [--evidence out.json]
```

Multi-vault: `--vault <name>` or `--plugin-dir <path>` (default comes from
systemsculpt-sync.config.json).

## Waiting on an agent run

Use `wait-run` (`waitForRun`), never a bare `wait` on the stop button:

- It waits for the run to **start** first. Submitting is asynchronous, so a
  plain check right after submit sees an idle composer and reports success for
  a turn that never ran.
- It **approves automatically**, clicking `chat.approval.allow-for-chat` the
  way a user would. Do not rely on setting `chat.composer.approval-mode` — a
  run parked on approval is indistinguishable from a stalled one, so a driven
  run would hang by design. Pass `approve: false` to test the approval UI
  itself.
- It distinguishes **stalled** from **slow**: no chat activity for `stallMs`
  fails with a stall message naming the idle time, instead of a generic
  timeout. That difference is the whole point — a wedged run and a slow model
  used to look identical.

## Gotchas that have cost real time

- `gone` means *absent from the DOM*. `chat.composer.stop` and
  `.systemsculpt-agent-banner` are always present and toggled by visibility —
  assert `hidden`, not `gone`.
- The stop button is **not** a completion signal on its own; it can flip in
  ~100 ms while the run never started. Assert transcript content too.
- Approval mode is **per chat and resets on New chat**. Set it after the new
  chat exists, and only while no run is live — the composer refuses the change
  mid-run.
- A driver change needs `npm run build:local-agent && npm run sync:local:agent`
  (plain `sync:local` refuses a loopback API base by design).
- On failure the report now carries a `diagnostics` block (recent warn/error
  logs, notices, chat snapshot) captured at the moment of failure — read that
  before re-running anything.

## Scenarios

Canonical journeys live in `testing/e2e/scenarios/` — a module default-exports
an array of `{ label, action, params }` steps; one CLI invocation plays the
whole journey and reports per-step results. Rules for new scenarios:

- Wait on conditions (`waitFor`), never on time. `hidden` vs `gone` matters:
  toggling controls (the stop button) exist permanently and change visibility.
- Restore what you change (settings values, toggles) so runs leave no trace.
- Typing/attaching without submitting is free; `--submit`/Enter fires a REAL
  request to the compiled API base. Cancel an in-flight run by clicking
  `chat.composer.stop`.
- Embed tiny fixtures (base64 PNG) rather than referencing files.

## Adding or changing UI actions

`UiActionOptions.testId` is required — the compiler forces every new action to
declare an identity. Grammar: lowercase dot-namespaced
(`surface.area.action`); dynamic segments template to `*` in the catalog.
After adding ids run `node scripts/e2e/generate-testid-catalog.mjs` (the fast
gate fails on a stale catalog). Raw `createEl("button"|"input"|...)` sites
must declare `data-testid` in attrs; the shrink-only ratchet in
`scripts/check/testid-coverage-policy.test.mjs` rejects new untagged sites —
tag the element instead of raising the baseline, and lower the baseline when
you tag existing ones.
