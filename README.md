## 🧠 SystemSculpt AI for Obsidian

Turn your vault into an AI‑powered thinking partner. SystemSculpt brings fast, reliable chat, agent tools for your vault, semantic “Similar Notes,” rich context handling, and a refined Obsidian‑native experience on desktop and mobile.

<div align="center">

[![Version](https://img.shields.io/badge/version-4.1.5-blue.svg)](https://github.com/SystemSculpt/obsidian-systemsculpt-plugin)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](#-license)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0+-purple.svg)](https://obsidian.md)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-7289DA)](https://discord.gg/3gNUZJWxnJ)

[**Get Started**](#-installation) • [**Documentation**](https://systemsculpt.com) • [**Video Tutorials**](https://youtube.com/@SystemSculpt)

</div>

---

## 🚀 Core capabilities

- **Chat, your way**
  - Use OpenAI‑compatible providers (OpenAI, OpenRouter, Groq, local servers), Anthropic via adapter, or local models (LM Studio, Ollama)
  - Streaming, reasoning blocks, mobile‑friendly UI
  - Per‑chat model selection; saved chats to Markdown; chat history and resume

- **Context‑rich conversations**
  - Drag & drop notes; @‑mention files; paste large text smartly
  - Paste or attach images; use any vision‑capable model your provider supports
  - Clean rendering for code, tables, citations, and attachments

- **Agent Mode (MCP) with explicit approvals**
  - Built‑in vault tools exposed to the model with a one‑click safety approval flow
  - Filesystem tools include: `read`, `write`, `edit`, `create_folders`, `list_items`, `move`, `trash`
  - Search and context tools: `find`, `search` (grep), `open` (tabs/panes), `context` (manage chat context)

- **Semantic “Similar Notes”**
  - Embeddings‑powered vector search across your vault
  - “Similar Notes” panel that updates for the active file or chat
  - Exclusions (folders/files), progress UI, and an embeddings status bar
  - Bring your own embeddings endpoint/model (OpenAI‑compatible), or pick a provider in settings

- **Models, prompts, templates, titles**
  - Unified model selection across providers; favorites and quick picks
  - System prompt presets or custom prompts from your vault
  - Template inserter for fast drafting
  - One‑shot or automatic title generation for chats and notes

- **Web search integration**
  - Optional web search button in the chat toolbar when supported by the current provider
  - Designed for OpenRouter and native provider endpoints that offer search plugins

- **Thoughtful details**
  - Polished Obsidian UI, optimized scrolling and rendering for long chats
  - Touch‑friendly controls and responsive layout on mobile
  - Clear errors with structured notices; handy debugging commands

---

## 🧭 Getting started

1) Open Settings → SystemSculpt AI → Models & Prompts
- Choose a provider (OpenAI, OpenRouter, Anthropic, LM Studio, Ollama, or any OpenAI‑compatible endpoint)
- Enter your endpoint and API key if required

2) Start a chat
- Command palette → “Open SystemSculpt Chat”, or click the ribbon icon
- Pick a model in the header; type and send

3) Add context
- Drag notes in, @‑mention files, or click the paperclip to attach
- Use the “Chat with File” command from any note to open chat preloaded with that file

4) Try Agent Mode (optional)
- Click the vault icon in the chat toolbar to toggle Agent Mode
- Approve or deny tool calls; everything is explicit and reversible

5) Enable Similar Notes (optional)
- Settings → Embeddings & Search → Enable, then pick a provider
- If using a custom endpoint, set API endpoint + key + model (for example: `text-embedding-004`)
- Click “Start Now” to process your vault; open the “Similar Notes” panel from the command palette

6) Power‑ups
- Templates: Command palette → “Open Template Selection”
- Titles: “Change/Generate Title” from a chat or any Markdown file
- Web search: Globe button in chat toolbar (when supported by the provider)

---

## 🧩 Chat experience

- **Toolbar**: Agent Mode toggle, per‑chat settings, attach/context, web search, microphone, send
- **Context manager**: add/remove files and include your vault’s structure when helpful
- **Rendering**: unified assistant message layout, code highlighting, citations, images
- **History**: save chats to Markdown, open chat history, resume from a history file
- **Shortcuts**: configurable hotkeys; streamlined keyboard navigation

---

## 🔎 Similar Notes & semantic search

- Open “Similar Notes Panel” from the command palette or ribbon
- Results update as you switch files or as the chat evolves
- Drag similar results into chat for instant context
- Exclude chat history or specific folders/files; respect Obsidian’s own exclusions
- Status UI shows progress, counts, and completion while building embeddings

