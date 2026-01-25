/**
 * @jest-environment jsdom
 */
import { App, Notice } from "obsidian";

// Mock obsidian
jest.mock("obsidian", () => ({
  App: jest.fn(),
  Notice: jest.fn(),
}));

// Mock showPopup
jest.mock("../modals/PopupModal", () => ({
  showPopup: jest.fn(),
}));

import { showPopup } from "../modals/PopupModal";
import {
  showAlert,
  showConfirm,
  displayNotice,
  initializeNotificationQueue,
  showNoticeWhenReady,
} from "../notifications";

describe("notifications", () => {
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock app with workspace
    mockApp = {
      workspace: {
        onLayoutReady: jest.fn(),
      },
    } as unknown as App;
  });

  describe("showAlert", () => {
    beforeEach(() => {
      (showPopup as jest.Mock).mockResolvedValue({ confirmed: true });
    });

    it("shows alert popup with default options", async () => {
      await showAlert(mockApp, "Test alert");

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Test alert", {
        title: "Alert",
        primaryButton: "OK",
        secondaryButton: undefined,
        icon: "info",
      });
    });

    it("uses error styling for error type", async () => {
      await showAlert(mockApp, "Error message", { type: "error" });

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Error message", {
        title: "Error",
        primaryButton: "OK",
        secondaryButton: undefined,
        icon: "alert-circle",
      });
    });

    it("uses warning styling for warning type", async () => {
      await showAlert(mockApp, "Warning message", { type: "warning" });

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Warning message", {
        title: "Warning",
        primaryButton: "OK",
        secondaryButton: undefined,
        icon: "alert-triangle",
      });
    });

    it("uses custom title when provided", async () => {
      await showAlert(mockApp, "Test message", { title: "Custom Title" });

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Test message", expect.objectContaining({
        title: "Custom Title",
      }));
    });

    it("uses custom primary button", async () => {
      await showAlert(mockApp, "Test", { primaryButton: "Got it" });

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Test", expect.objectContaining({
        primaryButton: "Got it",
      }));
    });

    it("includes secondary button when provided", async () => {
      await showAlert(mockApp, "Test", { secondaryButton: "Cancel" });

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Test", expect.objectContaining({
        secondaryButton: "Cancel",
      }));
    });

    it("returns confirmed status when user confirms", async () => {
      (showPopup as jest.Mock).mockResolvedValue({ confirmed: true });

      const result = await showAlert(mockApp, "Test");

      expect(result.confirmed).toBe(true);
    });

    it("returns false when user cancels", async () => {
      (showPopup as jest.Mock).mockResolvedValue({ confirmed: false });

      const result = await showAlert(mockApp, "Test");

      expect(result.confirmed).toBe(false);
    });

    it("handles null popup result", async () => {
      (showPopup as jest.Mock).mockResolvedValue(null);

      const result = await showAlert(mockApp, "Test");

      expect(result.confirmed).toBe(false);
    });

    it("handles undefined popup result", async () => {
      (showPopup as jest.Mock).mockResolvedValue(undefined);

      const result = await showAlert(mockApp, "Test");

      expect(result.confirmed).toBe(false);
    });
  });

  describe("showConfirm", () => {
    beforeEach(() => {
      (showPopup as jest.Mock).mockResolvedValue({ confirmed: false });
    });

    it("shows confirm popup with default options", async () => {
      await showConfirm(mockApp, "Are you sure?");

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Are you sure?", {
        title: "Confirm Action",
        primaryButton: "Confirm",
        secondaryButton: "Cancel",
        icon: "help-circle",
      });
    });

    it("uses custom buttons when provided", async () => {
      await showConfirm(mockApp, "Delete?", {
        primaryButton: "Delete",
        secondaryButton: "Keep",
      });

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Delete?", expect.objectContaining({
        primaryButton: "Delete",
        secondaryButton: "Keep",
      }));
    });

    it("uses custom title when provided", async () => {
      await showConfirm(mockApp, "Test", { title: "Custom Confirm" });

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Test", expect.objectContaining({
        title: "Custom Confirm",
      }));
    });

    it("uses custom icon when provided", async () => {
      await showConfirm(mockApp, "Test", { icon: "trash" });

      expect(showPopup).toHaveBeenCalledWith(mockApp, "Test", expect.objectContaining({
        icon: "trash",
      }));
    });

    it("returns false when user cancels", async () => {
      (showPopup as jest.Mock).mockResolvedValue({ confirmed: false });

      const result = await showConfirm(mockApp, "Test");

      expect(result.confirmed).toBe(false);
    });

    it("returns true when user confirms", async () => {
      (showPopup as jest.Mock).mockResolvedValue({ confirmed: true });

      const result = await showConfirm(mockApp, "Test");

      expect(result.confirmed).toBe(true);
    });

    it("handles null result", async () => {
      (showPopup as jest.Mock).mockResolvedValue(null);

      const result = await showConfirm(mockApp, "Test");

      expect(result.confirmed).toBe(false);
    });
  });

  describe("displayNotice", () => {
    let mockFragment: any;
    let mockDivs: any[];

    beforeEach(() => {
      mockDivs = [];
      mockFragment = {
        createDiv: jest.fn(({ cls }: { cls: string }) => {
          const div = { cls, setText: jest.fn(), text: "" };
          div.setText = (text: string) => { div.text = text; };
          mockDivs.push(div);
          return div;
        }),
      };

      jest.spyOn(document, "createDocumentFragment").mockReturnValue(mockFragment as any);
    });

    it("creates notice with title", () => {
      displayNotice(mockApp, { title: "Test Title" });

      expect(mockFragment.createDiv).toHaveBeenCalledWith({ cls: "systemsculpt-notice-title" });
      expect(mockDivs[0].text).toBe("Test Title");
      expect(Notice).toHaveBeenCalledWith(mockFragment, 5000);
    });

    it("includes path when provided", () => {
      displayNotice(mockApp, { title: "Title", path: "path/to/file.md" });

      expect(mockFragment.createDiv).toHaveBeenCalledWith({ cls: "systemsculpt-notice-path" });
      expect(mockDivs.some((d: any) => d.text === "path/to/file.md")).toBe(true);
    });

    it("includes message when provided", () => {
      displayNotice(mockApp, { title: "Title", message: "Additional info" });

      expect(mockFragment.createDiv).toHaveBeenCalledWith({ cls: "systemsculpt-notice-message" });
      expect(mockDivs.some((d: any) => d.text === "Additional info")).toBe(true);
    });

    it("uses custom duration when provided", () => {
      displayNotice(mockApp, { title: "Title" }, { duration: 10000 });

      expect(Notice).toHaveBeenCalledWith(mockFragment, 10000);
    });

    it("uses default duration of 5000ms", () => {
      displayNotice(mockApp, { title: "Title" });

      expect(Notice).toHaveBeenCalledWith(mockFragment, 5000);
    });

    it("creates all elements when all parts provided", () => {
      displayNotice(mockApp, {
        title: "Title",
        path: "path/to/file.md",
        message: "Message",
      });

      expect(mockFragment.createDiv).toHaveBeenCalledTimes(3);
    });

    it("skips path element when not provided", () => {
      displayNotice(mockApp, { title: "Title", message: "Message" });

      expect(mockFragment.createDiv).toHaveBeenCalledTimes(2);
      expect(mockFragment.createDiv).not.toHaveBeenCalledWith({ cls: "systemsculpt-notice-path" });
    });

    it("skips message element when not provided", () => {
      displayNotice(mockApp, { title: "Title", path: "path.md" });

      expect(mockFragment.createDiv).toHaveBeenCalledTimes(2);
      expect(mockFragment.createDiv).not.toHaveBeenCalledWith({ cls: "systemsculpt-notice-message" });
    });
  });

  describe("initializeNotificationQueue", () => {
    let onLayoutReadyCallback: (() => void) | null = null;

    beforeEach(() => {
      onLayoutReadyCallback = null;
      mockApp = {
        workspace: {
          onLayoutReady: jest.fn((callback: () => void) => {
            onLayoutReadyCallback = callback;
          }),
        },
      } as unknown as App;
    });

    it("registers onLayoutReady callback", () => {
      initializeNotificationQueue(mockApp);

      expect(mockApp.workspace.onLayoutReady).toHaveBeenCalled();
    });

    it("shows pending notices when layout is ready", () => {
      // Queue a notice before initialization
      showNoticeWhenReady(mockApp, "Pending message");

      // Initialize - this queues the layout callback
      initializeNotificationQueue(mockApp);

      // Trigger layout ready
      if (onLayoutReadyCallback) {
        onLayoutReadyCallback();
      }

      // Notice should have been shown
      expect(Notice).toHaveBeenCalledWith("Pending message", 4000);
    });

    it("uses custom duration for pending notices", () => {
      showNoticeWhenReady(mockApp, "Custom duration", { duration: 8000 });

      initializeNotificationQueue(mockApp);
      if (onLayoutReadyCallback) {
        onLayoutReadyCallback();
      }

      expect(Notice).toHaveBeenCalledWith("Custom duration", 8000);
    });
  });

  describe("showNoticeWhenReady", () => {
    it("shows notice immediately after UI is ready", () => {
      let onLayoutReadyCallback: (() => void) | null = null;
      mockApp = {
        workspace: {
          onLayoutReady: jest.fn((callback: () => void) => {
            onLayoutReadyCallback = callback;
          }),
        },
      } as unknown as App;

      // Initialize and trigger layout ready
      initializeNotificationQueue(mockApp);
      if (onLayoutReadyCallback) {
        onLayoutReadyCallback();
      }

      // Clear previous calls
      (Notice as jest.Mock).mockClear();

      // Now showNoticeWhenReady should show immediately
      showNoticeWhenReady(mockApp, "Immediate message");

      expect(Notice).toHaveBeenCalledWith("Immediate message", 4000);
    });

    it("uses default duration of 4000ms when not specified", () => {
      let onLayoutReadyCallback: (() => void) | null = null;
      mockApp = {
        workspace: {
          onLayoutReady: jest.fn((callback: () => void) => {
            onLayoutReadyCallback = callback;
          }),
        },
      } as unknown as App;

      initializeNotificationQueue(mockApp);
      if (onLayoutReadyCallback) {
        onLayoutReadyCallback();
      }
      (Notice as jest.Mock).mockClear();

      showNoticeWhenReady(mockApp, "Test");

      expect(Notice).toHaveBeenCalledWith("Test", 4000);
    });

    it("uses custom duration when provided", () => {
      let onLayoutReadyCallback: (() => void) | null = null;
      mockApp = {
        workspace: {
          onLayoutReady: jest.fn((callback: () => void) => {
            onLayoutReadyCallback = callback;
          }),
        },
      } as unknown as App;

      initializeNotificationQueue(mockApp);
      if (onLayoutReadyCallback) {
        onLayoutReadyCallback();
      }
      (Notice as jest.Mock).mockClear();

      showNoticeWhenReady(mockApp, "Test", { duration: 10000 });

      expect(Notice).toHaveBeenCalledWith("Test", 10000);
    });
  });
});
