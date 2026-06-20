import { PlatformContext } from "../services/PlatformContext";

/**
 * Canonical boundary for desktop-only code (#207).
 *
 * Obsidian's mobile runtime has no Node.js, so any module that imports a Node
 * builtin (`fs`, `path`, `child_process`, …) — directly or transitively — must
 * never load on mobile, and must never be a *static* import on the startup
 * chain: esbuild lowers a top-level `import` to an eager `require`, which throws
 * at bundle-eval on a phone ("Failed to load SystemSculpt AI", the #181 class).
 *
 * Shared/startup modules therefore reach desktop-only subsystems ONLY through
 * these helpers. The loader runs inside a thunk so the `require` is lazy (no
 * eager eval touch), and it is gated by the Node-runtime capability (skipped on
 * mobile). Inside a desktop-only subsystem — which is reached only via these
 * boundaries — importing Node builtins directly is fine; it never loads on a
 * phone.
 */

/** True iff a Node.js runtime is available (desktop/Electron). */
export function hasNodeRuntime(): boolean {
  return PlatformContext.get().supportsNodeApis();
}

/**
 * Lazily load a desktop-only module, returning `null` on mobile (no Node). The
 * loader MUST perform the `require` itself so it stays lazy, e.g.
 * `loadDesktopOnly(() => require("./PiSdkDesktopSupport"))`.
 */
export function loadDesktopOnly<T>(loader: () => T): T | null {
  return hasNodeRuntime() ? loader() : null;
}
