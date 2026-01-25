/**
 * Yield execution to the next macrotask to let pending timers and UI work run.
 * This helps avoid long-running synchronous blocks that delay scheduled startup phases.
 */
export async function yieldToEventLoop(delayMs = 0): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
