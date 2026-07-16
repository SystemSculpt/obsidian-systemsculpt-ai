/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayBackupTabContent } from "../settings/BackupTabContent";
import { hasHostCapability } from "../platform/hostCapabilities";

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
        getAutomaticBackupService: jest.fn(() => ({
          start: jest.fn(),
          stop: jest.fn(),
        })),
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

  it("keeps the backup path visible without a dead folder action on portable hosts", () => {
    (hasHostCapability as jest.Mock).mockReturnValue(false);
    const app = new App();
    const plugin: any = {
      app,
      settings: { automaticBackupsEnabled: false },
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
        getAutomaticBackupService: jest.fn(() => ({
          start: jest.fn(),
          stop: jest.fn(),
        })),
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
});
