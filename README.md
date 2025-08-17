# 🧠 SystemSculpt AI for Obsidian

> Transform your Obsidian vault into an AI-powered thinking partner that grows smarter with every note you write.

<div align="center">

[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](https://github.com/SystemSculpt/obsidian-systemsculpt-plugin)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](#-license)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0+-purple.svg)](https://obsidian.md)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-7289DA)](https://discord.gg/3gNUZJWxnJ)

[**✨ Get Started Free**](#-installation) • [**📚 Documentation**](https://systemsculpt.com) • [**🎥 Video Tutorials**](https://youtube.com/@SystemSculpt)

</div>

---

## 🚀 What is SystemSculpt AI?

SystemSculpt AI is the most comprehensive AI integration for Obsidian, designed for knowledge workers who refuse to settle for basic productivity tools. Whether you're a researcher synthesizing complex information, a content creator building your second brain, or a developer automating workflows—this plugin transforms Obsidian into your AI-powered thinking partner.

### 🎯 Perfect For:
- **📚 Researchers & Academics**: Find hidden connections across thousands of notes
- **✍️ Content Creators**: Generate ideas and outlines based on your knowledge base
- **💻 Developers**: Automate documentation and code-related workflows
- **🧪 Product Managers**: Analyze user feedback and synthesize insights
- **🎨 Creative Professionals**: Break through creative blocks with AI assistance

---

## ✨ Core Features (Free Forever)

### 🤖 **Multi-Provider AI Chat**
Connect to any AI provider with your own API keys—no middleman fees, no vendor lock-in.

<table>
<tr>
<td width="50%">

**Supported Providers:**
- 🟢 **OpenAI** (o4-mini, GPT-4o, GPT-4o Mini)
- 🔵 **Anthropic** (Claude Opus 4, Claude Sonnet 4)
- 🌐 **OpenRouter** (200+ models including Gemini, DeepSeek, Perplexity)
- ⚡ **Groq** (Lightning-fast Llama 3.1, Mixtral)
- 🏠 **Local Models** (Ollama, LM Studio, any local server)
- 🔧 **Custom Endpoints** (Any OpenAI-compatible API)

</td>
<td width="50%">

**Chat Features:**
- 📁 Drag & drop files for instant context
- 🔄 Multi-file conversations
- 💾 Save chats as markdown
- 🎨 Beautiful, customizable UI
- ⚙️ Per-chat settings
- 📱 Mobile-friendly design

</td>
</tr>
</table>

### 🛠️ **Model Context Protocol (MCP)**
The future of AI tool usage, available today. Give your AI assistant the ability to:
- 📂 **Browse** your entire vault structure
- 📝 **Read & Write** files autonomously
- 🔍 **Search** for content across notes
- 🧩 **Connect** to external MCP servers
- 🎯 **Execute** complex multi-step tasks
- 🔐 **Safe Mode** with approval workflows

### 🔗 **Semantic Search & Connections**
Discover relationships between ideas you didn't know existed:
- 🧲 Find similar notes using AI embeddings
- 🕸️ Explore knowledge graph connections
- 🎯 Add relevant context with one click
- 📊 Visualize idea relationships

### 📋 **AI-Powered Task Management**
Turn conversations into actionable tasks:
- ✅ Generate task lists from chat
- 📌 Track tasks in dedicated file
- 🔄 Sync with Obsidian's task system
- 📈 Progress tracking

### 🎨 **Customization & Templates**
Make the AI work exactly how you think:
- 💬 Custom system prompts
- 📄 Template library with hotkeys
- 🎭 Multiple AI personalities
- ⚡ Slash commands (`/clear`, `/model`, `/new`)
- 🔤 @ mentions for file references

---

## 💎 Premium Features

> **Note**: Core features are free forever. Premium features enhance your workflow with advanced capabilities.

### 🎙️ **Voice & Audio Intelligence**
Transform spoken words into structured knowledge:
- **🔴 One-Click Recording**: Record thoughts directly in Obsidian
- **📝 Smart Transcription**: Convert audio to markdown with AI cleanup
- **🎵 Multi-Format Support**: MP3, WAV, M4A, OGG, WebM
- **🧩 Large File Handling**: Process hours of audio seamlessly
- **✨ Post-Processing**: AI improves transcript readability

### 📄 **Document Intelligence**
Extract knowledge from any document:
- **📑 PDF → Markdown**: Preserve formatting, tables, and structure
- **💼 Office Files**: Process Word, PowerPoint, Excel documents
- **🖼️ Image Extraction**: Save embedded images automatically
- **📊 Table Preservation**: Maintain complex data structures
- **🗂️ Bulk Processing**: Handle multiple documents at once

### 👁️ **Vision & Image Analysis**
See through your AI's eyes:
- **🖼️ Image Understanding**: Analyze screenshots, diagrams, photos
- **📸 Instant Analysis**: Paste images from clipboard
- **💬 Visual Q&A**: Ask questions about images
- **📝 OCR Capabilities**: Extract text from images
- **🎯 Context Integration**: Include images in conversations

### ⚡ **SystemSculpt Premium**
Enhanced AI capabilities for power users:
- **🌐 Premium Models**: Access to advanced AI models
- **🚀 Priority Features**: First access to new capabilities
- **📊 Enhanced Processing**: Document and audio processing
- **🔒 Privacy-Focused**: Your data stays in your vault

---

## 🚀 Installation

### From Obsidian Community Plugins
1. Open Obsidian Settings → Community Plugins
2. Browse and search for "SystemSculpt AI"
3. Click Install, then Enable
4. Start using immediately with free features!

### Manual Installation
```bash
# Clone into your vault's plugins folder
cd /path/to/vault/.obsidian/plugins/
git clone https://github.com/SystemSculpt/obsidian-systemsculpt-plugin systemsculpt-ai

# Install dependencies and build
cd systemsculpt-ai
npm install
npm run build

# Restart Obsidian and enable the plugin
```

---

## 🎯 Quick Start Guide

### 1️⃣ **Basic Chat Setup**
```markdown
1. Click the brain icon (🧠) in the left sidebar
2. Choose your AI provider (or use SystemSculpt free tier)
3. Start chatting—it's that simple!
```

### 2️⃣ **Add Context to Conversations**
```markdown
- Drag any note into the chat
- Type @ to mention specific files
- Click "Similar Notes" to find related content
```

### 3️⃣ **Enable Agent Mode** (Advanced)
```markdown
1. Toggle "Agent Mode" in chat settings
2. AI can now read/write files autonomously
3. You'll approve each action before execution
```

### 🎬 **Example Workflows**

<details>
<summary><b>📚 Research Assistant</b></summary>

```markdown
You: "Find all my notes about machine learning and create a comprehensive overview"

AI: *Searches vault, reads relevant notes, creates structured summary*
```
</details>

<details>
<summary><b>✍️ Content Creation</b></summary>

```markdown
You: "Based on my notes about productivity, write a blog post outline"

AI: *Analyzes your productivity notes, generates SEO-friendly outline*
```
</details>

<details>
<summary><b>💻 Code Documentation</b></summary>

```markdown
You: "Document this code file and create examples"

AI: *Reads code, generates documentation with examples*
```
</details>

---

## 💰 Pricing

### 🆓 **Free Forever**
- ✅ All core AI chat features
- ✅ MCP tool usage
- ✅ Semantic search
- ✅ Task management
- ✅ Multiple AI providers
- ✅ No limits, no trials

### 💎 **Premium Options**

| Plan | Price | Best For | Includes |
|------|-------|----------|----------|
| **[Monthly](https://systemsculpt.com/monthly)** | $19/mo | Active users | All premium features |
| **[Lifetime](https://systemsculpt.com/lifetime)** | $249 | Power users | Everything + 1-on-1 setup session with creator |

[**🛒 Get Premium Access →**](https://systemsculpt.com/pricing)

---

## 🔐 Privacy & Security

Your data is YOUR data. Period.

- 🏠 **Local First**: All data stays in your vault
- 🔑 **Your API Keys**: Direct connection to AI providers
- 🚫 **No Data Collection**: Your conversations stay private
- 🔒 **Encrypted Storage**: API keys secured by Obsidian
- ✅ **Secure Processing**: Premium features use secure endpoints
- 🌐 **Offline Mode**: Works with local models

---

## 🛡️ Support & Community

### 📚 **Resources**
- [Documentation](https://systemsculpt.com/docs)
- [Video Tutorials](https://youtube.com/@SystemSculpt)
- [Discord Community](https://discord.gg/3gNUZJWxnJ)
- [GitHub Issues](https://github.com/systemsculpt/obsidian-systemsculpt-plugin/issues)

### 🤝 **Get Help**
- 💬 **Discord**: Fast community support
- 📧 **Email**: mike@systemsculpt.com
- 🎥 **1-on-1**: Available with lifetime license

---

## 🚧 Development

Built with modern web technologies for performance and reliability:

```typescript
// Tech Stack
- TypeScript       // Type-safe development
- Obsidian API    // Deep vault integration  
- WebSockets      // Real-time streaming
- Service Workers // Offline capabilities
```

### Contributing
We welcome contributions! Please see our [GitHub Issues](https://github.com/SystemSculpt/obsidian-systemsculpt-plugin/issues) to get started.


---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">

**Built with ❤️ by [Mike](https://github.com/SystemSculpt) for the Obsidian community**

[⬆ Back to Top](#-systemsculpt-ai-for-obsidian)

</div>