# Getting started

SystemSculpt AI runs inside Obsidian and connects directly to SystemSculpt. Chat works through your SystemSculpt account automatically, with nothing extra to pick inside the plugin.

## Install

### Community Plugins (recommended)

1. Open `Settings -> Community plugins`.
2. Search for `SystemSculpt AI`.
3. Click `Install`, then `Enable`.

### Manual install

```bash
cd /path/to/vault/.obsidian/plugins/
git clone https://github.com/systemsculpt/obsidian-systemsculpt-ai systemsculpt-ai
cd systemsculpt-ai
npm install
npm run build
```

## First-run setup

1. Open `Settings -> SystemSculpt AI -> Account`.
2. Enter and activate your SystemSculpt license key.
3. Review credits and account status.
4. Open docs or support links if you need help.

## Start chatting

- Command palette: `Open SystemSculpt Chat`
- Ribbon icon: `Open SystemSculpt Chat`

## Add context

- Drag files into chat.
- Attach files with the paperclip in chat.
- Type `@` to mention files.
- Use `Chat with File` from the command palette.

## Tool use

- SystemSculpt can use built-in tools automatically when the current flow needs them.
- You only need to set up your SystemSculpt account in the plugin.

## Enable Similar Notes (optional)

1. Open `Settings -> SystemSculpt AI -> Knowledge`.
2. Enable embeddings.
3. Review indexing scope and exclusions for your vault.
4. Open `Open Similar Notes Panel`.

## Next docs

- [Settings](settings.md)
- [Commands](commands.md)
- [Troubleshooting](troubleshooting.md)
