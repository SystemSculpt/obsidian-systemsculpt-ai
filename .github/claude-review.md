# Claude PR Review Guide

Review title: **SystemSculpt AI -- PR Review**

## Project Context

SystemSculpt AI is an Obsidian plugin written in TypeScript with esbuild and Jest. It has desktop and mobile code paths, plugin lifecycle concerns, settings persistence, MCP-related bridge behavior, and Obsidian vault data handling.

## Review Focus

### TypeScript and Type Safety

- Preserve strict mode compliance.
- Avoid untyped `any` unless the justification is clear.
- Use Obsidian plugin API types correctly.

### Plugin Lifecycle

- Settings persistence must remain correct.
- Bridge reconnection and hot-reload paths should not regress.
- `onload` and `onunload` must clean up event listeners, intervals, MCP connections, and other resources.

### Platform Separation

- Desktop and mobile code paths must remain isolated where required.
- MCP transport and tool registration should not bleed between unsupported platforms.

### Architecture

- Respect the source layout: `src/core` for plugin/UI, `src/services` for logic, `src/mcp-tools`, `src/settings`, `src/views`, and `src/commands`.
- Preserve the path alias where `@/*` maps to `Nexus/src/*`.

### Build and Bundle

- esbuild config changes must not break CSS inlining or banner wrapping.
- Consider plugin sync and multi-platform vault mirroring impact when touched.

### Tests

- Jest uses SWC and mocks for `obsidian`, `pi-coding-agent`, and `pi-ai`.
- Changes to services should have corresponding test coverage or a clear reason tests are not needed.

### Security

- Do not introduce API keys, tokens, or secrets.
- Treat chat, embedding, and vault content as user data.

### Verification of External Claims

- External browsing tools are disabled in the review workflow by default.
- If unfamiliar model IDs, API endpoint URLs, SDK method names, dependency version claims, or third-party feature availability cannot be verified from the supplied repository context, say "unable to verify" instead of asserting the claim is false.

## Extra Instructions

- Prioritize bugs, regressions, security issues, and missing tests.
- Skip stylistic nits unless they materially affect readability or maintainability.
- Mention skipped generated, lock, snapshot, oversized, binary, or vendored files only under Notes when relevant.
