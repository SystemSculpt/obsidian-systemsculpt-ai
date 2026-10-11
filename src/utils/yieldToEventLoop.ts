/**
 * Yield execution to the next macrotask to let pending timers and UI work run.
 * This helps avoid long-running synchronous blocks that delay scheduled startup phases.
 * Work begun in a pop-out passes that window, so the pause runs on its timer.
 */
export async function yieldToEventLoop(delayMs = 0, ownerWindow: Window = window): Promise<void> {
  await new Promise<void>((resolve) => {
    ownerWindow.setTimeout(resolve, delayMs);
  });
}

/**
 * Resolves true once the host is idle, or after `timeoutMs` at the latest.
 * Resolves false, without running anything else, when `signal` aborts first:
 * a plugin that unloads before its deferred startup work begins stays inert.
 */
export function waitForIdle(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let cancel: () => void;
    const finish = (idle: boolean): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve(idle);
    };
    const onAbort = (): void => {
      cancel();
      finish(false);
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      const handle = idleWindow.requestIdleCallback(() => finish(true), { timeout: timeoutMs });
      cancel = () => idleWindow.cancelIdleCallback?.(handle);
    } else {
      const handle = window.setTimeout(() => finish(true), timeoutMs);
      cancel = () => window.clearTimeout(handle);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
