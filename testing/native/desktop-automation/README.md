# Desktop Automation

`testing/native/desktop-automation/` is the canonical desktop integration lane for `obsidian-systemsculpt-ai`.

It does **not** drive the Obsidian renderer through CDP or Playwright.

Instead, the live plugin exposes a token-protected localhost bridge from inside the already-running Obsidian desktop process. The external runner attaches to that bridge and drives the chat view plus selected plugin services without taking application focus. If you explicitly request a plugin reload, it reloads the live plugin in place without launching or foregrounding Obsidian.

This runner will never launch Obsidian, create a hidden host, or steal focus.

For fresh-install Windows desktop proof, pair this runner with
`testing/native/device/windows/README.md`: Windows owns the clean-install and no-local-Pi baseline,
then this bridge runner owns the no-focus churn after the vault is already open.

## Main commands

```bash
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:provider-connected
npm run test:native:desktop:chatview-stress
npm run test:native:desktop:stress
npm run test:native:desktop:soak
SYSTEMSCULPT_DESKTOP_PROVIDER_ID=openai SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY=... npm run test:native:desktop:provider-connected
node testing/native/desktop-automation/run.mjs --case extended --no-reload
SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS='{"openai":"...","anthropic":"..."}' node testing/native/desktop-automation/run.mjs --case provider-connected-baseline --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case chatview-stress --repeat 5 --pause-ms 750 --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case stress --repeat 5 --pause-ms 1500 --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case soak --repeat 25 --pause-ms 1500 --no-reload
node scripts/reload-local-obsidian-plugin.mjs
./run.sh --headless
```

Use `./run.sh --headless` to keep the bundle synced in the background.
`run.sh` now self-deduplicates, so repeated launches reuse the existing watcher instead of stacking multiple sync and reload loops.
Use `node scripts/reload-local-obsidian-plugin.mjs` only when you intentionally want the live plugin to reload in place after a code change.
Use `--no-reload` for routine attach-only validation when the bridge is already up.
When no vault selector is supplied, the runner now prefers the latest live bridge target and falls back to the first synced desktop target only when no live bridge can be matched.

## What the desktop runner covers

- bridge bootstrap and discovery
- no-focus plugin reload
- chat model switching against real authenticated models
- provider auth round-trips driven through Settings -> Providers without taking focus
- direct chat send through the real chat view
- vault text read/write through the bridge
- direct web fetch through the live plugin service
- optional YouTube transcript retrieval
- transient upstream model rate limits falling through to the next authenticated candidate instead of being misclassified as bridge failure

Current case profiles:

- default / `all`
  - `model-switch`
  - `chat-exact`
  - `file-read`
  - `file-write`
  - `web-fetch`
- `extended`
  - everything above plus `youtube-transcript`
- `stress` / `reload-stress`
  - attach to the already-open vault without an implicit bootstrap reload
  - explicitly reload the live plugin in place on every iteration
  - wait for a new stable bridge generation after each reload
  - assert `pluginStatusBarItemCount === 1`
  - assert `embeddingsStatusBarItemCount === 1`
  - run model switching and a real chat send after each reload to prove the chat view is still healthy
- `provider-connected-baseline`
  - open Settings -> Providers through the bridge and verify the Providers panel is rendered
  - clear any stored auth for the selected provider first
  - write an API key into the live plugin's provider storage through the bridge
  - wait for the provider row and model catalog to refresh into an authenticated Pi-backed state
  - send a real chat turn with that provider model
  - clear the provider auth again
  - prove the same provider path now fails with actionable Providers guidance
  - recover back to the managed SystemSculpt model
- `chatview-stress`
  - reset the automation chat and prove a fresh empty composer comes up on the same automation leaf
  - toggle web search and approval mode directly through the live chat view
  - send repeated real chat turns while switching between authenticated models
  - verify the chat can be resumed, reset, and reused without replacing the automation leaf
  - verify one-shot automation approval overrides do not permanently mutate the chat's configured approval mode
- `soak`
  - run `reload-stress` and `chatview-stress` back to back for each iteration
  - intended for unattended longer runs before release or after reload-hardening changes

## Provider-connected auth contract

The provider-connected lane reads API keys from the environment of the machine running the external runner.
Those env vars are **runner-side only**: the bridge writes the key into the live plugin's auth storage, so the
target Obsidian host does not need that provider key in its own process environment.

