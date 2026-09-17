# Getting started

SystemSculpt AI runs inside Obsidian and connects directly to SystemSculpt. Hosted chat uses your SystemSculpt account. On desktop, you can instead select your installed, signed-in Codex for chat and Studio text generation.

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
2. Use `Sign in` (or `Sign up`) to connect your SystemSculpt account in the browser, or enter and activate a license key manually.
3. Review credits and account status.
4. Open docs or support links if you need help.

## Start chatting

- Command palette: `Open SystemSculpt Chat`
- Ribbon icon: `Open SystemSculpt Chat`

## On-machine Codex (desktop)

Select **On-machine Codex** above the chat composer or in **Settings → SystemSculpt AI → Chat**. It requires an installed, signed-in Codex CLI and uses Codex’s own permissions and durable history. Model, reasoning, and speed controls apply to the next native turn. Switching execution backend opens a new chat and preserves the existing conversation and draft. Hosted media and Similar Notes still use SystemSculpt.

See [Studio workspaces and native execution](../studio-workspaces.md) for setup and recovery behavior.

## Add context

- Drag files into chat.
- Attach files with the paperclip in chat.
- Use the files control to add vault notes or supported vault images as context.
- Type `@` to mention files.
- Use `Chat with File` from the command palette.

## Tool use

- SystemSculpt can use built-in tools automatically when the current flow needs them.
- Hosted chat uses your SystemSculpt account. Native Codex chat uses your existing Codex login and native approval controls.

## Enable Similar Notes (optional)

1. Open `Settings -> SystemSculpt AI -> Knowledge`.
2. Enable embeddings.
3. Review indexing scope and exclusions for your vault.
4. Open `Open Similar Notes Panel`.

## Next docs

- [Settings](settings.md)
- [Commands](commands.md)
- [Troubleshooting](troubleshooting.md)
