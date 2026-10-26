import { Component } from "obsidian";

/**
 * Runs `teardown` if `owner` unloads while one run (a job, a progress panel) is
 * still live. Obsidian has no unregister, so the teardown lives on a child
 * component that the returned release removes once the run settles: a finished
 * run leaves nothing registered on the plugin. Releasing never runs the teardown.
 */
export function registerRunTeardown(owner: Component, teardown: () => void): () => void {
  const run = owner.addChild(new Component());
  let released = false;
  run.register(() => {
    if (!released) teardown();
  });
  return () => {
    if (released) return;
    released = true;
    owner.removeChild(run);
  };
}
