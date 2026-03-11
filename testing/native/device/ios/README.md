# iOS And iPad Native Testing

The iOS lane uses a real device plus WebKit inspection rather than a fake standalone test app.
There is not a better truthful simulator path for real Obsidian plugin QA than this
physical-device lane; the right improvement is more automation around the real device,
not pretending the simulator covers native vault/plugin behavior.

Canonical tools live here:

- `testing/native/device/ios/open-debug-tools.mjs`
- `testing/native/device/ios/inspect-plugin-state.mjs`
- `testing/native/device/ios/start-appium.mjs`

## Main commands

```bash
npm run test:native:ios:debug:open -- --sync --open-xcode
npm run test:native:ios:inspect:plugin -- --strict
npm run test:native:ios:inspect:toggle
npm run test:native:ios
```

## Canonical workflow

1. Sync the plugin into the iCloud-backed or synced test vault.
2. Relaunch Obsidian on the connected device.
3. Confirm the plugin is enabled and failure-free.
4. Run the shared native smoke harness once the Obsidian target is inspectable.

What the shared smoke now does for you:

- auto-starts the WebKit adapter when `npm run test:native:ios` runs
- reloads `systemsculpt-ai` before smoke so the live instance matches the synced files
- seeds the canonical runtime fixtures directly into the device vault before the cases run
- verifies the same hosted chat, Pi tool loop, embeddings, transcription, web fetch, and YouTube transcript cases as desktop and Android

## Important inspection rule

For the mobile Community Plugins toggle, trust the rendered container state such as:

```text
.checkbox-container.is-enabled
```

not the raw checkbox input value.
