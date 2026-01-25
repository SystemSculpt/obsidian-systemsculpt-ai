# E2E tests (Obsidian + WDIO)

This repo uses WebdriverIO + the `wdio-obsidian-service` to run end-to-end tests against a real Obsidian instance and a real SystemSculpt chat backend.

## Quick start

### Live chat specs (real endpoint + real license key)

Set the required env vars and run:

```bash
npm run e2e:live
```

Note: `npm run e2e:live` runs the full live suite in parallel (multiple Obsidian instances) for speed.

FYI: Obsidian is a real Electron app during E2E runs, so it may still steal focus. The harness attempts to move/blur the window after reload, but macOS may still focus it during WebDriver interactions.

Required:
- `SYSTEMSCULPT_E2E_LICENSE_KEY`

Optional:
- `SYSTEMSCULPT_E2E_SERVER_URL` (defaults to the plugin’s configured server URL)
- `SYSTEMSCULPT_E2E_MODEL_ID` (defaults to `systemsculpt@@systemsculpt/ai-agent` in the specs)
- `SYSTEMSCULPT_E2E_SETTINGS_JSON` (override the settings file used to seed live settings)

### Mobile emulation specs

```bash
npm run e2e:emu
```

## Live env sourcing (standard, do not print secrets)

All E2E runs should use real production values from your Obsidian vault settings file:

`<vault>/.obsidian/plugins/systemsculpt-ai/data.json`

This file contains secrets (license keys / provider keys). Do not `cat`/print it.

The live runner also seeds the temp vault’s settings from this file (sanitized to avoid vault-specific paths),
so custom provider configs and model lists match your real environment.

Standard runner (macOS/Linux):

```bash
testing/e2e/run.sh live
```

Set the vault path:

```bash
SYSTEMSCULPT_E2E_VAULT="/absolute/path/to/your/vault" testing/e2e/run.sh live
```

Or point directly at the settings file:

```bash
SYSTEMSCULPT_E2E_SETTINGS_JSON="/absolute/path/to/your/vault/.obsidian/plugins/systemsculpt-ai/data.json" testing/e2e/run.sh live
```

Mobile emulation runs also require live env values (same loader):

```bash
testing/e2e/run.sh emu
```

## Parallel live runs

Live specs run in parallel (multiple Obsidian instances). This speeds up total runtime but can increase CPU/RAM use and API load.
Control parallelism with `SYSTEMSCULPT_E2E_INSTANCES` (default: 3).

The runner exports these env vars from the vault settings:
- `SYSTEMSCULPT_E2E_LICENSE_KEY` (required)
- `SYSTEMSCULPT_E2E_SERVER_URL` (optional)
- `SYSTEMSCULPT_E2E_MODEL_ID` (optional)

## Where things live

- Live specs: `testing/e2e/specs-live/*.live.e2e.ts`
- Mobile emulation specs: `testing/e2e/specs/*.e2e.ts`
- WDIO configs: `testing/e2e/wdio.live.conf.mjs`, `testing/e2e/wdio.emu.conf.mjs`
- Fixture vault: `testing/e2e/fixtures/vault`
- Per-worker temp vaults: `testing/e2e/fixtures/.tmp-vaults` (auto-created; safe to delete)
- Logs/screenshots: `testing/e2e/logs`

## Adding new ChatView live specs

Recommended pattern:
- Use `ensureE2EVault()` + `configurePluginForLiveChat()` in `before()`
- Use `openFreshChatView()` to guarantee a clean chat state for each test
- Interact with the real UI (`textarea.systemsculpt-chat-input`, `button.mod-send`, `button.mod-stop`)
- Use helpers from `testing/e2e/utils/systemsculptChat.ts`:
  - `waitForChatComposer()`, `sendChatPrompt()`
  - `waitForToolApprovalUi()`, `driveToolApprovals()`
  - `getActiveChatViewState()` + `summarizeChatViewState()` for failure diagnostics

Existing ChatView live specs:
- Core chat flows (tools + context + export + web search): `testing/e2e/specs-live/chat.core.live.e2e.ts`

Keep prompts deterministic:
- Use per-test random tokens (`crypto.randomUUID()`) and assert they round-trip through tool calls and final assistant output.
- Avoid relying on “natural” language completion; require exact sentinel strings for pass/fail.

## Embeddings live specs

Live embeddings specs exercise the real embeddings pipeline (provider → batching → storage → search) inside a real Obsidian instance.

- SystemSculpt embeddings core: `testing/e2e/specs-live/embeddings.systemsculpt.core.live.e2e.ts`
  - Requires `SYSTEMSCULPT_E2E_LICENSE_KEY` (and optional `SYSTEMSCULPT_E2E_SERVER_URL`)
- Custom embeddings core (LM Studio preferred, Ollama fallback): `testing/e2e/specs-live/embeddings.custom.core.live.e2e.ts`
  - Requires LM Studio (`http://localhost:1234`) or Ollama (`http://localhost:11434`)
  - Requires `nomic-embed-text` installed (`ollama pull nomic-embed-text`)
- Provider switch (SystemSculpt ↔ custom Ollama): `testing/e2e/specs-live/embeddings.provider-switch.live.e2e.ts`
  - Requires `SYSTEMSCULPT_E2E_LICENSE_KEY` (and optional `SYSTEMSCULPT_E2E_SERVER_URL`)
  - Requires Ollama running on `http://localhost:11434` (`ollama serve`)
  - Requires `nomic-embed-text` installed (`ollama pull nomic-embed-text`)
