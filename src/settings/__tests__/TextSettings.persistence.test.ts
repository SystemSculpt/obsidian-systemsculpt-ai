/** @jest-environment jsdom */

import { App, Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { SettingsManager } from "../../core/settings/SettingsManager";
import { CURRENT_SCHEMA_VERSION } from "../../core/settings/migrations/schemaVersion";
import type { SystemSculptSettings } from "../../types";
import { displayImageGenerationTabContent } from "../ImageGenerationTabContent";
import { SystemSculptSettingTab } from "../SystemSculptSettingTab";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  Notice: jest.fn(),
}));

jest.mock("../../core/settings/AutomaticBackupService", () => ({
  AutomaticBackupService: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

jest.mock("../../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

const typeValue = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input"));
};

const retentionInput = (container: HTMLElement): HTMLInputElement => {
  const row = [...container.querySelectorAll<HTMLElement>(".setting-item")]
    .find((item) => item.querySelector(".setting-item-name")?.textContent === "Run retention");
  if (!row) throw new Error("Studio run retention setting was not rendered");
  return row.querySelector<HTMLInputElement>('input[type="text"]')!;
};

describe("Studio text settings with real settings persistence", () => {
  const rendered = new Set<{ tab: SystemSculptSettingTab; manager: SettingsManager }>();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(async () => {
    for (const { tab, manager } of rendered) {
      tab.hide();
      manager.destroy();
    }
    rendered.clear();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    document.body.innerHTML = "";
  });

  const render = async () => {
    const app = new App();
    app.vault.adapter.exists = jest.fn(async () => true);
    app.vault.adapter.write = jest.fn(async () => undefined);
    let persisted: Partial<SystemSculptSettings> = { schemaVersion: CURRENT_SCHEMA_VERSION };
    const persist = (settings: Partial<SystemSculptSettings>) => {
      persisted = JSON.parse(JSON.stringify(settings)) as Partial<SystemSculptSettings>;
    };
    const saveData = jest.fn(async (settings: Partial<SystemSculptSettings>) => persist(settings));
    let manager!: SettingsManager;
    const plugin = {
      app,
      storage: null,
      _internal_settings_systemsculpt_plugin: {} as SystemSculptSettings,
      get settings() { return this._internal_settings_systemsculpt_plugin; },
      loadData: jest.fn(async () => persisted),
      saveData,
      getLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
      getSettingsManager: () => manager,
    } as unknown as SystemSculptPlugin;
    manager = new SettingsManager(plugin);
    await manager.loadSettings();
    saveData.mockClear();
    jest.mocked(Notice).mockClear();

    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");
    document.body.append(container);
    rendered.add({ tab, manager });
    displayImageGenerationTabContent(container, tab);
    return {
      tab, manager, plugin, container, saveData, persist,
      persisted: () => persisted,
      input: retentionInput(container),
    };
  };

  it.each(["blur", "hide"] as const)("retries the same value on %s after a primary write fails", async (boundary) => {
    const { tab, input, saveData, persisted } = await render();
    saveData.mockRejectedValueOnce(new Error("Disk unavailable"));

    typeValue(input, "25");
    await jest.advanceTimersByTimeAsync(300);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(persisted().studioRunRetentionMaxRuns).toBe(100);
    expect(Notice).toHaveBeenCalledTimes(1);

    if (boundary === "blur") input.dispatchEvent(new Event("blur"));
    else tab.hide();
    await jest.advanceTimersByTimeAsync(0);

    expect(saveData).toHaveBeenCalledTimes(2);
    expect(persisted().studioRunRetentionMaxRuns).toBe(25);
    // SettingsManager already reports the disk error; the field must not duplicate it.
    expect(Notice).toHaveBeenCalledTimes(1);
  });

  it("keeps the flushed draft visible across rerender while its update is queued", async () => {
    const { tab, manager, plugin, container, input, saveData, persist, persisted } = await render();
    let finishWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { finishWrite = resolve; });
    saveData.mockImplementationOnce(async (settings) => {
      await writeGate;
      persist(settings);
    });
    const previousUpdate = manager.updateSettings({ defaultChatTag: "blocks-the-queue" });
    await jest.advanceTimersByTimeAsync(0);

    try {
      typeValue(input, "25");
      displayImageGenerationTabContent(container, tab);
      expect(plugin.settings.studioRunRetentionMaxRuns).toBe(100);
      expect(retentionInput(container)).not.toBe(input);
      expect(retentionInput(container).value).toBe("25");
    } finally {
      finishWrite();
      await previousUpdate;
      await jest.advanceTimersByTimeAsync(0);
    }

    expect(persisted().studioRunRetentionMaxRuns).toBe(25);
    expect(retentionInput(container).value).toBe("25");
  });

  it("keeps an in-flight edit retryable in replacement controls when its primary write fails", async () => {
    const { tab, container, input, saveData, persisted } = await render();
    let rejectWrite!: (error: Error) => void;
    saveData.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    }));

    typeValue(input, "25");
    await jest.advanceTimersByTimeAsync(300);
    displayImageGenerationTabContent(container, tab);
    const replacement = retentionInput(container);
    rejectWrite(new Error("Disk unavailable"));
    await jest.advanceTimersByTimeAsync(0);
    expect(persisted().studioRunRetentionMaxRuns).toBe(100);
    expect(replacement.value).toBe("25");

    replacement.dispatchEvent(new Event("blur"));
    await jest.advanceTimersByTimeAsync(0);

    expect(saveData).toHaveBeenCalledTimes(2);
    expect(persisted().studioRunRetentionMaxRuns).toBe(25);
    expect(Notice).toHaveBeenCalledTimes(1);
  });
});
