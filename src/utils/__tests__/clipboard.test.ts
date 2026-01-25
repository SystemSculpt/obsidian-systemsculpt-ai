/**
 * @jest-environment jsdom
 */
import { tryCopyToClipboard } from "../clipboard";

describe("clipboard", () => {
  describe("tryCopyToClipboard", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("uses navigator.clipboard.writeText when available", async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const result = await tryCopyToClipboard("test text");

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith("test text");
    });

    it("falls back to execCommand when clipboard API fails", async () => {
      const writeText = jest.fn().mockRejectedValue(new Error("Not allowed"));
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const execCommand = jest.fn().mockReturnValue(true);
      document.execCommand = execCommand;

      const result = await tryCopyToClipboard("fallback text");

      expect(result).toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
    });

    it("uses execCommand when navigator.clipboard is undefined", async () => {
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const execCommand = jest.fn().mockReturnValue(true);
      document.execCommand = execCommand;

      const result = await tryCopyToClipboard("no clipboard api");

      expect(result).toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
    });

    it("returns false when both methods fail", async () => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: jest.fn().mockRejectedValue(new Error("fail")) },
        writable: true,
        configurable: true,
      });

      document.execCommand = jest.fn().mockImplementation(() => {
        throw new Error("execCommand failed");
      });

      const result = await tryCopyToClipboard("fail text");

      expect(result).toBe(false);
    });

    it("returns false when execCommand returns false", async () => {
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        writable: true,
        configurable: true,
      });

      document.execCommand = jest.fn().mockReturnValue(false);

      const result = await tryCopyToClipboard("unsupported");

      expect(result).toBe(false);
    });

    it("creates and removes textarea element for fallback", async () => {
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const appendChildSpy = jest.spyOn(document.body, "appendChild");
      const removeChildSpy = jest.spyOn(document.body, "removeChild");

      document.execCommand = jest.fn().mockReturnValue(true);

      await tryCopyToClipboard("textarea text");

      expect(appendChildSpy).toHaveBeenCalled();
      expect(removeChildSpy).toHaveBeenCalled();

      // Check textarea was created with correct value
      const appendedElement = appendChildSpy.mock.calls[0][0] as HTMLTextAreaElement;
      expect(appendedElement.tagName).toBe("TEXTAREA");
      expect(appendedElement.value).toBe("textarea text");

      appendChildSpy.mockRestore();
      removeChildSpy.mockRestore();
    });

    it("sets textarea style for invisibility", async () => {
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const appendChildSpy = jest.spyOn(document.body, "appendChild");
      document.execCommand = jest.fn().mockReturnValue(true);

      await tryCopyToClipboard("styled textarea");

      const appendedElement = appendChildSpy.mock.calls[0][0] as HTMLTextAreaElement;
      expect(appendedElement.style.position).toBe("fixed");
      expect(appendedElement.style.opacity).toBe("0");
      expect(appendedElement.getAttribute("readonly")).toBe("");

      appendChildSpy.mockRestore();
    });

    it("handles empty string", async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const result = await tryCopyToClipboard("");

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith("");
    });

    it("handles special characters", async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const specialText = "Hello\nWorld\t<script>alert('test')</script>";
      const result = await tryCopyToClipboard(specialText);

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith(specialText);
    });

    it("handles unicode characters", async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const unicodeText = "你好世界 🎉 مرحبا";
      const result = await tryCopyToClipboard(unicodeText);

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith(unicodeText);
    });
  });
});
