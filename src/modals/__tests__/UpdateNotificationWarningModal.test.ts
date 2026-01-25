/**
 * @jest-environment jsdom
 */
import { App, Setting } from "obsidian";
import {
  UpdateNotificationWarningModal,
  UpdateNotificationWarningResult,
} from "../UpdateNotificationWarningModal";

describe("UpdateNotificationWarningModal", () => {
  let app: App;
  let modal: UpdateNotificationWarningModal;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new App();
    modal = new UpdateNotificationWarningModal(app);
  });

  describe("initialization", () => {
    it("creates modal with app", () => {
      expect(modal).toBeDefined();
    });

    it("has result default to not confirmed", () => {
      expect((modal as any).result).toEqual({ confirmed: false });
    });
  });

  describe("onOpen", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("creates header with icon", () => {
      const header = modal.contentEl.querySelector(".modal-header");
      expect(header).not.toBeNull();

      const icon = header?.querySelector(".modal-header-icon");
      expect(icon).not.toBeNull();
    });

    it("creates title", () => {
      const title = modal.contentEl.querySelector(".modal-title");
      expect(title?.textContent).toBe("Disable Update Notifications");
    });

    it("creates warning message content", () => {
      const content = modal.contentEl.querySelector(".modal-content");
      expect(content).not.toBeNull();
      expect(content?.innerHTML).toContain("Warning:");
      expect(content?.innerHTML).toContain("Security fixes");
    });

    it("includes list of update benefits", () => {
      const ul = modal.contentEl.querySelector("ul");
      expect(ul).not.toBeNull();

      const items = ul?.querySelectorAll("li");
      expect(items?.length).toBeGreaterThanOrEqual(4);
    });

    it("creates button container", () => {
      const container = modal.contentEl.querySelector(".modal-button-container");
      expect(container).not.toBeNull();
    });

    it("clears content on open", () => {
      modal.contentEl.createDiv({ text: "old content" });
      modal.onOpen();

      expect(modal.contentEl.textContent).not.toContain("old content");
    });
  });

  describe("result interface", () => {
    it("matches UpdateNotificationWarningResult type", () => {
      const result: UpdateNotificationWarningResult = {
        confirmed: true,
      };
      expect(result.confirmed).toBe(true);
    });

    it("can be false", () => {
      const result: UpdateNotificationWarningResult = {
        confirmed: false,
      };
      expect(result.confirmed).toBe(false);
    });
  });

  describe("onClose", () => {
    it("resolves with the result", () => {
      const mockResolve = jest.fn();
      (modal as any).resolve = mockResolve;
      (modal as any).result = { confirmed: true };

      modal.onClose();

      expect(mockResolve).toHaveBeenCalledWith({ confirmed: true });
    });
  });

  describe("icon styling", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("adds warning class to icon", () => {
      const icon = modal.contentEl.querySelector(".modal-header-icon");
      expect(icon?.classList.contains("ss-modal-icon--warning")).toBe(true);
    });

    it("contains SVG icon", () => {
      const icon = modal.contentEl.querySelector(".modal-header-icon");
      const svg = icon?.querySelector("svg");
      expect(svg).not.toBeNull();
    });
  });
});
