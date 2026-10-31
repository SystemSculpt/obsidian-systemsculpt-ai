/** @jest-environment jsdom */

import { App, Notice } from "obsidian";
import { attachFolderSuggester } from "../components/FolderSuggester";
import { displayDirectoriesTabContent } from "../settings/DirectoriesTabContent";
import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  Notice: jest.fn(),
}));

jest.mock("../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

const directoryKeys = [
  "chatsDirectory",
  "recordingsDirectory",
  "extractionsDirectory",
] as const;

const typeValue = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new Event("change"));
};

let renderedTabs: Set<SystemSculptSettingTab>;

const render = () => {
  const app = new App();
  const updateSettings = jest.fn().mockResolvedValue(undefined);
  const handleDirectorySettingChange = jest.fn().mockResolvedValue(undefined);
  const plugin = {
    settings: {
      chatsDirectory: "SystemSculpt/Chats",
      savedChatsDirectory: "SystemSculpt/Saved Chats",
      recordingsDirectory: "SystemSculpt/Recordings",
      attachmentsDirectory: "SystemSculpt/Attachments",
      extractionsDirectory: "SystemSculpt/Extractions",
    },
    getSettingsManager: jest.fn(() => ({ updateSettings })),
    checkDirectoryHealth: jest.fn(),
    repairDirectoryStructure: jest.fn().mockResolvedValue(true),
    directoryManager: { handleDirectorySettingChange },
  };
  const container = document.createElement("div");
  const tab = new SystemSculptSettingTab(app, plugin as never);
  renderedTabs.add(tab);
  displayDirectoriesTabContent(container, tab);
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]'));
  return { container, tab, inputs, updateSettings, handleDirectorySettingChange, plugin };
};

