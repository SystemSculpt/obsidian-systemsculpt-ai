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

  listenForKeys(listener: (event: KeyboardEvent) => void): void {
    this.registerDomEvent(this.modalEl, "keydown", listener);
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

  it("initializes its sections and removes typed listeners before reopening", () => {
    const modal = new TestStandardModal(new App());
    const keyPressed = jest.fn();
    expect(modal.contentEl.parentElement).toBe(modal.modalEl);

    modal.onOpen();
    modal.listenForKeys((event) => keyPressed(event.key));
    modal.contentEl.createEl("p", { text: "Old content" });
    modal.modalEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(keyPressed).toHaveBeenCalledWith("Enter");

    modal.onClose();
    modal.modalEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(keyPressed).toHaveBeenCalledTimes(1);
    modal.onOpen();
    expect(modal.contentEl.textContent).toBe("");
    expect(modal.modalEl.querySelectorAll(".ss-modal__header")).toHaveLength(1);
    expect(modal.modalEl.querySelectorAll(".ss-modal__footer")).toHaveLength(1);
    modal.onClose();
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
