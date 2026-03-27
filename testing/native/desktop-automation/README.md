# Desktop Automation

`testing/native/desktop-automation/` is the canonical desktop integration lane for `obsidian-systemsculpt-ai`.

It does **not** drive the Obsidian renderer through CDP or Playwright.

Instead, the live plugin exposes a token-protected localhost bridge from inside the already-running Obsidian desktop process. The external runner attaches to that bridge and drives the chat view plus selected plugin services without taking application focus. If you explicitly request a plugin reload, it reloads the live plugin in place without launching or foregrounding Obsidian.

This runner will never launch Obsidian, create a hidden host, or steal focus.

## Main commands

```bash
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:stress
node testing/native/desktop-automation/run.mjs --vault-name private-vault --case extended --no-reload
node scripts/reload-local-obsidian-plugin.mjs
./run.sh --headless
```

Use `./run.sh --headless` to keep the bundle synced in the background.
Use `node scripts/reload-local-obsidian-plugin.mjs` only when you intentionally want the live plugin to reload in place after a code change.
Use `--no-reload` for routine attach-only validation when the bridge is already up.

## What the desktop runner covers

- bridge bootstrap and discovery
- no-focus plugin reload
- chat model switching against real authenticated models
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

## Bootstrap behavior

When the target desktop vault does not have a `data.json` yet, the bootstrap helper will:

1. Resolve the plugin target from `systemsculpt-sync.config.json`
2. Create or patch `data.json`
3. Force `desktopAutomationBridgeEnabled: true`
4. Regenerate `vaultInstanceId` when seeding a new vault
5. Reuse another synced target's settings as a seed when available

After that the bootstrap helper does one of three things:

- attaches immediately when a live bridge is already present and you passed `--no-reload`
- touches or patches `data.json` so the running plugin watcher republishes the bridge without touching the renderer
- reloads the live plugin through the bridge when you explicitly requested reload semantics

When the running desktop plugin already includes the external settings watcher, patching or touching `data.json`
is enough to start or heal the bridge without focusing Obsidian or touching the renderer.

The discovery file is now treated as owned state. A stale unload should not delete a newer bridge record, and an unchanged `data.json` touch should cause the running plugin to reassert discovery if that file disappears.

If the currently open vault is still on an older runtime that predates the watcher, do one manual
plugin reload once. After that, future desktop automation bootstraps stay no-focus.

## Important boundary

This runner assumes the target vault is already open in Obsidian desktop.
If no live bridge appears after patching `data.json`, the command fails and tells you to do one manual plugin reload inside the already-open vault. It will not launch Obsidian for you.

Once the bridge is live, the external runner is cross-platform. The no-focus bootstrap path is now
also cross-platform as long as the open vault is already on a watcher-enabled plugin runtime.
