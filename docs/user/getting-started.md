# Getting started

SystemSculpt AI runs inside Obsidian and uses the model providers you configure.

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

1. Open `Settings -> SystemSculpt AI -> Overview & Setup`.
2. Add a provider (OpenAI, Anthropic, OpenRouter, MiniMax, Moonshot/Kimi, Groq, Ollama, LM Studio, or custom OpenAI-compatible).
3. Add API credentials for that provider.
4. Optional: enter and activate a SystemSculpt license key.

## Start chatting

- Command palette: `Open SystemSculpt Chat`
- Ribbon icon: `Open SystemSculpt Chat`

## Add context

- Drag files into chat.
- Attach files with the paperclip in chat.
- Type `@` to mention files.
- Use `Chat with File` from the command palette.

## Turn on Agent Mode (optional)

- Agent Mode is per chat.
- Toggle it from the chat toolbar.
- When enabled, the model can request tool calls (filesystem, web research, YouTube transcript).

## Enable Similar Notes (optional)

1. Open `Settings -> SystemSculpt AI -> Embeddings & Search`.
2. Enable embeddings.
3. Choose `SystemSculpt` or `Custom provider`.
4. Open `Open Similar Notes Panel`.

## Next docs

- [Settings](settings.md)
- [Commands](commands.md)
- [Agent Mode](agent-mode.md)
- [Troubleshooting](troubleshooting.md)
