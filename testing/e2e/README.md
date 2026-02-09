# E2E tests (Obsidian + WDIO)

This repo uses WebdriverIO + the `wdio-obsidian-service` to run end-to-end tests against a real Obsidian instance.

It supports two backend modes:
- **Mock backend** (fast, deterministic, CI-friendly)
- **Live backend** (real license + real endpoint; best for “does it work in prod?” validation)

## Quick start

Typecheck the E2E harness/specs (fast sanity gate):

```bash
npm run check:e2e
```

### Mock chat specs (deterministic, no secrets)

Runs the E2E suite against a local mock SystemSculpt API server (started automatically).

```bash
npm run e2e:mock
```

Optional:
- `SYSTEMSCULPT_E2E_MOCK_PORT` (default: `43111`)
- `SYSTEMSCULPT_E2E_APP_VERSION` (default: `1.11.7`)
- `SYSTEMSCULPT_E2E_SPEC` (run a single spec file, useful for CI sharding and local debugging)
- `SYSTEMSCULPT_E2E_MOCK_DEBUG` (`1` enables mock server request logging)

Example (single spec):

```bash
SYSTEMSCULPT_E2E_SPEC="testing/e2e/specs-mock/chat.core.mock.e2e.ts" npm run e2e:mock
```

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
 - `SYSTEMSCULPT_E2E_APP_VERSION` (default: `1.11.7`)
 - `SYSTEMSCULPT_E2E_FOCUS_GUARD` (`1` enables the macOS focus guard; default: enabled on macOS, disabled elsewhere)
 - `SYSTEMSCULPT_E2E_SKIP_BUILD` (`1` skips `npm run build` inside the runner)

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

When neither `SYSTEMSCULPT_E2E_SETTINGS_JSON` nor `SYSTEMSCULPT_E2E_VAULT` is set,
the runner auto-falls back to:

`~/gits/private-vault/.obsidian/plugins/systemsculpt-ai/data.json`

Disable this fallback explicitly (for CI/isolation) with:

```bash
SYSTEMSCULPT_E2E_DISABLE_PRIVATE_VAULT_FALLBACK=1 testing/e2e/run.sh live
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
- Mock specs: `testing/e2e/specs-mock/*.mock.e2e.ts`
- Mobile emulation specs: `testing/e2e/specs/*.e2e.ts`
- WDIO configs: `testing/e2e/wdio.live.conf.mjs`, `testing/e2e/wdio.emu.conf.mjs`, `testing/e2e/wdio.mock.conf.mjs`
- Fixture vault: `testing/e2e/fixtures/vault`
- Per-worker temp vaults: `testing/e2e/fixtures/.tmp-vaults` (auto-created; safe to delete)
- Logs/screenshots: `testing/e2e/logs`
- Mock server: `testing/e2e/mock-server.mjs`

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
