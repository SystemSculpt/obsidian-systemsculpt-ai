# Getting started

SystemSculpt AI runs entirely inside Obsidian and connects to the model provider(s) you choose.

## Install

### Community Plugins (recommended)

1. Obsidian → **Settings** → **Community plugins**
2. Search for **SystemSculpt AI**
3. **Install** → **Enable**

### Manual install (developers)

1. Clone this repo into your vault’s plugins folder:

```bash
cd /path/to/vault/.obsidian/plugins/
git clone https://github.com/systemsculpt/obsidian-systemsculpt-ai systemsculpt-ai
cd systemsculpt-ai
npm install
npm run build
```

## First run setup

1. Open **Settings** → **SystemSculpt AI** → **Overview & Setup**
2. Choose a provider and enter your API key / endpoint (if required)
3. (Optional) Set defaults in **Models & Prompts** and **Chat & Templates**

If you have a SystemSculpt license, the default SystemSculpt model is backed by OpenRouter `x-ai/grok-4.1-fast` and supports image inputs.

See: [Settings overview](settings.md).

## Start a chat

- Command palette → **Open SystemSculpt Chat**
- Or click the **SystemSculpt Chat** ribbon icon (left sidebar)

## Add context

Common ways to give the model context:

- Drag notes/files into the chat
- Use the paperclip button to attach context files (they’ll appear above the message box; click `x` to remove)
- Type `@` to mention a file (if enabled in the chat UI)
- Use **Chat with File** from the command palette while viewing a note
- Attach an image (requires a vision-capable model/provider)

## Try Agent Mode (optional)

Agent Mode lets the model request explicit tool calls that operate inside your vault (file reads, edits, search, etc.).

See: [Agent Mode](agent-mode.md).

## Enable Similar Notes (optional)

Similar Notes is powered by embeddings (vector search) and must be enabled in settings.

See: [Similar Notes](similar-notes.md).
