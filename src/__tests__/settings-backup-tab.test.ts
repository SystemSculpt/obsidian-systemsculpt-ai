/** @jest-environment jsdom */

import { App, Notice } from "obsidian";
import { displayBackupTabContent } from "../settings/BackupTabContent";
import { hasHostCapability } from "../platform/hostCapabilities";
import { showPrompt } from "../core/ui/modals/PromptModal";
import { BackupRestoreModal } from "../core/settings/BackupRestoreModal";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));

jest.mock("../platform/hostCapabilities", () => ({
  hasHostCapability: jest.fn(() => false),
  openLocalFolder: jest.fn(async () => false),
}));

jest.mock("../core/ui/modals/PromptModal", () => ({
  showPrompt: jest.fn(),
}));

jest.mock("../core/settings/BackupRestoreModal", () => ({
  BackupRestoreModal: jest.fn().mockImplementation(() => ({
    open: jest.fn().mockResolvedValue(null),
    restoreFromBackup: jest.fn().mockResolvedValue(true),
  })),
}));

describe("Backup settings tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("describes backups around client settings without prompt terminology", () => {
    const app = new App();
    const plugin: any = {
      app,
      settings: {
        automaticBackupsEnabled: false,
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
    };

    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin,
      display: jest.fn(),
    };

    displayBackupTabContent(container, tab);

    const text = container.textContent || "";
    expect(text).toContain("SystemSculpt preferences");
    expect(text).not.toContain("prompt preferences");
  });

  it("turns automatic backups on and off through settings without a notice", async () => {
    const app = new App();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const plugin: any = {
      app,
      settings: { automaticBackupsEnabled: false },
      getSettingsManager: jest.fn(() => ({ updateSettings })),
    };
    const container = document.createElement("div");
    document.body.append(container);
    displayBackupTabContent(container, { app, plugin, display: jest.fn() } as any);
    const toggle = Array.from(container.querySelectorAll(".setting-item"))
      .find((item) => item.querySelector(".setting-item-name")?.textContent === "Automatic backups")
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    toggle!.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    toggle!.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // The settings manager arms and clears the backup timer on these updates.
    expect(updateSettings.mock.calls).toEqual([
      [{ automaticBackupsEnabled: true }],
      [{ automaticBackupsEnabled: false }],
    ]);
    expect(Notice).not.toHaveBeenCalled();
  });

  it("keeps the backup path visible without a dead folder action on portable hosts", () => {
    (hasHostCapability as jest.Mock).mockReturnValue(false);
    const app = new App();
    const plugin: any = {
      app,
      settings: { automaticBackupsEnabled: false },
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
    };
    const container = document.createElement("div");

    displayBackupTabContent(container, { app, plugin, display: jest.fn() } as any);

    expect(container.textContent).toContain(".systemsculpt/settings-backups");
    expect(Array.from(container.querySelectorAll("button")))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ textContent: "Open folder" }),
      ]));
  });

  async function chooseBackup(backupText: string | Error, answer: { confirmed: boolean } | null) {
    const app = new App();
    (app.vault.adapter.read as jest.Mock).mockImplementation(async () => {
      if (backupText instanceof Error) throw backupText;
      return backupText;
    });
    const restoreFromBackup = jest.fn().mockResolvedValue(true);
    jest.mocked(BackupRestoreModal).mockImplementationOnce(() => ({
      open: jest.fn().mockResolvedValue(".systemsculpt/settings-backups/latest.json"),
      restoreFromBackup,
    }) as any);
    (showPrompt as jest.Mock).mockResolvedValue(answer);
    const plugin: any = {
      app,
      settings: { automaticBackupsEnabled: false },
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
    };
    const display = jest.fn();
    const container = document.createElement("div");
    displayBackupTabContent(container, { app, plugin, refreshSettings: display } as any);
    const select = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Select backup");
    expect(select).toBeDefined();
    select!.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { app, restoreFromBackup, display };
  }

  it("asks once with the backup's contents and restores nothing when cancelled", async () => {
    const { app, restoreFromBackup, display } = await chooseBackup(JSON.stringify({ licenseValid: true }), null);

    expect(showPrompt).toHaveBeenCalledWith(app, "Restore settings from backup", {
      description: `Replace your current settings with this backup?

This backup contains:
• Chat display defaults and client-side workspace preferences
• Embeddings and audio settings
• License status: Active`,
      primaryButton: "Restore",
      secondaryButton: "Cancel",
    });
    expect(restoreFromBackup).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
  });

  it("restores the chosen backup once after confirmation", async () => {
    const { restoreFromBackup, display } = await chooseBackup(JSON.stringify({ licenseValid: false }), { confirmed: true });

    expect(restoreFromBackup).toHaveBeenCalledTimes(1);
    expect(restoreFromBackup).toHaveBeenCalledWith(".systemsculpt/settings-backups/latest.json");
    expect(display).toHaveBeenCalledTimes(1);
  });

  it("uses the short fallback question when the backup cannot be read", async () => {
    const { app } = await chooseBackup(new Error("unreadable"), { confirmed: false });

    expect(showPrompt).toHaveBeenCalledWith(app, "Restore settings from backup", expect.objectContaining({
      description: "Replace your current settings with the selected backup?",
    }));
  });
});
