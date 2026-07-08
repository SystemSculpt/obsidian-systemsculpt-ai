/**
 * Build timestamp injected by esbuild `define` (see esbuild.config.mjs).
 * Undefined outside the bundler (jest, ts-node) — always read it through
 * a `typeof` guard.
 */
declare const __SS_BUILD_STAMP__: string | undefined;
