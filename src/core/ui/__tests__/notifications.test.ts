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
import { flashButtonResult, showActionNotice, showConfirm } from "../notifications";

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

describe("flashButtonResult", () => {
  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = "";
  });

  it("shows the result on a text button, then restores its label once", () => {
    jest.useFakeTimers();
    const button = document.body.createEl("button", { text: "Copy error" });

    flashButtonResult(button, "Copied");
    expect(button.textContent).toBe("Copied");
    jest.advanceTimersByTime(1_000);
    flashButtonResult(button, "Copied");
    jest.advanceTimersByTime(1_000);
    expect(button.textContent).toBe("Copied");
    jest.advanceTimersByTime(500);
    expect(button.textContent).toBe("Copy error");
  });

  it("changes only the label of a shared surface action, keeping its icon", () => {
    jest.useFakeTimers();
    const button = document.body.createEl("button");
    const icon = button.createSpan({ cls: "ss-button__icon" });
    const label = button.createSpan({ cls: "ss-button__label", text: "Copy paths" });

    flashButtonResult(button, "Copied");
    expect(label.textContent).toBe("Copied");
    expect(icon.isConnected).toBe(true);
    jest.runAllTimers();
    expect(label.textContent).toBe("Copy paths");
  });
});
