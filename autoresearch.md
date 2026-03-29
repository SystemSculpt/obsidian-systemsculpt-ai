## Objective

Make the Windows `Settings -> Providers` lane stable on the clean-install desktop path.

The current broken behavior is specific to the bridge route behind the Providers tab:

- `POST /v1/settings/open` succeeds for `targetTab=providers`
- `POST /v1/settings/providers/snapshot` crashes inside the live Windows plugin

## Primary metric

`providers_snapshot_ok`

- `1` when the Windows live plugin returns a successful providers snapshot after a fresh Obsidian relaunch
- `0` otherwise

Secondary metrics:

- `focused_tests_ok`
- `build_ok`
- `sync_ok`
- `settings_open_ok`

## Current segment

- `segmentId`: `windows-providers-snapshot-v1`
- `runTag`: `windows-providers-snapshot`
- working tree: `main` with existing unrelated local changes

## Benchmark workload

Run `./autoresearch.sh`.

It must:

1. run the focused local Jest coverage for the provider/auth/bootstrap surface
2. build the production plugin bundle
3. sync the built plugin artifacts into configured plugin targets and Windows mirrors
4. quit and reopen Obsidian on the Windows VM against the canonical QA vault
5. probe the live Windows bridge for:
   - `settings/open`
   - `providers/snapshot`

## Editable surface

- `src/services/pi/PiSdkAuthStorage.ts`
- `src/services/pi/PiSdkRuntime.ts`
- `src/services/pi/PiTextModels.ts`
- `src/studio/piAuth/StudioPiAuthStorage.ts`
- `src/settings/providerStatus.ts`
- `src/settings/ProvidersTabContent.ts`
- `src/testing/automation/DesktopAutomationBridge.ts`
- focused tests that cover the above

## Locked harness

- `autoresearch.sh`
- `autoresearch.checks.sh`
- Windows relaunch/probe flow inside the benchmark script
- existing repo sync config and Windows QA vault target

## Correctness gates

- focused Jest suite passes
- production build succeeds
- Windows bridge returns `settings_open_ok=1`
- Windows bridge returns `providers_snapshot_ok=1`

## Keep / discard policy

Keep a change only if it preserves the local correctness gates and improves the primary metric to `1`.

If a change still leaves `providers_snapshot_ok=0`, either discard it or keep only if it clearly improves failure visibility and is required for the next iteration.

## Logs

- ledger: `autoresearch.jsonl`
- benchmark/check logs: `autoresearch-logs/`
- deferred ideas: `autoresearch.ideas.md`
