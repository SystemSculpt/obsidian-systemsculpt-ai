# Product and architecture

Repository instructions for product behavior and copy, repository boundaries,
module ownership, vault paths and release ownership. Read with
[the core](../../AGENTS.md); execution-specific rules remain in
[managed execution](managed-execution.md) and [native agents](native-agents.md).

## What SystemSculpt is for (read first)

1. Mission: everything a person captures and creates with AI, on any device, ends up as plain Markdown in their own Obsidian vault, on their own machine.
2. The vault is the home and the source of truth. The plugin, the iPhone app, the desktop app (next) and our servers exist to get data into it and to put AI to work on it there. None of them is a second home.
3. Plain Markdown always: every feature's output is a readable .md file (plus ordinary attachments) in the vault. No proprietary format or hidden state a person would need to keep their work.
4. Every device, one vault: a capture is finished only when it's a file in the vault. Say "In your vault" only on a verified receipt.
5. AI where the data lives: Claude Code or Codex (the person's own account) or SystemSculpt AI reads only what the person allows and writes back as files, with approval before edits.
6. No lock-in: cancelling, uninstalling or deleting an account never takes anyone's notes. What's in the vault stays.
7. Be exact about what leaves the machine: hosted AI goes through our server, OpenRouter and model providers; local agents talk to Anthropic or OpenAI; iPhone captures pass through our server. Never write "private AI", "local AI", "offline", "nothing leaves your device", "end-to-end encrypted" or "zero retention". The privacy policy is the source of truth.
8. "Open source" means the Obsidian plugin (MIT) and the Markdown format. The iPhone app and server are closed; Obsidian is free but not open source.
9. Rank work by one question: does it get a person's data into their vault as Markdown, or make it more useful there?
10. Full text: vault "02 Areas/SystemSculpt Business/Product/Mission and positioning 2026-10.md".

## Repository boundary

The SystemSculpt workspace has three sibling repositories:

- ~/gits/systemsculpt/plugin — this Obsidian client.
- ~/gits/systemsculpt/systemsculpt-website — the customer website and first-party API.
- ~/gits/systemsculpt/systemsculpt-os — growth and operator automation.

The plugin is a thin, vault-native client. It owns Obsidian integration,
presentation, local vault tool implementations, approval UX and enforcement,
a reconnecting server-protocol client, user-visible local cache/export state,
and portable Studio behavior. It does not own an agent loop, continuation
policy, provider retry, compaction, prompt caching, authoritative chat
sessions, provider SDKs, provider credentials, model catalogs, marketing
operations, or a local AI runtime.

Managed AI traffic uses the first-party SystemSculpt API at
https://systemsculpt.com/api/plugin. OpenRouter and server agent
implementation details stay behind that interface.

- The managed API base is a build-time value. The text execution selector may choose
  SystemSculpt API, on-machine Codex or on-machine Claude Code; it never exposes
  managed API routing or credentials.

## Module ownership

- Prefer one deep module with a narrow interface over adapters that simply
  rename or forward calls.
- Keep ownership local to the capability. Views render and coordinate; domain
  modules own state transitions, persistence, policy, and transport.
- The compiled plugin is the integration seam. Tests under
  testing/integration import the production bundle in an Obsidian host mock.
- Managed-service contracts and fixtures live under
  testing/fixtures/managed. Tests and CI remain credential-free.
- Built-in tool names describe user actions, not transport history. Do not add
  MCP or provider terminology to product code.
- SystemSculpt may detect and announce published releases. Obsidian Community
  Plugins exclusively owns download, installation, activation, and rollback.

- File and folder paths are vault-relative unless a desktop-only Studio node
  explicitly accepts an external path.
