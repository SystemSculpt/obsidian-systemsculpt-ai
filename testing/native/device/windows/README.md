# Windows Desktop Native Testing

Windows uses the same desktop bridge runner as macOS desktop.

## Main commands

```powershell
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:stress
```

## Host requirements

- Obsidian desktop
- Node.js `20+`
- a synced plugin target in `systemsculpt-sync.config.json`

## Bootstrap rule

The canonical desktop path is bridge-based and no-focus.

Once the desktop automation bridge has been enabled in the target vault, the same `npm run test:native:desktop*` commands work on Windows without any renderer automation.

If the bridge is not live yet, the runner now bootstraps it by patching the plugin `data.json` and
letting the live plugin react through external settings sync. If the currently open vault is still
on an older runtime that predates that watcher, do one manual plugin reload once; after that, the
desktop automation bootstrap stays no-focus on Windows too.

If discovery disappears while the vault stays open, touching the same `data.json` again should
republish the bridge without foregrounding Obsidian.

## Use this lane for

- real desktop parity against macOS
- regression checks for chatview model switching plus bridge-owned desktop flows
- final confidence before calling cross-platform desktop behavior green