Settings → Embeddings & Search lets you:
- Enable/disable embeddings
- Choose provider: SystemSculpt or Custom (OpenAI‑compatible)
- Configure endpoint, API key, and model when using a custom provider
- Scan for local services (Ollama, LM Studio) and apply in one click

---

## 🧱 Agent Mode (MCP) tools

When Agent Mode is on, the model can request tools that work inside your vault. You explicitly approve each call before it runs.

- Files: `read`, `write`, `edit`, `create_folders`, `move`, `trash`
- Listing and navigation: `list_items`, `open`
- Search: `find` (by name), `search` (grep)
- Context & analysis: `context` (manage included files)

All tools are scoped to your vault with built‑in content limits to keep the UI responsive.

---

## ⚙️ Settings overview

- **Overview & Setup**: connect providers and API keys; activate license if you have one
- **Models & Prompts**: pick chat/title/post‑processing models; choose prompts; manage favorites
- **Chat & Templates**: chat defaults, agent mode defaults, template hotkeys
- **Embeddings & Search**: enable embeddings, provider and model selection, exclusions, processing controls
- **Audio & Transcription**: microphone selection, transcription options, post‑processing
- **Files & Backup**: directories for attachments, recordings, chats, extractions; automatic backups and restore
- **Advanced**: additional controls for power users

---

## ⌨️ Commands & shortcuts (highlights)

- Open SystemSculpt Chat
- Open SystemSculpt Chat History
- Chat with File (from the current note)
- Change Chat Model (current chat) / Set Default Chat Model
- Change/Generate Title
- Open Template Selection
- Open Similar Notes Panel
- Open SystemSculpt Search
- Open SystemSculpt AI Settings

Ribbon icons include Chat, Chat History, Janitor, Similar Notes, and Search.

---

## 📱 Mobile, privacy, and reliability

- Designed for mobile and desktop with responsive UI and touch-friendly controls
- Local-first: your vault stays on your device
- Your API keys talk directly to your chosen providers
- Works offline when using local models

## 🪜 Platform Context

- A shared `PlatformContext` singleton now powers every mobile/desktop branch.
- Desktop defaults to native `fetch` + streaming; mobile and constrained endpoints (e.g., OpenRouter) automatically pivot to Obsidian `requestUrl` with virtual SSE replay.
- UI components emit `platform-ui-<variant>` classes so styling and behavioral toggles stay in sync across chat, recorder, and transcription flows.
- Clear, actionable errors and optional debug tools

---

## 🛠 Installation

### From Obsidian Community Plugins
1. Open Obsidian Settings → Community Plugins
2. Browse and search for “SystemSculpt AI”
3. Click Install, then Enable

### Manual installation
```bash
cd /path/to/vault/.obsidian/plugins/
git clone https://github.com/SystemSculpt/obsidian-systemsculpt-plugin systemsculpt-ai
cd systemsculpt-ai
npm install
npm run build
```

---

## 🧪 Example workflows

<details>
<summary><b>📚 Research</b></summary>

Ask: “Summarize my notes on retrieval‑augmented generation and link the most similar notes.”

Use: drag notes + Similar Notes panel + agent tools for search and citations.
</details>

<details>
<summary><b>✍️ Writing</b></summary>

Ask: “Draft an outline for a blog post based on my productivity notes. Include citations.”

Use: attach context files + template inserter + title generator.
</details>

<details>
<summary><b>🖼️ Vision</b></summary>

Paste a diagram screenshot and ask questions using a vision‑capable model from your provider.
</details>

---

## 🙌 Premium benefits (optional)

If you choose to add a license, you get:
- Document intelligence: PDF/Office → clean Markdown, with table and structure preservation
- Voice & audio intelligence: in‑app recording and robust transcription pipeline
- Unified SystemSculpt provider catalog for chat and embeddings

Learn more at `https://systemsculpt.com/pricing`.

---

## 📜 License

MIT License – see `LICENSE`.

---

## 🤝 Community & support

- Docs: `https://systemsculpt.com`
- Videos: `https://youtube.com/@SystemSculpt`
- Discord: `https://discord.gg/3gNUZJWxnJ`
- Email: `systemsculpt@gmail.com`

<div align="center">

Built with ❤️ by [Mike](https://github.com/SystemSculpt) for the Obsidian community.

</div>
