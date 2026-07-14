/** @jest-environment jsdom */

import { App } from "obsidian";
import {
  StandardModal,
  type ModalAsyncTaskScope,
} from "../StandardModal";

class TestStandardModal extends StandardModal {
  startTask(key: string): ModalAsyncTaskScope {
    return this.beginAsyncTask(key);
  }

  addVisibleTitle(title: string, description?: string): void {
    this.addTitle(title, description);
  }

}

describe("StandardModal", () => {
  it("owns baseline dialog semantics and replaces its fallback name with a visible title", () => {
    const modal = new TestStandardModal(new App());

    expect(modal.modalEl.getAttribute("role")).toBe("dialog");
    expect(modal.modalEl.getAttribute("aria-modal")).toBe("true");
    expect(modal.modalEl.getAttribute("aria-label")).toBe("SystemSculpt");

    modal.onOpen();
    modal.addVisibleTitle("Focused task", "Task details");

    const titleId = modal.modalEl.getAttribute("aria-labelledby");
    expect(modal.modalEl.hasAttribute("aria-label")).toBe(false);
    expect(titleId).toBeTruthy();
    expect(modal.modalEl.querySelector(`#${titleId}`)?.textContent).toBe("Focused task");
    expect(modal.modalEl.getAttribute("aria-describedby")).toBeTruthy();

    modal.onClose();
    expect(modal.modalEl.getAttribute("aria-label")).toBe("SystemSculpt");
    expect(modal.modalEl.hasAttribute("aria-labelledby")).toBe(false);
  });

  it("invalidates keyed tasks on replacement, close, and reopen", () => {
    const modal = new TestStandardModal(new App());
    modal.onOpen();

    const first = modal.startTask("load");
    const independent = modal.startTask("preview");
    const replacement = modal.startTask("load");

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(independent.isCurrent()).toBe(true);
    expect(replacement.isCurrent()).toBe(true);

    modal.onClose();
    expect(independent.signal.aborted).toBe(true);
    expect(replacement.signal.aborted).toBe(true);
    expect(replacement.isCurrent()).toBe(false);

    modal.onOpen();
    const reopened = modal.startTask("load");
    expect(replacement.isCurrent()).toBe(false);
    expect(reopened.signal.aborted).toBe(false);
    expect(reopened.isCurrent()).toBe(true);
  });
});
