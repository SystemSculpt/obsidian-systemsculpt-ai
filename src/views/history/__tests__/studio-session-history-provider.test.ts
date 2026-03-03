import { Platform, TFile } from "obsidian";
import {
  createStudioSessionHistoryProvider,
  loadStudioSessionRecords,
} from "../studioSessionHistoryProvider";

describe("studioSessionHistoryProvider", () => {
  beforeEach(() => {
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
  });

  const createPlugin = (favoriteStudioSessions: string[] = []) => {
    const studioA = new TFile({
      path: "SystemSculpt/Studio/Alpha.systemsculpt",
      extension: "systemsculpt",
    } as any);
    const studioB = new TFile({
      path: "SystemSculpt/Studio/Beta.systemsculpt",
      extension: "systemsculpt",
    } as any);
    const note = new TFile({
      path: "SystemSculpt/Studio/Notes.md",
      extension: "md",
    } as any);

    Object.defineProperty(studioA, "stat", {
      configurable: true,
      value: { mtime: 1000 },
    });
    Object.defineProperty(studioB, "stat", {
      configurable: true,
      value: { mtime: 2000 },
    });

    const viewManager = {
      activateSystemSculptStudioView: jest.fn(async () => {}),
    };

    const plugin: any = {
      settings: {
        favoriteStudioSessions,
      },
      app: {
        vault: {
          getFiles: jest.fn(() => [studioA, studioB, note]),
        },
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn(async (next: any) => {
          plugin.settings = { ...plugin.settings, ...next };
        }),
      })),
      getViewManager: jest.fn(() => viewManager),
    };

    return { plugin, studioA, studioB, viewManager };
  };

  it("loads one Studio session per .systemsculpt file", async () => {
    const { plugin } = createPlugin();
    const sessions = await loadStudioSessionRecords(plugin);

    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.projectPath)).toEqual([
      "SystemSculpt/Studio/Alpha.systemsculpt",
      "SystemSculpt/Studio/Beta.systemsculpt",
    ]);
  });

  it("marks and toggles studio favorites", async () => {
    const { plugin } = createPlugin(["SystemSculpt/Studio/Alpha.systemsculpt"]);
    const provider = createStudioSessionHistoryProvider(plugin);

    const entries = await provider.loadEntries();
    const alpha = entries.find((entry) => entry.id === "studio:SystemSculpt/Studio/Alpha.systemsculpt");
    const beta = entries.find((entry) => entry.id === "studio:SystemSculpt/Studio/Beta.systemsculpt");

    expect(alpha?.isFavorite).toBe(true);
    expect(beta?.isFavorite).toBe(false);

    const betaFavorite = await beta?.toggleFavorite?.();
    expect(betaFavorite).toBe(true);
    expect(plugin.settings.favoriteStudioSessions).toContain("SystemSculpt/Studio/Beta.systemsculpt");

    const alphaFavorite = await alpha?.toggleFavorite?.();
    expect(alphaFavorite).toBe(false);
    expect(plugin.settings.favoriteStudioSessions).not.toContain("SystemSculpt/Studio/Alpha.systemsculpt");
  });

  it("opens studio canvas for selected entry", async () => {
    const { plugin, viewManager } = createPlugin();
    const provider = createStudioSessionHistoryProvider(plugin);
    const entries = await provider.loadEntries();

    await entries[0].openPrimary();

    expect(viewManager.activateSystemSculptStudioView).toHaveBeenCalledWith(
      "SystemSculpt/Studio/Alpha.systemsculpt"
    );
  });
});
