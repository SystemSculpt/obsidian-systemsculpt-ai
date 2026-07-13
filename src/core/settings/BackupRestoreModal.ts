import { App, Notice, TextComponent, setIcon } from "obsidian";
import { StandardModal } from "../ui/modals/standard/StandardModal";
import SystemSculptPlugin from "../../main";
import { applyCurrentSecretsToBackup, redactSettingsForBackup } from "./backupSanitizer";

export interface BackupEntry {
  path: string;
  name: string;
  date: string;
  details?: string;
}

export class BackupSelectionModal extends StandardModal {
  private resolveSelection: ((path: string | null) => void) | null = null;
  private listEl: HTMLElement | null = null;
  private query = "";

  constructor(
    app: App,
    private readonly backups: readonly BackupEntry[],
    private readonly renderManualForm?: (container: HTMLElement, modal: BackupSelectionModal) => void,
  ) {
    super(app);
    this.setSize("medium");
  }

  onOpen(): void {
    super.onOpen();
    this.addTitle(
      "Restore settings backup",
      "Choose a backup to restore. Your current settings will be replaced.",
    );

    if (this.renderManualForm) {
      const manual = this.contentEl.createDiv({ cls: "ss-modal__custom-content" });
      this.renderManualForm(manual, this);
    }

    const search = this.addSearchBar("Search backups…", (query) => {
      this.query = query.trim().toLowerCase();
      this.renderBackups();
    });
    this.listEl = this.contentEl.createDiv({ cls: "ss-modal__list" });
    this.renderBackups();
    window.setTimeout(() => search.focus(), 50);
  }

  onClose(): void {
    this.settle(null);
    this.listEl = null;
    super.onClose();
  }

  openAndSelect(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolveSelection = resolve;
      this.open();
    });
  }

  private renderBackups(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const filtered = this.query
      ? this.backups.filter((backup) =>
          `${backup.name}\n${backup.date}\n${backup.details ?? ""}`.toLowerCase().includes(this.query))
      : this.backups;
    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: "ss-modal__empty-state", text: "No backups found" });
      return;
    }

    filtered.forEach((backup) => {
      const button = this.listEl!.createEl("button", {
        cls: "ss-modal__item ss-backup-selection__item",
        attr: { type: "button", "data-backup-path": backup.path },
      });
      const icon = button.createDiv({ cls: "ss-modal__item-icon" });
      setIcon(icon, "save");
      const content = button.createDiv({ cls: "ss-modal__item-content" });
      content.createDiv({ text: backup.name, cls: "ss-modal__item-title" });
      const detailLines = backup.details?.split("\n").map((line) => line.trim()).filter(Boolean) ?? [];
      if (detailLines.length > 0) {
        const details = content.createDiv({ cls: "ss-backup-details" });
        detailLines.forEach((line) => details.createSpan({ text: line, cls: "ss-backup-details__item" }));
      } else {
        content.createDiv({ text: backup.date, cls: "ss-modal__item-description" });
      }
      this.registerDomEvent(button, "click", () => {
        this.settle(backup.path);
        this.close();
      });
    });
  }

  private settle(path: string | null): void {
    const resolve = this.resolveSelection;
    if (!resolve) return;
    this.resolveSelection = null;
    resolve(path);
  }
}

