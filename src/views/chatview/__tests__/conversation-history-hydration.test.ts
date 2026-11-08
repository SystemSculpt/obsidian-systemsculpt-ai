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
  const renderPart = jest.fn(async (parent: HTMLElement, part: MessagePart) => {
    parent.createDiv({ text: String(part.data) });
  });
  const renderTimeline = jest.fn(async (parent: HTMLElement) => {
    parent.createDiv({ text: "Saved activity" });
    return true;
  });
  const commitOverflow = jest.fn((_element: HTMLButtonElement, _nodes: HTMLElement[]) => true);
  const forgetMarkdown = jest.fn();
  const finishLayout = jest.fn();
  const beginLayoutMutation = jest.fn(() => finishLayout);
  const hydration = new ConversationHistoryHydration({
    renderPart, renderTimeline, commitOverflow, forgetMarkdown, beginLayoutMutation,
  });
  return { hydration, renderPart, renderTimeline, commitOverflow, forgetMarkdown, beginLayoutMutation, finishLayout };
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
    expect(h.hydration.hydrate(target.element)).toBeNull();
  });

  it.each(["activity", "overflow"] as const)("rejects hidden %s work and retries on show", async (kind) => {
    const h = harness();
    const target = activity();
    const overflow = document.body.createEl("button");
    const gate = deferred();
    if (kind === "activity") {
      h.hydration.deferActivity(target, parts);
      h.renderTimeline.mockImplementationOnce(async (staging) => {
        staging.createDiv({ text: "Stale activity" });
        await gate.promise;
        return true;
      });
    } else {
      h.hydration.deferOverflow(overflow, parts);
      h.renderPart.mockImplementationOnce(async (staging) => {
        staging.createDiv({ text: "Stale overflow" });
        await gate.promise;
      });
    }
    const element = kind === "activity" ? target.element : overflow;
    const pending = h.hydration.hydrate(element);
    h.hydration.setVisible(false);
    gate.resolve();
    await pending;
    expect(h.hydration.pendingCount).toBe(0);
    expect(h.hydration.wasHydrated(element)).toBe(false);
    expect(target.body.childElementCount).toBe(0);
    expect(h.commitOverflow).not.toHaveBeenCalled();
    expect(h.forgetMarkdown).toHaveBeenCalledTimes(1);
    expect(h.hydration.hydrate(element)).toBeNull();
    h.hydration.setVisible(true);
    await h.hydration.hydrate(element);
    expect(h.hydration.wasHydrated(element)).toBe(true);
    expect(h.hydration.pendingCount).toBe(0);
  });

  it("disposes removed work and all remaining entries without publishing late overflow nodes", async () => {
    const h = harness();
    const row = document.body.createDiv();
    const overflow = row.createEl("button");
    const other = document.body.createEl("button");
    const gate = deferred();
    h.renderPart.mockImplementationOnce(async (staging) => {
      staging.createDiv({ text: "Late history" });
      await gate.promise;
    });
    h.hydration.deferOverflow(overflow, parts);
    h.hydration.deferOverflow(other, parts);
    const pending = h.hydration.hydrate(overflow);
    h.hydration.forgetWithin(row);
    expect(h.hydration.pendingCount).toBe(0);
    expect(h.hydration.hydrate(overflow)).toBeNull();
    gate.resolve();
    await pending;
    expect(h.commitOverflow).not.toHaveBeenCalled();
    await h.hydration.hydrate(other);
    expect(h.commitOverflow).toHaveBeenCalledTimes(1);
    h.hydration.clear();
    expect(h.hydration.hydrate(other)).toBeNull();
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
