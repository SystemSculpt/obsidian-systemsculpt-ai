/** @jest-environment jsdom */

import { App } from "obsidian";
import {
  StandardChatSettingsModal,
  showStandardChatSettingsModal,
  type ChatSettingsChange,
} from "../StandardChatSettingsModal";

describe("StandardChatSettingsModal", () => {
  afterEach(() => {
    document.body.empty();
  });

  const openModal = (onChange = jest.fn<void, [ChatSettingsChange]>()) => {
    const modal = new StandardChatSettingsModal(new App(), {
      initialValues: {
        approvalMode: "ask",
        chatFontSize: "medium",
      },
      onChange,
    });
    modal.open();
    return { modal, onChange };
  };

  it("renders a compact, labelled dialog with the requested option names", () => {
    const { modal } = openModal();
    const titleId = modal.modalEl.getAttribute("aria-labelledby");
    const choices = Array.from(
      modal.modalEl.querySelectorAll<HTMLButtonElement>(".ss-chat-settings__choice")
    );

    expect(modal.modalEl.classList.contains("ss-chat-settings-modal")).toBe(true);
    expect(modal.modalEl.getAttribute("role")).toBe("dialog");
    expect(modal.modalEl.getAttribute("aria-modal")).toBe("true");
    expect(titleId).toBeTruthy();
    expect(modal.modalEl.querySelector(`#${titleId}`)?.textContent).toBe("Chat settings");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "Ask Approval",
      "Full Access",
      "Small",
      "Medium",
      "Large",
    ]);
    expect(modal.modalEl.querySelector(".ss-modal__close-button")?.tagName).toBe("BUTTON");
    expect(modal.modalEl.querySelector(".ss-modal__close-button")?.getAttribute("aria-label")).toBe("Close");
  });

  it("marks initial values through radio semantics", () => {
    const { modal } = openModal();
    const ask = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="ask"]');
    const medium = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="medium"]');
    const fullAccess = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="full-access"]');

    expect(ask?.getAttribute("role")).toBe("radio");
    expect(ask?.getAttribute("aria-checked")).toBe("true");
    expect(medium?.getAttribute("aria-checked")).toBe("true");
    expect(fullAccess?.getAttribute("aria-checked")).toBe("false");
    expect(ask?.tabIndex).toBe(0);
    expect(fullAccess?.tabIndex).toBe(-1);
  });

  it("supports roving focus and arrow-key selection inside each radio group", () => {
    const { modal, onChange } = openModal();
    const ask = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="ask"]')!;
    const fullAccess = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="full-access"]')!;

    ask.focus();
    ask.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(document.activeElement).toBe(fullAccess);
    expect(ask.tabIndex).toBe(-1);
    expect(fullAccess.tabIndex).toBe(0);
    expect(fullAccess.getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenCalledWith({ kind: "approval-mode", value: "full-access" });
  });

  it("applies approval and text-size changes immediately through one typed seam", () => {
    const { modal, onChange } = openModal();
    const fullAccess = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="full-access"]');
    const large = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="large"]');

    fullAccess?.click();
    large?.click();

    expect(onChange).toHaveBeenNthCalledWith(1, {
      kind: "approval-mode",
      value: "full-access",
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      kind: "font-size",
      value: "large",
    });
    expect(fullAccess?.getAttribute("aria-checked")).toBe("true");
    expect(large?.getAttribute("aria-checked")).toBe("true");
  });

  it("does not emit a change when the selected value is clicked again", () => {
    const { modal, onChange } = openModal();

    modal.modalEl.querySelector<HTMLButtonElement>('[data-value="ask"]')?.click();
    modal.modalEl.querySelector<HTMLButtonElement>('[data-value="medium"]')?.click();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("rolls a rejected approval change back to its committed radio value", async () => {
    let reject!: (error: Error) => void;
    const onChange = jest.fn(() => new Promise<void>((_resolve, nextReject) => { reject = nextReject; }));
    const { modal } = openModal(onChange);
    const ask = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="ask"]')!;
    const fullAccess = modal.modalEl.querySelector<HTMLButtonElement>('[data-value="full-access"]')!;
    const group = fullAccess.closest<HTMLElement>('[role="radiogroup"]')!;

    fullAccess.click();
    expect(fullAccess.getAttribute("aria-checked")).toBe("true");
    expect(group.getAttribute("aria-busy")).toBe("true");
    expect(ask.disabled).toBe(true);

    reject(new Error("vault write failed"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(ask.getAttribute("aria-checked")).toBe("true");
    expect(fullAccess.getAttribute("aria-checked")).toBe("false");
    expect(group.hasAttribute("aria-busy")).toBe(false);
    expect(ask.disabled).toBe(false);
  });

  it("closes from the explicit Done action without promise-result bookkeeping", () => {
    const modal = showStandardChatSettingsModal(new App(), {
      initialValues: {
        approvalMode: "full-access",
        chatFontSize: "large",
      },
      onChange: jest.fn(),
    });

    expect(document.body.contains(modal.modalEl)).toBe(true);
    const done = Array.from(modal.modalEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Done");
    done?.click();
    expect(document.body.contains(modal.modalEl)).toBe(false);
  });
});
