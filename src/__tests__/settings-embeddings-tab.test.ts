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

  it("shows only the managed embeddings product controls", async () => {
    const app = new App();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const plugin: any = {
      app,
      settings: {
        embeddingsEnabled: true,
        embeddingsExclusions: {
          folders: [],
          patterns: [],
          ignoreChatHistory: true,
          respectObsidianExclusions: true,
        },
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
      invalidateSearchIndex: jest.fn(),
    };

    await displayEmbeddingsTabContent(container, tab);

    const text = container.textContent || "";
    const names = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );

    expect(names).not.toContain("Embeddings execution");
    expect(names).not.toContain("Embeddings provider");
    expect(text).not.toContain("Custom provider");
    expect(text).not.toContain("Scan local providers");
    expect(text).not.toContain("API endpoint");
    expect(text).not.toContain("API key");
    expect(text).not.toContain("Model name");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("reports an index that could not open instead of Starting", async () => {
    const app = new App();
    const plugin: any = {
      app,
      settings: {
        embeddingsEnabled: true,
        embeddingsExclusions: { folders: [], patterns: [], ignoreChatHistory: true, respectObsidianExclusions: true },
      },
      getSettingsManager: jest.fn(() => ({ updateSettings: jest.fn() })),
      embeddingsManager: {
        getLifecycleSnapshot: () => ({
          phase: "error",
          ready: false,
          failed: 0,
          lastError: { code: "storage_blocked", message: "Restart Obsidian to finish updating the semantic index." },
        }),
      },
      embeddingsStatusBar: undefined,
      getOrCreateEmbeddingsManager: jest.fn(),
    };
    const container = document.createElement("div");

    await displayEmbeddingsTabContent(container, { app, plugin, invalidateSearchIndex: jest.fn() } as any);

    const status = Array.from(container.querySelectorAll(".setting-item"))
      .find((item) => item.querySelector(".setting-item-name")?.textContent === "Index status");
    expect(status?.querySelector(".setting-item-description")?.textContent).toBe("Needs attention");
  });
});
