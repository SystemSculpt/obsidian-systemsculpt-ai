import { Notice, Platform } from "obsidian";

import SystemSculptPlugin from "../main";
import { API_BASE_URL } from "../constants/api";
import type { HttpResponseShim } from "../utils/httpClient";
import { httpRequest } from "../utils/httpClient";
import { compareNumericVersions, parseNumericVersion } from "../utils/semver";

const RELEASE_CONTRACT = "plugin-release-v1" as const;
const PLUGIN_ID = "systemsculpt-ai" as const;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RETURN_CHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_URI = "obsidian://show-plugin?id=systemsculpt-ai";
const RELEASE_URL_PREFIX = "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/";

export type PluginReleaseInfo = Readonly<{
  contractVersion: typeof RELEASE_CONTRACT;
  pluginId: typeof PLUGIN_ID;
  latestVersion: string;
  releaseUrl: string;
  publishedAt: string;
}>;

export type PluginUpdateCheckResult =
  | Readonly<{ outcome: "update_available"; release: PluginReleaseInfo }>
  | Readonly<{ outcome: "up_to_date"; release: PluginReleaseInfo }>
  | Readonly<{ outcome: "unavailable" }>;

type PluginUpdateServiceOptions = Readonly<{
  request?: (options: Parameters<typeof httpRequest>[0]) => Promise<HttpResponseShim>;
  notify?: (message: string, durationMs?: number) => void;
  openUpdatePage?: () => void;
  now?: () => number;
}>;

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function parsePluginReleaseInfo(value: unknown): PluginReleaseInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, [
    "contract_version",
    "plugin_id",
    "latest_version",
    "release_url",
    "published_at",
  ])) return null;
  if (record.contract_version !== RELEASE_CONTRACT || record.plugin_id !== PLUGIN_ID) return null;
  if (typeof record.latest_version !== "string" || !parseNumericVersion(record.latest_version)) return null;
  if (
    typeof record.release_url !== "string" ||
    record.release_url !== `${RELEASE_URL_PREFIX}${record.latest_version}`
  ) return null;
  if (
    typeof record.published_at !== "string" ||
    !record.published_at ||
    Number.isNaN(Date.parse(record.published_at))
  ) return null;
  return {
    contractVersion: RELEASE_CONTRACT,
    pluginId: PLUGIN_ID,
    latestVersion: record.latest_version,
    releaseUrl: record.release_url,
    publishedAt: record.published_at,
  };
}

