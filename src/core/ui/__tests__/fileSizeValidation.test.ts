/**
 * @jest-environment node
 */
import type { App } from "obsidian";

// Mock showPrompt
jest.mock("../modals/PromptModal", () => ({
  showPrompt: jest.fn().mockResolvedValue({ confirmed: true }),
}));

import { MAX_FILE_SIZE } from "../../../utils/FileValidator";
import { validateBrowserFileSize } from "../fileSizeValidation";
import { showPrompt } from "../modals/PromptModal";

describe("validateBrowserFileSize", () => {
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = {} as App;
  });

  it("returns true for small files", async () => {
    const mockFile = { name: "small.txt", size: 1000 } as File;

    const result = await validateBrowserFileSize(mockFile, mockApp);

    expect(result).toBe(true);
    expect(showPrompt).not.toHaveBeenCalled();
  });

  it("returns false for files exceeding max size", async () => {
    const mockFile = { name: "large.txt", size: MAX_FILE_SIZE + 1 } as File;

    const result = await validateBrowserFileSize(mockFile, mockApp);

    expect(result).toBe(false);
    expect(showPrompt).toHaveBeenCalledWith(
      mockApp,
      expect.stringContaining("large.txt"),
      expect.objectContaining({ title: "File Size Limit Exceeded" }),
    );
  });

  it("returns true for files at exactly max size", async () => {
    const mockFile = { name: "exact.txt", size: MAX_FILE_SIZE } as File;

    const result = await validateBrowserFileSize(mockFile, mockApp);

    expect(result).toBe(true);
    expect(showPrompt).not.toHaveBeenCalled();
  });

  it("shows popup with description for too large files", async () => {
    const mockFile = { name: "huge.txt", size: 600 * 1024 * 1024 } as File;

    await validateBrowserFileSize(mockFile, mockApp);

    expect(showPrompt).toHaveBeenCalledWith(
      mockApp,
      expect.stringContaining("600.0 MiB"),
      expect.objectContaining({
        description: "Please reduce the file size or choose a smaller file.",
        primaryButton: "OK",
      }),
    );
  });

  it("supports custom max size for browser files", async () => {
    const mockFile = { name: "browser.txt", size: 2048 } as File;

    await validateBrowserFileSize(mockFile, mockApp, {
      maxBytes: 1024,
      maxLabel: "1 KB",
      title: "Custom Limit",
      description: "Custom description",
    });

    expect(showPrompt).toHaveBeenCalledWith(
      mockApp,
      expect.stringContaining("maximum allowed size is 1 KB"),
      expect.objectContaining({ title: "Custom Limit", description: "Custom description" }),
    );
  });

  it("propagates a failed prompt instead of admitting an oversized file", async () => {
    const failure = new Error("Prompt unavailable");
    jest.mocked(showPrompt).mockRejectedValueOnce(failure);

    await expect(validateBrowserFileSize(
      { name: "large.txt", size: MAX_FILE_SIZE + 1 } as File,
      mockApp,
    )).rejects.toBe(failure);
  });
});
