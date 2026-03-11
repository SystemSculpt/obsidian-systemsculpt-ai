/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayEmbeddingsTabContent } from "../settings/EmbeddingsTabContent";

jest.mock("../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

jest.mock("../modals/EmbeddingsPendingFilesModal", () => ({
  EmbeddingsPendingFilesModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
}));

jest.mock("../core/ui/notifications", () => ({
  showConfirm: jest.fn(),
}));

describe("Embeddings settings tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("locks embeddings to SystemSculpt without custom-provider controls", async () => {
    const app = new App();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const plugin: any = {
      app,
      settings: {
        embeddingsEnabled: true,
        embeddingsProvider: "custom",
        embeddingsExclusions: {
          folders: [],
          patterns: [],
          ignoreChatHistory: true,
          respectObsidianExclusions: true,
        },
        licenseKey: "license_test",
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings,
      })),
      embeddingsManager: undefined,
      embeddingsStatusBar: undefined,
      getOrCreateEmbeddingsManager: jest.fn(),
    };

    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin,
      display: jest.fn(),
    };

    await displayEmbeddingsTabContent(container, tab);

    const text = container.textContent || "";
    const names = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );

    expect(text).toContain("Embeddings always run through SystemSculpt");
    expect(names).toContain("Embeddings execution");
    expect(names).not.toContain("Embeddings provider");
    expect(text).not.toContain("Custom provider");
    expect(text).not.toContain("Scan local providers");
    expect(text).not.toContain("API endpoint");
    expect(text).not.toContain("API key");
    expect(text).not.toContain("Model name");
    expect(updateSettings).toHaveBeenCalledWith({ embeddingsProvider: "systemsculpt" });
  });
});