export class PluginUpdateService {
  private readonly request: NonNullable<PluginUpdateServiceOptions["request"]>;
  private readonly notify: NonNullable<PluginUpdateServiceOptions["notify"]>;
  private readonly openUpdatePage: NonNullable<PluginUpdateServiceOptions["openUpdatePage"]>;
  private readonly now: NonNullable<PluginUpdateServiceOptions["now"]>;
  private statusBarEl: HTMLElement | null = null;
  private periodicCheck: number | null = null;
  private started = false;
  private lastCheckAt = 0;
  private pendingCheck: Promise<PluginUpdateCheckResult> | null = null;
  private readonly handleReturnToApp = () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.now() - this.lastCheckAt < RETURN_CHECK_MIN_INTERVAL_MS) return;
    void this.checkForUpdates();
  };

  constructor(
    private readonly plugin: SystemSculptPlugin,
    options: PluginUpdateServiceOptions = {},
  ) {
    this.request = options.request ?? httpRequest;
    this.notify = options.notify ?? ((message, durationMs) => {
      new Notice(message, durationMs);
    });
    this.openUpdatePage = options.openUpdatePage ?? (() => {
      const ownerWindow = typeof window !== "undefined" ? window.activeWindow ?? window : undefined;
      ownerWindow?.open?.(UPDATE_URI, "_blank");
    });
    this.now = options.now ?? (() => Date.now());
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.prepareStatusBar();
    this.plugin.addCommand({
      id: "check-for-systemsculpt-updates",
      name: "Check for updates",
      callback: () => void this.checkForUpdates({ manual: true }),
    });
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleReturnToApp);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.handleReturnToApp);
      this.periodicCheck = window.setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
    }

    await this.recordInstalledVersion();
    await this.checkForUpdates();
  }

  public stop(): void {
    if (this.periodicCheck !== null && typeof window !== "undefined") {
      window.clearInterval(this.periodicCheck);
      this.periodicCheck = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleReturnToApp);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.handleReturnToApp);
    }
    this.started = false;
    this.pendingCheck = null;
  }

  public async checkForUpdates(options: { manual?: boolean } = {}): Promise<PluginUpdateCheckResult> {
    if (this.pendingCheck) return this.pendingCheck;
    this.pendingCheck = this.performCheck(options.manual === true);
    try {
      return await this.pendingCheck;
    } finally {
      this.pendingCheck = null;
    }
  }

  private async performCheck(manual: boolean): Promise<PluginUpdateCheckResult> {
    this.lastCheckAt = this.now();
    try {
      const response = await this.request({
        url: `${API_BASE_URL}/releases/latest`,
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-plugin-version": this.plugin.manifest.version,
        },
        timeoutMs: 10_000,
      });
      const release = parsePluginReleaseInfo(response.json);
      if (!release) throw new Error("Invalid plugin release response");

      if (compareNumericVersions(release.latestVersion, this.plugin.manifest.version) > 0) {
        this.showUpdateAction(release.latestVersion);
        const alreadyAnnounced = this.plugin.settings.lastAnnouncedPluginRelease === release.latestVersion;
        if (manual || !alreadyAnnounced) {
          this.notify(
            `SystemSculpt ${release.latestVersion} is ready. Update in Community plugins.`,
            12_000,
          );
        }
        if (!alreadyAnnounced) {
          await this.plugin.getSettingsManager().updateSettings({
            lastAnnouncedPluginRelease: release.latestVersion,
          });
        }
        return { outcome: "update_available", release };
      }

      this.hideUpdateAction();
      if (manual) {
        this.notify(`SystemSculpt ${this.plugin.manifest.version} is current.`, 5_000);
      }
      return { outcome: "up_to_date", release };
    } catch {
      if (manual) this.notify("Update check is temporarily unavailable. Try again.", 6_000);
      return { outcome: "unavailable" };
    }
  }

  private async recordInstalledVersion(): Promise<void> {
    const currentVersion = this.plugin.manifest.version;
    const previousVersion = this.plugin.settings.lastLoadedPluginVersion;
    if (previousVersion && compareNumericVersions(currentVersion, previousVersion) > 0) {
      this.notify(`SystemSculpt updated to ${currentVersion}.`, 6_000);
    }
    if (previousVersion !== currentVersion) {
      await this.plugin.getSettingsManager().updateSettings({
        lastLoadedPluginVersion: currentVersion,
      });
    }
  }

  private prepareStatusBar(): void {
    if (this.statusBarEl || Platform.isMobile) return;
    this.statusBarEl = this.plugin.addStatusBarItem();
    this.statusBarEl.setAttribute("role", "button");
    this.statusBarEl.setAttribute("tabindex", "0");
    this.statusBarEl.hidden = true;
    this.statusBarEl.addEventListener("click", this.openUpdatePage);
    this.statusBarEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openUpdatePage();
    });
  }

  private showUpdateAction(version: string): void {
    this.prepareStatusBar();
    if (!this.statusBarEl) return;
    this.statusBarEl.setText?.(`Update SystemSculpt to ${version}`);
    if (!this.statusBarEl.textContent) this.statusBarEl.textContent = `Update SystemSculpt to ${version}`;
    this.statusBarEl.setAttribute("aria-label", `Update SystemSculpt to ${version}`);
    this.statusBarEl.hidden = false;
  }

  private hideUpdateAction(): void {
    if (this.statusBarEl) this.statusBarEl.hidden = true;
  }
}
