/**
 * @jest-environment jsdom
 */
import { tryCopyToClipboard } from "../clipboard";
import { tryCopyImageFileToClipboard } from "../clipboard";

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

  describe("tryCopyImageFileToClipboard", () => {
    const originalGlobalRequire = (global as any).require;
    const originalWindowRequire = (window as any).require;

    const makeFile = (extension: string) =>
      ({
        extension,
      }) as any;

    const makeApp = (bytes: ArrayBuffer) =>
      ({
        vault: {
          readBinary: jest.fn().mockResolvedValue(bytes),
        },
      }) as any;

    afterEach(() => {
      delete (global as any).ClipboardItem;
      if (typeof originalGlobalRequire === "undefined") {
        delete (global as any).require;
      } else {
        (global as any).require = originalGlobalRequire;
      }
      if (typeof originalWindowRequire === "undefined") {
        delete (window as any).require;
      } else {
        (window as any).require = originalWindowRequire;
      }
    });

    it("writes PNG image data to clipboard", async () => {
      const write = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { write },
        writable: true,
        configurable: true,
      });

      const clipboardItems: any[] = [];
      (global as any).ClipboardItem = class {
        data: Record<string, Blob>;
        constructor(data: Record<string, Blob>) {
          this.data = data;
          clipboardItems.push(this);
        }
      };

      const app = makeApp(new Uint8Array([1, 2, 3]).buffer);
      const file = makeFile("png");

      const result = await tryCopyImageFileToClipboard(app, file);

      expect(result).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      expect(clipboardItems).toHaveLength(1);
      expect(Object.keys(clipboardItems[0].data)).toEqual(["image/png"]);
      expect(clipboardItems[0].data["image/png"]).toBeInstanceOf(Blob);
      expect(clipboardItems[0].data["image/png"].type).toBe("image/png");
    });

    it("maps JPG to image/jpeg", async () => {
      const write = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { write },
        writable: true,
        configurable: true,
      });

      let capturedData: Record<string, Blob> | null = null;
      (global as any).ClipboardItem = class {
        constructor(data: Record<string, Blob>) {
          capturedData = data;
        }
      };

      const app = makeApp(new Uint8Array([7]).buffer);
      const file = makeFile("jpg");

      const result = await tryCopyImageFileToClipboard(app, file);

      expect(result).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      expect(capturedData).not.toBeNull();
      expect(Object.keys(capturedData!)).toEqual(["image/jpeg"]);
    });

    it("returns false when ClipboardItem is unavailable", async () => {
      const write = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { write },
        writable: true,
        configurable: true,
      });

      const app = makeApp(new Uint8Array([1]).buffer);
      const file = makeFile("png");

      const result = await tryCopyImageFileToClipboard(app, file);

      expect(result).toBe(false);
      expect(write).not.toHaveBeenCalled();
    });

    it("returns false when clipboard write fails", async () => {
      const write = jest.fn().mockRejectedValue(new Error("denied"));
      Object.defineProperty(navigator, "clipboard", {
        value: { write },
        writable: true,
        configurable: true,
      });

      (global as any).ClipboardItem = class {
        constructor(_data: Record<string, Blob>) {}
      };

      const app = makeApp(new Uint8Array([1]).buffer);
      const file = makeFile("png");

      const result = await tryCopyImageFileToClipboard(app, file);

      expect(result).toBe(false);
      expect(write).toHaveBeenCalledTimes(1);
    });

    it("falls back to electron clipboard when web clipboard write fails", async () => {
      const write = jest.fn().mockRejectedValue(new Error("denied"));
      Object.defineProperty(navigator, "clipboard", {
        value: { write },
        writable: true,
        configurable: true,
      });

      (global as any).ClipboardItem = class {
        constructor(_data: Record<string, Blob>) {}
      };

      const createFromDataURL = jest.fn().mockReturnValue({
        isEmpty: () => false,
      });
      const writeImage = jest.fn();
      const mockRequire = jest.fn().mockImplementation((mod: string) => {
        if (mod !== "electron") throw new Error("unexpected module");
        return {
          clipboard: { writeImage },
          nativeImage: { createFromDataURL },
        };
      });
      (global as any).require = mockRequire;
      (window as any).require = mockRequire;

      const app = makeApp(new Uint8Array([1, 2, 3]).buffer);
      const file = makeFile("png");

      const result = await tryCopyImageFileToClipboard(app, file);

      expect(result).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      expect(createFromDataURL).toHaveBeenCalledTimes(1);
      expect(writeImage).toHaveBeenCalledTimes(1);
    });

    it("returns false for unsupported file extension", async () => {
      const write = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { write },
        writable: true,
        configurable: true,
      });

      (global as any).ClipboardItem = class {
        constructor(_data: Record<string, Blob>) {}
      };

      const app = makeApp(new Uint8Array([1]).buffer);
      const file = makeFile("heic");

      const result = await tryCopyImageFileToClipboard(app, file);

      expect(result).toBe(false);
      expect(write).not.toHaveBeenCalled();
    });
  });
});
