# Windows Desktop Native Testing

Windows uses the same desktop bridge runner as macOS desktop, but it now carries a different job:
it is the canonical clean-install desktop lane.

Use a real Windows host or VM when you need proof for behavior that the already-open macOS dev vault
does not prove by itself.

## Use this lane for

- brand-new Obsidian and plugin install behavior
- plugin enable/load failures that reproduce only on Windows
- verifying hosted SystemSculpt chat still works when the user does not have local Pi installed
- release-candidate desktop confidence after the macOS no-focus iteration loop is already green

## Fresh-install / no-local-Pi contract

Before calling a Windows pass green, verify all of the following on the Windows machine:

1. Local Pi is not installed and is not added as a prerequisite just to make the plugin work.
2. Obsidian desktop opens the target vault and the trust-author prompt is handled once if shown.
3. The plugin can be installed or synced and then enabled successfully on that fresh desktop host.
4. Setup still renders the account, license, and help surfaces without requiring local Pi setup.
5. Chat view opens, the managed SystemSculpt path is available, model switching works, and a real hosted turn succeeds.
6. Any local-Pi-only path fails cleanly with actionable setup or Providers guidance instead of crashing or silently forcing the wrong model.

Only after that baseline is green should you add an optional Windows lane with local Pi installed.
Local Pi is not part of the baseline desktop acceptance contract.
The external clean-install runner now enforces that by failing early if the Windows host exposes a
`pi` command or `~/.pi/models.json`.

For provider-connected parity, do not key the test off a hard-coded chat inventory section label.
Depending on the runtime packaging, authenticated Pi-provider models can surface under either the
`Pi Providers` or `Local Models` section while still being valid provider-authenticated options.
The Windows parity harness should match those models by provider id and auth state, not by a
single section string.

## Main commands

```powershell
npm run test:native:windows:prepare
npm run test:native:windows:setup
npm run test:native:windows:baseline
$env:SYSTEMSCULPT_DESKTOP_PROVIDER_ID="openai"; $env:SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY="..."; npm run test:native:windows:provider-connected
npm run test:native:windows:chatview-stress
npm run test:native:windows:stress
npm run test:native:windows:soak
```

## Host requirements

- Obsidian desktop
- Node.js `20+`
- a synced plugin target in `systemsculpt-sync.config.json`
- a vault that is already open in Obsidian for the no-focus bridge phase

For the provider-connected lane, set the provider env vars on the machine that runs the external runner.
That is usually the Mac if you are attaching from the Mac into the Windows VM through the bridge workflow.
The bridge writes the API key into the Windows plugin's auth storage, so the Windows Obsidian process itself does not need those env vars.

If you are driving the Windows VM from the Mac during active development, keep the Windows plugin path under a Mac-side `mirrorTargets` entry with `"type": "windows-ssh"` in the ignored local `systemsculpt-sync.config.json`.
That keeps the VM on the newest bundle through the normal dev watcher without polluting the Mac desktop runner's local `pluginTargets` list.

## Bootstrap rule

The canonical desktop path is bridge-based and no-focus after the vault is already open and trusted.

Once the desktop automation bridge has been enabled in the target vault, the same `npm run test:native:desktop*`
commands work on Windows without any renderer automation.

If the bridge is not live yet, the runner now bootstraps it by patching the plugin `data.json` and
letting the live plugin react through external settings sync. If the currently open vault is still
on an older runtime that predates that watcher, do one manual plugin reload once; after that, the
desktop automation bootstrap stays no-focus on Windows too.

If discovery disappears while the vault stays open, touching the same `data.json` again should
republish the bridge without foregrounding Obsidian.

## Flow

1. Do the clean-install / no-local-Pi proof on the Windows host.
2. Leave the vault open.
3. Run `npm run test:native:windows:baseline` to prove the managed hosted path still works.
4. Run `npm run test:native:windows:provider-connected` when you need Pi-provider parity on a fresh Windows install.
5. Run the no-focus stress lanes for chatview churn and repeated reloads.

That split keeps Windows responsible for fresh-user truth while still reusing the same bridge
automation layer as macOS once the runtime is open.

## Interpreting transient hosted failures

The managed baseline now distinguishes plugin regressions from upstream throttling:

- If no managed hosted turn succeeds, the case still fails.
- If the first hosted turn succeeds and a later managed recovery turn is rate-limited upstream, the case stays green and records that event under `transientFailures`.
- Treat `transientFailures` as hosted-provider noise to investigate separately from bridge/bootstrap/model-selection bugs.