Supported inputs:

- `SYSTEMSCULPT_DESKTOP_PROVIDER_ID` + `SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY`
  - pin one specific provider and one API key
- `SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS`
  - JSON object keyed by provider id, for example `{"openai":"...","anthropic":"..."}`
- provider-specific env vars exposed by the Providers snapshot, such as `OPENAI_API_KEY`
  - the runner uses the bridge metadata to discover which env var name belongs to each provider

If no explicit provider is pinned, the runner selects the first non-local provider row that supports API-key auth and has a matching key available from the inputs above.

## Bootstrap behavior

When the target desktop vault does not have a `data.json` yet, the bootstrap helper will:

1. Resolve the plugin target from `systemsculpt-sync.config.json`
2. Create or patch `data.json`
3. Force `desktopAutomationBridgeEnabled: true`
4. Regenerate `vaultInstanceId` when seeding a new vault
5. Reuse another synced target's settings as a seed when available

After that the bootstrap helper does one of three things:

- waits for the currently published bridge generation to stay stable when a live bridge is already present and you passed `--no-reload`
- touches or patches `data.json` so the running plugin's external-settings sync path republishes the bridge without touching the renderer
- reloads the live plugin through the bridge when you explicitly requested reload semantics, then waits for the new bridge generation to stay stable before any chat/model requests run

When the running desktop plugin already includes the external settings sync path, patching or touching `data.json`
is enough to start or heal the bridge without focusing Obsidian or touching the renderer. That sync path now uses
`fs.watch` first and falls back to a lightweight mtime poll so missed watcher events do not strand attach-only recovery.

The discovery file is now treated as owned state. A stale unload should not delete a newer bridge record, and an unchanged `data.json` touch should cause the running plugin to reassert discovery if that file disappears.
The external desktop client also refreshes itself when discovery rolls to a newer live bridge record, so attach-only runs can survive bridge restarts without taking focus.
Attach-only bootstrap now waits for a stable bridge generation before starting cases, which avoids binding to a bridge that is already mid-reload because of a background sync or hot-reload cycle.
When bootstrap has to heal a missing or wedged bridge through `data.json`, it now reasserts settings on a backoff instead of rewriting the file every poll cycle, so recovery does not create a restart storm.
If multiple synced desktop vaults exist and you want to pin one explicitly, pass `--vault-name <vault-name>` or `--vault-path <absolute-path>`.

If the currently open vault is still on an older runtime that predates this external settings sync path, do one manual
plugin reload once. After that, future desktop automation bootstraps stay no-focus.

## Important boundary

This runner assumes the target vault is already open in Obsidian desktop.
If no live bridge appears after patching `data.json`, the command fails and tells you to do one manual plugin reload inside the already-open vault. It will not launch Obsidian for you.

Once the bridge is live, the external runner is cross-platform. The no-focus bootstrap path is now
also cross-platform as long as the open vault is already on a watcher-enabled plugin runtime.

## What `test:native:desktop:stress` now proves

The stress command is no longer just the normal suite repeated.

It now performs repeated no-focus reload churn against the already-open desktop vault:

1. Attach to the existing live bridge without an extra bootstrap reload
2. Request an in-place plugin reload through the bridge
3. Wait for a new stable bridge generation
4. Verify the status bar still has exactly one plugin item and one embeddings item
5. Switch models and send a real chat turn
6. Re-check the same health assertions after chat activity

That specifically targets the earlier failure mode where reloads could leave stale listeners,
duplicate status bar items, or a bridge that looked published but was not actually healthy.

## What `test:native:desktop:chatview-stress` now proves

The chatview stress lane is intentionally about state churn instead of reload churn:

1. Reset to a fresh automation chat on the existing automation leaf
2. Toggle web search and approval mode through the real chat controls
3. Send a real turn, resume the same chat, and confirm state stayed attached to the same leaf
4. Switch to a second authenticated model and send another real turn in the same chat
5. Reset the chat again and prove the same leaf can host a fresh chat immediately afterward

That directly covers the release-critical behavior the Pi integration changed: model switching, repeated sends,
new-vs-resumed chat handling, and input state churn in the actual live chat view without taking focus.

## Soak guidance

Use `test:native:desktop:stress` as the fast regression gate.
Use `test:native:desktop:soak` when you want a longer unattended no-focus run before release.
