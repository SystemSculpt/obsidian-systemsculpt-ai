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
import { displayNotice, showActionNotice, showConfirm } from "../notifications";

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

  it("offers one action that dismisses the notice before it runs", () => {
    const button = document.createElement("button");
    const message = document.createElement("div");
    const fragment = {
      createDiv: jest.fn(({ cls, text }: { cls: string; text: string }) => {
        message.className = cls;
        message.textContent = text;
        return message;
      }),
      createEl: jest.fn((tag: string, { cls, text, attr }: { cls: string; text: string; attr: Record<string, string> }) => {
        expect(tag).toBe("button");
        button.className = cls;
        button.textContent = text;
        for (const [name, value] of Object.entries(attr)) button.setAttribute(name, value);
        return button;
      }),
    };
    jest.spyOn(document, "createDocumentFragment").mockReturnValue(fragment as any);
    const hide = jest.fn();
    (Notice as unknown as jest.Mock).mockImplementation(function (this: { hide: () => void }) {
      this.hide = hide;
    });
    const onSelect = jest.fn(() => expect(hide).toHaveBeenCalledTimes(1));

    showActionNotice("SystemSculpt 6.6.2 is available.", { label: "Open plugin updates", onSelect });

    expect(Notice).toHaveBeenCalledWith(fragment, 10_000);
    expect(message.textContent).toBe("SystemSculpt 6.6.2 is available.");
    expect(button.textContent).toBe("Open plugin updates");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.dataset.testid).toBe("notice.action");
    expect(onSelect).not.toHaveBeenCalled();
    button.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
