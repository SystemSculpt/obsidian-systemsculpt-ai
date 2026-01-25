/** @jest-environment jsdom */
import { describe, expect, it, jest } from "@jest/globals";
import { App } from "obsidian";
import { QuickEditWidget } from "../QuickEditWidget";

describe("QuickEditWidget keyboard shortcuts", () => {
  it("submits on Enter when prompt textarea is focused", () => {
    const app = new App();
    const plugin = {} as any;
    const widget = new QuickEditWidget(app as any, plugin);
    const submitSpy = jest.spyOn(widget as any, "submit").mockResolvedValue(undefined);

    const container = document.createElement("div");
    (widget as any).createContent(container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not submit on Shift+Enter (allows newline)", () => {
    const app = new App();
    const plugin = {} as any;
    const widget = new QuickEditWidget(app as any, plugin);
    const submitSpy = jest.spyOn(widget as any, "submit").mockResolvedValue(undefined);

    const container = document.createElement("div");
    (widget as any).createContent(container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(submitSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("creates missing parent folders before applying a move operation", async () => {
    const app = new App();
    const plugin = {} as any;
    const widget = new QuickEditWidget(app as any, plugin);

    const existingFolders = new Set<string>();
    const file = { path: "Source.md" } as any;

    (app as any).vault.getAbstractFileByPath = jest.fn((path: string) => {
      if (path === "Source.md") return file;
      if (existingFolders.has(path)) return { path } as any;
      return null;
    });

    (app as any).vault.createFolder = jest.fn(async (path: string) => {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent && !existingFolders.has(parent)) {
        throw new Error(`Missing parent folder: ${parent}`);
      }
      existingFolders.add(path);
      return { path } as any;
    });

    (app as any).fileManager = {
      renameFile: jest.fn(async () => {}),
    };

    (widget as any).previewFilePath = "Source.md";
    (widget as any).pendingDiffStats = null;
    (widget as any).pendingMoveOp = { source: "Source.md", destination: "A/B/Dest.md" };

    await (widget as any).applyAllPendingEdits();

    expect((app as any).vault.createFolder).toHaveBeenCalledWith("A");
    expect((app as any).vault.createFolder).toHaveBeenCalledWith("A/B");
    expect((app as any).fileManager.renameFile).toHaveBeenCalledWith(file, "A/B/Dest.md");
  });

  it("does not log Quick Edit controller events to console.info", () => {
    const app = new App();
    const plugin = {} as any;
    const widget = new QuickEditWidget(app as any, plugin);
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});

    try {
      (widget as any).controller.events.emit("activity", { type: "thinking" });
      (widget as any).controller.events.emit("preview", { toolCalls: [] });

      const container = document.createElement("div");
      (widget as any).createContent(container);
      (widget as any).renderProposalSummary();

      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });
});
