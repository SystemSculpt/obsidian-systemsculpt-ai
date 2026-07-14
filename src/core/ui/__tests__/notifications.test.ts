/**
 * @jest-environment jsdom
 */
import { App, Notice } from "obsidian";

jest.mock("obsidian", () => ({
  App: jest.fn(),
  Notice: jest.fn(),
}));

jest.mock("../modals/PromptModal", () => ({
  showPrompt: jest.fn(),
}));

import { showPrompt } from "../modals/PromptModal";
import { displayNotice, showConfirm } from "../notifications";

describe("notifications", () => {
  const app = {} as App;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("delegates confirmation to the shared prompt surface", async () => {
    (showPrompt as jest.Mock).mockResolvedValue({ confirmed: true });

    await expect(showConfirm(app, "Delete?", {
      title: "Delete file",
      primaryButton: "Delete",
      secondaryButton: "Keep",
      icon: "trash",
    })).resolves.toEqual({ confirmed: true });

    expect(showPrompt).toHaveBeenCalledWith(app, "Delete?", {
      title: "Delete file",
      primaryButton: "Delete",
      secondaryButton: "Keep",
      icon: "trash",
    });
  });

  it("treats a dismissed prompt as unconfirmed", async () => {
    (showPrompt as jest.Mock).mockResolvedValue(null);
    await expect(showConfirm(app, "Continue?")).resolves.toEqual({ confirmed: false });
  });

  it("renders a structured notice in the active surface realm", () => {
    const nodes: Array<{ cls: string; text: string }> = [];
    const fragment = {
      createDiv: jest.fn(({ cls }: { cls: string }) => {
        const node = {
          cls,
          text: "",
          setText(text: string) {
            this.text = text;
          },
        };
        nodes.push(node);
        return node;
      }),
    };
    jest.spyOn(document, "createDocumentFragment").mockReturnValue(fragment as any);

    displayNotice({
      title: "Opened in new tab",
      path: "Notes/Example.md",
      message: "Added to the current pane.",
    }, { duration: 8_000 });

    expect(nodes).toEqual([
      { cls: "systemsculpt-notice-title", text: "Opened in new tab", setText: expect.any(Function) },
      { cls: "systemsculpt-notice-path", text: "Notes/Example.md", setText: expect.any(Function) },
      { cls: "systemsculpt-notice-message", text: "Added to the current pane.", setText: expect.any(Function) },
    ]);
    expect(Notice).toHaveBeenCalledWith(fragment, 8_000);
  });
});
