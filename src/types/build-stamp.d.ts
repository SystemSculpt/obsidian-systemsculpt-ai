/**
 * Build timestamp injected by esbuild `define` (see esbuild.config.mjs).
 * Undefined outside the bundler (for example, Jest) — always read it through
 * a `typeof` guard.
 */
declare const __SS_BUILD_STAMP__: string | undefined;
