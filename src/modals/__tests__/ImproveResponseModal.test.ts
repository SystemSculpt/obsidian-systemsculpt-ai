/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { ImproveResponseModal } from "../ImproveResponseModal";

describe("ImproveResponseModal", () => {
  let app: App;
  let onSubmit: jest.Mock;
  let modal: ImproveResponseModal;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new App();
    onSubmit = jest.fn();
    modal = new ImproveResponseModal(app, "Prompt text", "default value", onSubmit);
  });

  describe("initialization", () => {
    it("stores prompt text", () => {
      expect((modal as any).promptText).toBe("Prompt text");
    });

    it("stores default value", () => {
      expect((modal as any).defaultValue).toBe("default value");
    });

    it("stores onSubmit callback", () => {
      expect((modal as any).onSubmit).toBe(onSubmit);
    });
  });

  describe("onOpen", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("creates title element", () => {
      const h2 = modal.contentEl.querySelector("h2");
      expect(h2?.textContent).toBe("Improve Response");
    });

    it("creates prompt text paragraph", () => {
      const p = modal.contentEl.querySelector("p");
      expect(p?.textContent).toBe("Prompt text");
    });

    it("creates preset buttons", () => {
      const buttons = modal.contentEl.querySelectorAll("button");
      // 5 presets + cancel + confirm = 7 buttons
      expect(buttons.length).toBe(7);
    });

    it("includes Shorter preset button", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const shorterBtn = buttons.find((b) => b.textContent === "Shorter");
      expect(shorterBtn).toBeDefined();
    });

    it("includes Longer preset button", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const longerBtn = buttons.find((b) => b.textContent === "Longer");
      expect(longerBtn).toBeDefined();
    });

    it("includes Simpler preset button", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const simplerBtn = buttons.find((b) => b.textContent === "Simpler");
      expect(simplerBtn).toBeDefined();
    });

    it("includes More professional preset button", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const profBtn = buttons.find((b) => b.textContent === "More professional");
      expect(profBtn).toBeDefined();
    });

    it("includes More creative preset button", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const creativeBtn = buttons.find((b) => b.textContent === "More creative");
      expect(creativeBtn).toBeDefined();
    });

    it("creates input element", () => {
      const input = modal.contentEl.querySelector("input");
      expect(input).not.toBeNull();
    });

    it("sets input default value", () => {
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      expect(input.value).toBe("default value");
    });

    it("creates cancel button", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      expect(cancelBtn).toBeDefined();
    });

    it("creates improve button", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const improveBtn = buttons.find((b) => b.textContent === "Improve");
      expect(improveBtn).toBeDefined();
    });
  });

  describe("preset button interaction", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("clicking preset button sets input value", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const shorterBtn = buttons.find((b) => b.textContent === "Shorter");
      shorterBtn?.click();

      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      expect(input.value).toBe("Shorter");
    });

    it("clicking different preset updates input value", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;

      const longerBtn = buttons.find((b) => b.textContent === "Longer");
      longerBtn?.click();
      expect(input.value).toBe("Longer");

      const creativeBtn = buttons.find((b) => b.textContent === "More creative");
      creativeBtn?.click();
      expect(input.value).toBe("More creative");
    });
  });

  describe("form submission", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("calls onSubmit with input value when improve button clicked", () => {
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      input.value = "Make it concise";

      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const improveBtn = buttons.find((b) => b.textContent === "Improve");
      improveBtn?.click();

      expect(onSubmit).toHaveBeenCalledWith("Make it concise");
    });

    it("does not call onSubmit when input is empty", () => {
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      input.value = "";

      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const improveBtn = buttons.find((b) => b.textContent === "Improve");
      improveBtn?.click();

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not call onSubmit when input is whitespace only", () => {
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      input.value = "   ";

      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const improveBtn = buttons.find((b) => b.textContent === "Improve");
      improveBtn?.click();

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("trims input value before submitting", () => {
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      input.value = "  trimmed value  ";

      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const improveBtn = buttons.find((b) => b.textContent === "Improve");
      improveBtn?.click();

      expect(onSubmit).toHaveBeenCalledWith("trimmed value");
    });

    it("closes modal on successful submit", () => {
      const closeSpy = jest.spyOn(modal, "close");
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      input.value = "test";

      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const improveBtn = buttons.find((b) => b.textContent === "Improve");
      improveBtn?.click();

      expect(closeSpy).toHaveBeenCalled();
    });
  });

  describe("cancel button", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("closes modal when cancel clicked", () => {
      const closeSpy = jest.spyOn(modal, "close");
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      cancelBtn?.click();

      expect(closeSpy).toHaveBeenCalled();
    });

    it("does not call onSubmit when cancel clicked", () => {
      const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      cancelBtn?.click();

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("keyboard interactions", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("submits on Enter key in input", () => {
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      input.value = "keyboard submit";

      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      });
      input.dispatchEvent(enterEvent);

      expect(onSubmit).toHaveBeenCalledWith("keyboard submit");
    });

    it("does not submit on Enter when composing (IME)", () => {
      const input = modal.contentEl.querySelector("input") as HTMLInputElement;
      input.value = "composing text";

      // Create event with isComposing = true
      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      });
      Object.defineProperty(enterEvent, "isComposing", { value: true });
      input.dispatchEvent(enterEvent);

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("onClose", () => {
    it("empties content", () => {
      modal.onOpen();
      modal.onClose();

      expect(modal.contentEl.children.length).toBe(0);
    });

    it("removes global key handler", () => {
      modal.onOpen();
      const handler = (modal as any)._globalKeyHandler;
      expect(handler).toBeDefined();

      const removeSpy = jest.spyOn(document, "removeEventListener");
      modal.onClose();

      expect(removeSpy).toHaveBeenCalledWith("keydown", handler);
    });
  });
});