describe("Directories tab managed-only layout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    renderedTabs = new Set();
  });

  afterEach(() => {
    renderedTabs.forEach((tab) => tab.hide());
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it.each([
    [true, "No directory repair is needed. Output folders are created when files are saved."],
    [false, "An output path is blocked or inaccessible. Resolve the conflict or choose another directory."],
  ])("shows a repair result (%s) once, inline", async (repaired, expected) => {
    const { container, plugin } = render();
    plugin.repairDirectoryStructure.mockResolvedValue(repaired);
    const repair = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Repair")!;

    repair.click();
    await Promise.resolve();
    await Promise.resolve();

    const status = container.querySelector<HTMLElement>(".ss-inline-note[role='status']")!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe(expected);
    expect(plugin.repairDirectoryStructure).toHaveBeenCalledTimes(1);
    expect(Notice).not.toHaveBeenCalled();
  });

  it("shows only the output directories the plugin writes to", () => {
    const { container, inputs } = render();
    const names = Array.from(container.querySelectorAll(".setting-item-name"))
      .map((element) => element.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining([
      "Chats directory",
      "Recordings directory",
      "Extractions directory",
    ]));
    expect(inputs.map((input) => input.value)).toEqual([
      "SystemSculpt/Chats",
      "SystemSculpt/Recordings",
      "SystemSculpt/Extractions",
    ]);
    expect(names).not.toContain("Saved chats directory");
    expect(names).not.toContain("Attachments directory");
    expect(container.textContent).not.toContain("empty = Attachments");
    expect(names).not.toContain("Web Research Directory");
    expect(container.textContent).not.toContain("web search and fetch corpus files");
  });

  it.each(directoryKeys)("commits %s only on blur, never intermediate paths", async (key) => {
    const { inputs, updateSettings, handleDirectorySettingChange } = render();
    const input = inputs[directoryKeys.indexOf(key)];
    typeValue(input, "New");
    typeValue(input, "New/Final");
    jest.advanceTimersByTime(1000);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(handleDirectorySettingChange).not.toHaveBeenCalled();

    input.dispatchEvent(new Event("blur"));
    await Promise.resolve();
    expect(updateSettings.mock.calls).toEqual([[{ [key]: "New/Final" }]]);
    expect(handleDirectorySettingChange.mock.calls).toEqual([[key, "New/Final"]]);
    input.dispatchEvent(new Event("blur"));
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps typed directory drafts independent until each field blurs", async () => {
    const { inputs, updateSettings, handleDirectorySettingChange } = render();
    typeValue(inputs[0], "New/Chats");
    typeValue(inputs[1], "New/Recordings");
    inputs[1].dispatchEvent(new Event("blur"));
    await Promise.resolve();

    expect(updateSettings.mock.calls).toEqual([[{ recordingsDirectory: "New/Recordings" }]]);
    expect(handleDirectorySettingChange.mock.calls).toEqual([["recordingsDirectory", "New/Recordings"]]);
    inputs[0].dispatchEvent(new Event("blur"));
    await Promise.resolve();
    expect(updateSettings).toHaveBeenNthCalledWith(2, { chatsDirectory: "New/Chats" });
    expect(handleDirectorySettingChange).toHaveBeenNthCalledWith(2, "chatsDirectory", "New/Chats");
  });

  it.each(directoryKeys)("commits the chosen %s once, including the suggester's following blur", async (key) => {
    const { inputs, updateSettings, handleDirectorySettingChange } = render();
    const index = directoryKeys.indexOf(key);
    const input = inputs[index];
    typeValue(input, "Work/Pro");
    const selectFolder = jest.mocked(attachFolderSuggester).mock.calls[index][1];

    selectFolder("Work/Projects");
    input.dispatchEvent(new Event("blur"));
    await Promise.resolve();

    expect(input.value).toBe("Work/Projects");
    expect(updateSettings.mock.calls).toEqual([[{ [key]: "Work/Projects" }]]);
    expect(handleDirectorySettingChange.mock.calls).toEqual([[key, "Work/Projects"]]);
  });

  it.each(["hide", "rerender"])("flushes all directory drafts on %s without blur or timer saves", async (boundary) => {
    const { container, tab, inputs, updateSettings, handleDirectorySettingChange } = render();
    inputs.forEach((input, index) => {
      typeValue(input, "Work/Partial");
      typeValue(input, `Work/Final-${index}`);
    });
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10_000);
    expect(updateSettings).not.toHaveBeenCalled();

    if (boundary === "hide") tab.hide();
    else displayDirectoriesTabContent(container, tab);
    await Promise.resolve();

    expect(updateSettings.mock.calls).toEqual(directoryKeys.map((key, index) => [
      { [key]: `Work/Final-${index}` },
    ]));
    expect(handleDirectorySettingChange.mock.calls).toEqual(directoryKeys.map((key, index) => [
      key, `Work/Final-${index}`,
    ]));
    expect(jest.getTimerCount()).toBe(0);

    inputs.forEach((input, index) => {
      typeValue(input, "Detached/Draft");
      input.dispatchEvent(new Event("blur"));
      jest.mocked(attachFolderSuggester).mock.calls[index][1]("Detached/Selection");
    });
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(updateSettings).toHaveBeenCalledTimes(directoryKeys.length);
    expect(handleDirectorySettingChange).toHaveBeenCalledTimes(directoryKeys.length);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("preserves validation while flushing directory drafts on hide", async () => {
    const { tab, inputs, updateSettings, handleDirectorySettingChange } = render();
    typeValue(inputs[0], "../outside");
    typeValue(inputs[1], "Work/Recordings");

    tab.hide();
    await Promise.resolve();

    expect(Notice).toHaveBeenCalledWith("Use a vault-relative path without '..' or a leading slash.");
    expect(updateSettings.mock.calls).toEqual([[{ recordingsDirectory: "Work/Recordings" }]]);
    expect(handleDirectorySettingChange.mock.calls).toEqual([["recordingsDirectory", "Work/Recordings"]]);
  });

  it("retries the final directory on blur after a failed save without creating it prematurely", async () => {
    const { inputs, updateSettings, handleDirectorySettingChange } = render();
    updateSettings.mockRejectedValueOnce(new Error("Disk unavailable"));
    typeValue(inputs[0], "Work/Chats");
    inputs[0].dispatchEvent(new Event("blur"));
    await jest.advanceTimersByTimeAsync(0);

    expect(Notice).toHaveBeenCalledWith("Couldn’t save that directory.");
    expect(handleDirectorySettingChange).not.toHaveBeenCalled();
    inputs[0].dispatchEvent(new Event("blur"));
    await jest.advanceTimersByTimeAsync(0);

    expect(updateSettings.mock.calls).toEqual([
      [{ chatsDirectory: "Work/Chats" }],
      [{ chatsDirectory: "Work/Chats" }],
    ]);
    expect(handleDirectorySettingChange.mock.calls).toEqual([["chatsDirectory", "Work/Chats"]]);
  });

  it("validates on commit rather than interrupting typing, and permits clearing a directory", async () => {
    const { inputs, updateSettings, handleDirectorySettingChange } = render();
    typeValue(inputs[0], "../outside");
    expect(Notice).not.toHaveBeenCalled();
    inputs[0].dispatchEvent(new Event("blur"));
    expect(Notice).toHaveBeenCalledWith("Use a vault-relative path without '..' or a leading slash.");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(handleDirectorySettingChange).not.toHaveBeenCalled();

    typeValue(inputs[0], "");
    inputs[0].dispatchEvent(new Event("blur"));
    await Promise.resolve();
    expect(updateSettings).toHaveBeenCalledWith({ chatsDirectory: "" });
    expect(handleDirectorySettingChange).toHaveBeenCalledWith("chatsDirectory", "");
  });
});
