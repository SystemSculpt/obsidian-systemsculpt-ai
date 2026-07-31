/**
 * E2E test-driver build flag injected by esbuild `define` (see
 * scripts/plugin-build-options.mjs). True only for development, staging, and
 * local-agent builds; release builds define it false so the driver module is
 * eliminated from the production bundle. Undefined outside the bundler
 * (for example, Jest) — always read it through a `typeof` guard.
 */
declare const __SS_TEST_DRIVER__: boolean | undefined;
