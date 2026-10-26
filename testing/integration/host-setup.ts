/**
 * The integration host has no Node module loader. src/tests/setup.ts gives
 * source tests Jest's require as window.require; the built bundle must not
 * get it, or desktop chat's Claude Code and Codex detection would stat this
 * machine's PATH, run its agent CLIs, and keep requiring Node modules after
 * the test file's environment is torn down. Desktop finds neither agent here,
 * as on a computer without them.
 */
function removeNodeModuleLoader(): void {
  if (typeof window !== "undefined") delete (window as Window & { require?: unknown }).require;
}

removeNodeModuleLoader();
// Runs after the shared setup's beforeEach, which restores the loader.
beforeEach(removeNodeModuleLoader);