export class BackupRestoreModal {
  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin
  ) {}

  async open(): Promise<string | null> {
    try {
      const backups = await this.getAvailableBackups();
      if (backups.length === 0) {
        new Notice("No settings backups found", 3000);
        return null;
      }

      const modal = new BackupSelectionModal(
        this.app,
        backups,
        (containerEl, selection) => this.renderManualBackupForm(containerEl, selection),
      );
      return await modal.openAndSelect();
    } catch (error) {
      new Notice(`Error loading backups: ${error}`, 3000);
      return null;
    }
  }

  async restoreFromBackup(backupPath: string): Promise<boolean> {
    try {
      const exists = await this.plugin.app.vault.adapter.exists(backupPath);
      if (!exists) {
        new Notice("Backup file not found", 3000);
        return false;
      }

      const backupData = await this.plugin.app.vault.adapter.read(backupPath);
      const backupSettings = JSON.parse(backupData);
      if (!backupSettings || typeof backupSettings !== "object") {
        new Notice("Invalid backup file format", 3000);
        return false;
      }

      const currentSettings = this.plugin.getSettingsManager().getSettings() as unknown as Record<string, unknown>;
      const restoredSettings = applyCurrentSecretsToBackup(
        backupSettings as Record<string, unknown>,
        currentSettings,
      );

      await this.plugin.getSettingsManager().restoreFromExternalSettings(restoredSettings);
      new Notice("Settings restored successfully", 3000);
      return true;
    } catch (error) {
      new Notice(`Error restoring settings: ${error}`, 3000);
      return false;
    }
  }

  private renderManualBackupForm(containerEl: HTMLElement, modal: BackupSelectionModal): void {
    const manualBackupContainer = containerEl.createDiv({ cls: "ss-backup-manual" });
    manualBackupContainer.createEl("p", {
      text: "Create a manual backup before restoring anything.",
      cls: "ss-backup-manual__prompt",
    });

    const defaultName = `Manual backup ${new Date().toLocaleString()}`;
    const backupNameInput = new TextComponent(manualBackupContainer)
      .setPlaceholder(defaultName)
      .setValue(defaultName);
    backupNameInput.inputEl.addClass("ss-backup-manual__input");

    const createBackupButton = manualBackupContainer.createEl("button", {
      text: "Create manual backup",
      cls: "mod-cta ss-backup-manual__submit",
    });

    createBackupButton.addEventListener("click", () => {
      const backupName = backupNameInput.getValue().trim();
      if (!backupName) {
        new Notice("Please enter a name for the backup.", 3000);
        return;
      }

      createBackupButton.disabled = true;
      void this.saveManualBackup(backupName)
        .then(() => {
          modal.close();
          void this.open();
        })
        // saveManualBackup already reports the actionable error.
        .catch(() => undefined)
        .finally(() => { createBackupButton.disabled = false; });
    });
  }

  private async saveManualBackup(backupName: string): Promise<void> {
    try {
      const safeNamePart = backupName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      const timestamp = Date.now();
      const fileName = `settings-manual-${safeNamePart}-${timestamp}.json`;
      const backupDir = ".systemsculpt/settings-backups";

      await this.ensureBackupDirectory(backupDir);

      const currentSettings = this.plugin.getSettingsManager().getSettings();
      const redactedSettings = redactSettingsForBackup(currentSettings as unknown as Record<string, unknown>);
      const backupData = {
        ...redactedSettings,
        _backupMeta: {
          type: "manual",
          name: backupName,
          timestamp,
          createdAt: new Date().toISOString(),
          redactedSecrets: true,
        },
      };

      const backupPath = `${backupDir}/${fileName}`;
      await this.plugin.app.vault.adapter.write(
        backupPath,
        JSON.stringify(backupData, null, 2)
      );

      new Notice(`Manual backup "${backupName}" created successfully`, 3000);
    } catch (error) {
      new Notice(`Error saving backup: ${error}`, 3000);
      throw error;
    }
  }

  private async getAvailableBackups(): Promise<BackupEntry[]> {
    try {
      const backupDir = ".systemsculpt/settings-backups";
      const exists = await this.plugin.app.vault.adapter.exists(backupDir);
      if (!exists) {
        return [];
      }

      const files = await this.plugin.app.vault.adapter.list(backupDir);
      const backupFiles = files.files
        .filter((filePath) => filePath.includes("settings-") && filePath.endsWith(".json"))
        .sort((left, right) => right.localeCompare(left));

      const backups = await Promise.all(backupFiles.map(async (filePath) => this.describeBackup(filePath)));
      return backups.sort((left, right) => this.compareBackups(left, right));
    } catch {
      return [];
    }
  }

  private async describeBackup(filePath: string): Promise<BackupEntry> {
    const fileName = filePath.split("/").pop() || "";
    const backupSettings = await this.readBackupSettings(filePath);
    const details = this.describeBackupDetails(backupSettings);

    if (backupSettings?._backupMeta?.type === "manual") {
      const meta = backupSettings._backupMeta as { name: string; timestamp: number };
      return {
        path: filePath,
        name: `📝 ${meta.name}`,
        date: new Date(meta.timestamp).toLocaleString(),
        details,
      };
    }

    if (fileName === "settings-backup-latest.json") {
      return {
        path: filePath,
        name: "Latest automatic backup",
        date: "Most recent save",
        details,
      };
    }

    const datedBackup = fileName.match(/settings-backup-(\d{4}-\d{2}-\d{2})\.json/);
    if (datedBackup) {
      const [_, dateString] = datedBackup;
      const readableDate = new Date(dateString).toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      return {
        path: filePath,
        name: `Backup from ${readableDate}`,
        date: dateString,
        details,
      };
    }

    const emergencyBackup = fileName.match(/settings-emergency-(\d+)\.json/);
    if (emergencyBackup) {
      const timestamp = Number.parseInt(emergencyBackup[1], 10);
      return {
        path: filePath,
        name: "Emergency backup",
        date: new Date(timestamp).toLocaleString(),
        details,
      };
    }

    const legacyManualBackup = fileName.match(/settings-manual-(.*)-(\d+)\.json/);
    if (legacyManualBackup) {
      const readableName = legacyManualBackup[1].replace(/-/g, " ");
      const timestamp = Number.parseInt(legacyManualBackup[2], 10);
      return {
        path: filePath,
        name: `📝 ${readableName}`,
        date: new Date(timestamp).toLocaleString(),
        details,
      };
    }

    return {
      path: filePath,
      name: fileName,
      date: "Unknown date",
      details,
    };
  }

  private async readBackupSettings(filePath: string): Promise<Record<string, any> | null> {
    try {
      const backupData = await this.plugin.app.vault.adapter.read(filePath);
      return JSON.parse(backupData);
    } catch {
      return null;
    }
  }

  private describeBackupDetails(backupSettings: Record<string, any> | null): string {
    if (!backupSettings) {
      return "Could not read backup contents";
    }

    const hasLicense = backupSettings.licenseValid === true ? "Yes" : "No";
    const schemaVersion = Number.isFinite(backupSettings.schemaVersion)
      ? backupSettings.schemaVersion
      : "Legacy";

    return `License active: ${hasLicense}\nSchema: ${schemaVersion}`;
  }

  private compareBackups(left: BackupEntry, right: BackupEntry): number {
    if (left.name.includes("Latest")) return -1;
    if (right.name.includes("Latest")) return 1;

    const leftTimestamp = this.extractBackupTimestamp(left.path);
    const rightTimestamp = this.extractBackupTimestamp(right.path);

    if (leftTimestamp && rightTimestamp) {
      return rightTimestamp - leftTimestamp;
    }
    if (leftTimestamp && !rightTimestamp) return -1;
    if (!leftTimestamp && rightTimestamp) return 1;
    return right.path.localeCompare(left.path);
  }

  private extractBackupTimestamp(path: string): number {
    const manualMatch = path.match(/settings-manual-.*-(\d+)\.json/);
    if (manualMatch) {
      return Number.parseInt(manualMatch[1], 10);
    }

    const datedMatch = path.match(/settings-backup-(\d{4}-\d{2}-\d{2})\.json/);
    if (datedMatch) {
      return new Date(datedMatch[1]).getTime();
    }

    const emergencyMatch = path.match(/settings-emergency-(\d+)\.json/);
    if (emergencyMatch) {
      return Number.parseInt(emergencyMatch[1], 10);
    }

    return 0;
  }

  private async ensureBackupDirectory(backupDir: string): Promise<void> {
    try {
      await this.plugin.app.vault.createFolder(backupDir);
    } catch (error: any) {
      if (!error?.message?.includes("already exists")) {
        throw error;
      }
    }
  }
}
