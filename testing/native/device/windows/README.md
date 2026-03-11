# Windows Desktop Native Testing

Windows uses the same native smoke harness as macOS desktop, with Windows-specific host setup and audio fixture requirements.

## Main commands

```powershell
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:stress
```

## Host requirements

- Obsidian desktop
- Node.js `20+`
- `ffmpeg`
- either `espeak-ng` or a prerecorded short speech fixture for transcription specs

## Launch Obsidian for native smoke

```powershell
& "$env:LOCALAPPDATA\Obsidian\Obsidian.exe" --remote-debugging-port=9222
```

## Use this lane for

- real desktop parity against macOS
- regression checks for hosted chat/tool/embeddings/transcription/web flows
- final confidence before calling cross-platform desktop behavior green
