/** @jest-environment jsdom */

import { App } from "obsidian";
import { attachFolderSuggester } from "../components/FolderSuggester";
import { displayImageGenerationTabContent } from "../settings/ImageGenerationTabContent";
import { DEFAULT_STUDIO_PROJECTS_DIR } from "../studio/paths";

jest.mock("../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

const typeValue = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new Event("change"));
};

describe("Studio settings tab", () => {
  let cleanups: Set<() => void>;

  const cleanupRender = () => {
    [...cleanups].forEach((cleanup) => cleanup());
    cleanups.clear();
  };

  const render = () => {
    const app = new App();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
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
      getSettingsManager: jest.fn(() => ({ updateSettings })),
      getViewManager: jest.fn(() => ({
        activateSystemSculptStudioView: jest.fn().mockResolvedValue(undefined),
      })),
    };
    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin,
      display: jest.fn(),
      registerRenderCleanup: jest.fn((cleanup: () => void) => {
        cleanups.add(cleanup);
        return () => cleanups.delete(cleanup);
      }),
    };
    displayImageGenerationTabContent(container, tab);
    const [folder, runs, artifacts] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]'));
    return { container, tab, updateSettings, folder, runs, artifacts };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = "";
    cleanups = new Set();
  });

  afterEach(() => {
    cleanupRender();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it("renders Studio controls without the retired telemetry setting", () => {
    const { container } = render();
    const text = container.textContent || "";
    const names = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );

    expect(text).toContain("Projects folder");
    expect(names).toContain("Open Studio");
    expect(names).not.toContain("Studio telemetry (remote)");
    expect(names).not.toContain("Studio terminal sidecar timeout (minutes)");
    expect(text).not.toContain("redacted Studio run telemetry");
  });

  it("debounces all three text fields independently", () => {
    const { folder, runs, artifacts, updateSettings } = render();
    typeValue(folder, "Work/P");
    typeValue(folder, " Work/Projects ");
    jest.advanceTimersByTime(100);
    typeValue(runs, "2");
    typeValue(runs, "25");
    jest.advanceTimersByTime(100);
    typeValue(artifacts, "4");
    typeValue(artifacts, "4096");
    expect(updateSettings).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(updateSettings.mock.calls).toEqual([[{ studioDefaultProjectsFolder: "Work/Projects" }]]);
    jest.advanceTimersByTime(100);
    expect(updateSettings).toHaveBeenNthCalledWith(2, { studioRunRetentionMaxRuns: 25 });
    jest.advanceTimersByTime(100);
    expect(updateSettings).toHaveBeenNthCalledWith(3, { studioRunRetentionMaxArtifactsMb: 4096 });
    expect(updateSettings).toHaveBeenCalledTimes(3);
  });

  it("flushes only the blurred field and preserves the other pending edits until cleanup", () => {
    const { folder, runs, artifacts, updateSettings } = render();
    typeValue(folder, "Projects");
    typeValue(runs, "25");
    typeValue(artifacts, "2048");

    runs.dispatchEvent(new Event("blur"));
    expect(updateSettings.mock.calls).toEqual([[{ studioRunRetentionMaxRuns: 25 }]]);
    expect(jest.getTimerCount()).toBe(2);
    cleanupRender();

    expect(updateSettings.mock.calls).toEqual([
      [{ studioRunRetentionMaxRuns: 25 }],
      [{ studioDefaultProjectsFolder: "Projects" }],
      [{ studioRunRetentionMaxArtifactsMb: 2048 }],
    ]);
    expect(jest.getTimerCount()).toBe(0);
    jest.runOnlyPendingTimers();
    typeValue(folder, "Detached");
    expect(updateSettings).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("flushes pending values before rerendering Studio controls", () => {
    const { container, tab, folder, runs, artifacts, updateSettings } = render();
    typeValue(folder, "Projects");
    typeValue(runs, "25");
    typeValue(artifacts, "2048");

    displayImageGenerationTabContent(container, tab);

    expect(updateSettings.mock.calls).toEqual([
      [{ studioDefaultProjectsFolder: "Projects" }],
      [{ studioRunRetentionMaxRuns: 25 }],
      [{ studioRunRetentionMaxArtifactsMb: 2048 }],
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("commits a chosen folder instead of a pending typed prefix, even without a change event", () => {
    const { folder, updateSettings } = render();
    typeValue(folder, "Work/Pro");
    const selectFolder = jest.mocked(attachFolderSuggester).mock.calls[0][1];

    selectFolder("Work/Projects");
    expect(folder.value).toBe("Work/Projects");
    expect(updateSettings.mock.calls).toEqual([[{ studioDefaultProjectsFolder: "Work/Projects" }]]);
    folder.dispatchEvent(new Event("blur"));
    jest.runOnlyPendingTimers();
    cleanupRender();
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it("retains existing empty-folder defaults and numeric validation at commit", () => {
    const { folder, runs, artifacts, updateSettings } = render();
    typeValue(folder, " ");
    typeValue(runs, "not a number");
    typeValue(artifacts, "0");
    cleanupRender();

    expect(updateSettings.mock.calls).toEqual([
      [{ studioDefaultProjectsFolder: DEFAULT_STUDIO_PROJECTS_DIR }],
      [{ studioRunRetentionMaxArtifactsMb: 1 }],
    ]);
  });
});
