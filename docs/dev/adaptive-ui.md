# Adaptive UI

Repository instructions for desktop/mobile surfaces, host capabilities,
settings, pop-outs and Studio portability. Read with [the core](../../AGENTS.md).
Mobile release gates follow below; local QA setup is in
[Local development](local-development.md).

## Studio portability

- Studio is portable. Every built-in node declares
  requiredHostCapabilities, including an explicit empty list for portable
  nodes. Registry presentation, run preflight, and runtime enforcement all use
  the same declaration.

## Desktop and mobile product contract

Desktop and mobile are one adaptive product, not separate feature trees. Keep
shared state, services, views, and components together. Adapt through these
three independent seams:

1. Host capability: src/platform/hostCapabilities.ts owns device capability
   checks and Electron resolution. Feature code uses hasHostCapability and
   never reads Platform to decide behavior or loads Electron directly.
   src/platform/desktopOnly.ts remains the only Node built-in loader.
2. Surface geometry: every plugin-owned view, modal, or transient mounts
   PluginSurface. Use container queries for available width and pointer:
   coarse for touch ergonomics. Do not infer host capability from viewport
   width.
3. Mobile host chrome: src/platform/mobileLayout.ts owns the mobile-host
   predicate. src/platform/mobileHostLayout.ts is the only code allowed to
   know Obsidian's private mobile navbar DOM; it publishes the owned
   ss-mobile-layout, ss-mobile-navbar-visible, and ss-mobile-navbar-hidden
   body classes. Feature CSS must not target .is-mobile or
   .mobile-navbar-action.

Commands, settings, and card actions must either work on both hosts, provide a
useful portable fallback, or disappear when their required capability is
absent. Never leave a control that only produces a desktop-only error on
mobile. Fixed and bottom-aligned surfaces consume the shared safe-area and
mobile-bottom-clearance tokens. Resolve layout, clipboard, focus, timers, and
Electron from the initiating element's owner window so pop-out windows remain
correct.

Obsidian 1.13 treats getSettingDefinitions as the complete settings renderer
and skips display() when it exists. SystemSculpt remains on its full imperative
renderer until every dynamic control has declarative parity. Never add partial
definitions: that turns mobile settings into heading-only rows.

## Mobile verification

For mobile-sensitive changes, npm run check:mobile and npm run check:ci are
the release gates. They validate the exact built main.js, manifest.json, and
styles.css across narrow-pane, touch, keyboard, accessibility, and Studio
capability scenarios with desktop adapters unavailable. Simulator, emulator,
browser-emulation, or physical-device runs may provide supplemental evidence
when explicitly requested, but they are not release gates and must not replace
or weaken the deterministic checks. Record the host and artifact hashes when
manual mobile exploration is performed.
