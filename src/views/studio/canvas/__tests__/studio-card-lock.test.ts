/** @jest-environment jsdom */
import { createStudioCardLock, isStudioCardLocked, lockStudioControl, watchStudioCardLock } from "../StudioCardLock";

it("applies the lock now and on each change, and drops controls that left the card", () => {
  const card = document.createElement("div");
  const lock = createStudioCardLock(false, card);
  const kept = card.appendChild(document.createElement("button"));
  const held = card.appendChild(document.createElement("button"));
  const rerendered = card.appendChild(document.createElement("button"));
  lockStudioControl(lock, kept);
  lockStudioControl(lock, held, true);
  lockStudioControl(lock, rerendered);
  const seen: boolean[] = [];
  watchStudioCardLock(lock, locked => seen.push(locked));
  expect([kept.disabled, held.disabled, rerendered.disabled]).toEqual([false, true, false]);

  rerendered.remove();
  lock.set(true);
  expect([kept.disabled, held.disabled, rerendered.disabled]).toEqual([true, true, false]);
  lock.set(true);
  lock.set(false);
  expect([kept.disabled, held.disabled]).toEqual([false, true]);
  expect(seen).toEqual([false, true, false]);
  expect(isStudioCardLocked(lock)).toBe(false);
});

it("treats a boolean as a lock that never changes", () => {
  const button = document.createElement("button");
  lockStudioControl(true, button);
  expect(button.disabled).toBe(true);
  expect(isStudioCardLocked(false)).toBe(false);
});
