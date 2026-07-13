/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayDirectoriesTabContent } from "../settings/DirectoriesTabContent";

jest.mock("../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

describe("Directories tab managed-only layout", () => {
  it("shows durable local output directories without retired web-research storage", () => {
    const app = new App();
    const plugin = {
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        savedChatsDirectory: "SystemSculpt/Saved Chats",
        recordingsDirectory: "SystemSculpt/Recordings",
        attachmentsDirectory: "SystemSculpt/Attachments",
        extractionsDirectory: "SystemSculpt/Extractions",
      },
      getSettingsManager: jest.fn(() => ({ updateSettings: jest.fn() })),
      checkDirectoryHealth: jest.fn(),
      directoryManager: { handleDirectorySettingChange: jest.fn() },
    };
    const container = document.createElement("div");

    displayDirectoriesTabContent(container, { app, plugin } as never);

    const names = Array.from(container.querySelectorAll(".setting-item-name"))
      .map((element) => element.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining([
      "Chats Directory",
      "Saved Chats Directory",
      "Recordings Directory",
      "Attachments Directory",
      "Extractions Directory",
    ]));
    expect(names).not.toContain("Web Research Directory");
    expect(container.textContent).not.toContain("web search and fetch corpus files");
  });
});
