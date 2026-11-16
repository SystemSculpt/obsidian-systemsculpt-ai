/**
 * @jest-environment jsdom
 */

import type { MessagePart } from "../../../types";
import { ConversationHistoryHydration } from "../ConversationHistoryHydration";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const parts: MessagePart[] = [{ id: "history-text", type: "content", timestamp: 1, data: "Saved work" }];

function activity() {
  const element = document.body.createEl("details");
  const summary = element.createEl("summary");
  const body = element.createDiv();
  return { element, summary, body };
}

function harness() {
  const renderTimeline = jest.fn(async (parent: HTMLElement) => {
    parent.createDiv({ text: "Saved activity" });
    return true;
  });
  const forgetMarkdown = jest.fn();
  const activityHydrated = jest.fn();
  const finishLayout = jest.fn();
  const beginLayoutMutation = jest.fn(() => finishLayout);
  const hydration = new ConversationHistoryHydration({
    renderTimeline, forgetMarkdown, activityHydrated, beginLayoutMutation,
  });
  return { hydration, renderTimeline, forgetMarkdown, activityHydrated, beginLayoutMutation, finishLayout };
}

describe("ConversationHistoryHydration", () => {
  afterEach(() => document.body.empty());

  it("keeps activity cold, coalesces hydration, and brackets only the final commit", async () => {
    const h = harness();
    const target = activity();
    const gate = deferred();
    h.renderTimeline.mockImplementation(async (staging) => {
      staging.createDiv({ text: "Saved activity" });
      await gate.promise;
      return true;
    });
    h.hydration.deferActivity(target, parts);
    expect(h.renderTimeline).not.toHaveBeenCalled();
    const pending = h.hydration.hydrate(target.element);
    expect(h.hydration.hydrate(target.element)).toBe(pending);
    expect(h.hydration.pendingCount).toBe(1);
    expect(h.beginLayoutMutation).not.toHaveBeenCalled();
    expect(target.body.childElementCount).toBe(0);
    gate.resolve();
    await pending;
    expect(h.hydration.pendingCount).toBe(0);
    expect(h.hydration.wasHydrated(target.element)).toBe(true);
    expect(h.beginLayoutMutation).toHaveBeenCalledWith(target.summary, target.body);
    expect(h.finishLayout).toHaveBeenCalledTimes(1);
    expect(target.body.textContent).toBe("Saved activity");
    expect(h.activityHydrated).toHaveBeenCalledWith(target.element);
    expect(h.hydration.hydrate(target.element)).toBeNull();
  });

  it("rejects hidden activity work and retries on show", async () => {
    const h = harness();
    const target = activity();
    const gate = deferred();
    h.hydration.deferActivity(target, parts);
    h.renderTimeline.mockImplementationOnce(async (staging) => {
      staging.createDiv({ text: "Stale activity" });
      await gate.promise;
      return true;
    });
    const pending = h.hydration.hydrate(target.element);
    h.hydration.setVisible(false);
    gate.resolve();
    await pending;
    expect(h.hydration.pendingCount).toBe(0);
    expect(h.hydration.wasHydrated(target.element)).toBe(false);
    expect(target.body.childElementCount).toBe(0);
    expect(h.activityHydrated).not.toHaveBeenCalled();
    expect(h.forgetMarkdown).toHaveBeenCalledTimes(1);
    expect(h.hydration.hydrate(target.element)).toBeNull();
    h.hydration.setVisible(true);
    await h.hydration.hydrate(target.element);
    expect(h.hydration.wasHydrated(target.element)).toBe(true);
    expect(h.hydration.pendingCount).toBe(0);
  });

  it("disposes removed work and all remaining entries without publishing late rows", async () => {
    const h = harness();
    const row = document.body.createDiv();
    const removed = activity();
    row.appendChild(removed.element);
    const other = activity();
    const gate = deferred();
    h.renderTimeline.mockImplementationOnce(async (staging) => {
      staging.createDiv({ text: "Late history" });
      await gate.promise;
      return true;
    });
    h.hydration.deferActivity(removed, parts);
    h.hydration.deferActivity(other, parts);
    const pending = h.hydration.hydrate(removed.element);
    h.hydration.forgetWithin(row);
    expect(h.hydration.pendingCount).toBe(0);
    expect(h.hydration.hydrate(removed.element)).toBeNull();
    gate.resolve();
    await pending;
    expect(removed.body.childElementCount).toBe(0);
    expect(h.activityHydrated).not.toHaveBeenCalled();
    await h.hydration.hydrate(other.element);
    expect(h.activityHydrated).toHaveBeenCalledTimes(1);
    expect(other.body.textContent).toBe("Saved activity");
    h.hydration.clear();
    expect(h.hydration.hydrate(other.element)).toBeNull();
    expect(h.hydration.pendingCount).toBe(0);
  });

  it("retries a failed render with a fresh staging tree", async () => {
    const h = harness();
    const target = activity();
    h.renderTimeline.mockRejectedValueOnce(new Error("History render failed"));
    h.hydration.deferActivity(target, parts);
    await expect(h.hydration.hydrate(target.element)).rejects.toThrow("History render failed");
    expect(h.hydration.pendingCount).toBe(0);
    expect(h.hydration.wasHydrated(target.element)).toBe(false);
    expect(target.body.childElementCount).toBe(0);
    await h.hydration.hydrate(target.element);
    expect(h.hydration.wasHydrated(target.element)).toBe(true);
    expect(h.renderTimeline.mock.calls[0]![0]).not.toBe(h.renderTimeline.mock.calls[1]![0]);
  });
});
