/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayImageGenerationTabContent } from "../settings/ImageGenerationTabContent";
import { PlatformContext } from "../services/PlatformContext";

jest.mock("../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

describe("Studio settings tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    jest.spyOn(PlatformContext, "get").mockReturnValue({
      supportsDesktopOnlyFeatures: () => true,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders Studio controls without the retired telemetry setting", async () => {
    const app = new App();
    const plugin: any = {
      app,
      settings: {
        studioDefaultProjectsFolder: "SystemSculpt/Studio",
        studioRunRetentionMaxRuns: 100,
        studioRunRetentionMaxArtifactsMb: 1024,
        imageGenerationOutputDir: "SystemSculpt/Attachments/Generations",
        imageGenerationPollIntervalMs: 1000,
        imageGenerationSaveMetadataSidecar: true,
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
      getViewManager: jest.fn(() => ({
        activateSystemSculptStudioView: jest.fn().mockResolvedValue(undefined),
      })),
    };

    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin,
      display: jest.fn(),
    };

    await displayImageGenerationTabContent(container, tab);

    const text = container.textContent || "";
    const names = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );

    expect(text).toContain("through SystemSculpt");
    expect(names).toContain("Open SystemSculpt Studio");
    expect(names).not.toContain("Studio telemetry (remote)");
    expect(names).not.toContain("Studio terminal sidecar timeout (minutes)");
    expect(text).not.toContain("redacted Studio run telemetry");
  });
});
