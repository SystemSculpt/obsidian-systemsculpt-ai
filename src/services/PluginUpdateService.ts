import { Notice } from "obsidian";

import type SystemSculptPlugin from "../main";
import { API_BASE_URL } from "../constants/api";
import { showPrompt } from "../core/ui/modals/PromptModal";
import { hasHostCapability } from "../platform/hostCapabilities";
import { compareNumericVersions, parseNumericVersion } from "../utils/semver";
import { PlatformRequestClient } from "./PlatformRequestClient";

const RELEASE_CONTRACT = "plugin-release-v1" as const;
const PLUGIN_ID = "systemsculpt-ai" as const;
/** Background checks run at most once per window; releases ship a few times a week. */
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** Longest wait a server cache or retry header can impose before the next check. */
const MAX_CHECK_DELAY_MS = 24 * 60 * 60_000;
/** First retry after a failed background check; doubles up to CHECK_INTERVAL_MS. */
const FAILURE_RETRY_BASE_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
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

/**
 * One release read. freshForMs carries the server's Cache-Control max-age so
 * a longer server cache lifetime can stretch the next background check.
 */
export type PluginReleaseFetch = Readonly<{ body: unknown; freshForMs?: number }>;

/** A failed release read; retryAfterMs carries the server's Retry-After. */
export class PluginReleaseRequestError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = "PluginReleaseRequestError";
  }
}

type PluginUpdateServiceOptions = Readonly<{
  request?: () => Promise<PluginReleaseFetch>;
  notify?: (message: string, durationMs?: number) => void;
  openUpdatePage?: () => void;
  showUpdatePrompt?: (version: string) => Promise<boolean>;
  now?: () => number;
}>;

function boundedDelayMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_CHECK_DELAY_MS, Math.floor(value));
}

/** Reads `max-age` from Cache-Control; `no-store`/`no-cache` give no hint. */
export function cacheControlMaxAgeMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const directives = value.toLowerCase().split(",").map((part) => part.trim());
  if (directives.some((directive) => directive === "no-store" || directive === "no-cache")) return undefined;
  for (const directive of directives) {
    const match = /^max-age=(\d{1,10})$/.exec(directive);
    if (match) return Number(match[1]) * 1_000;
  }
  return undefined;
}

/** Reads Retry-After as delta-seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

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
    typeof record.release_url !== "string"
    || record.release_url !== `${RELEASE_URL_PREFIX}${record.latest_version}`
  ) return null;
  if (
    typeof record.published_at !== "string"
    || !record.published_at
    || Number.isNaN(Date.parse(record.published_at))
  ) return null;
  return {
    contractVersion: RELEASE_CONTRACT,
    pluginId: PLUGIN_ID,
    latestVersion: record.latest_version,
    releaseUrl: record.release_url,
    publishedAt: record.published_at,
  };
}

/**
 * Announces published releases. Obsidian Community Plugins owns installation.
 *
 * Checks run once at launch, then at most once per CHECK_INTERVAL_MS. A single
 * timeout is armed only while the window is visible and the host is online;
 * returning to the app or reconnecting resumes a due check. Failed background
 * checks back off from FAILURE_RETRY_BASE_MS to the normal interval, and
 * server cache or Retry-After headers can only lengthen the wait.
 */
export class PluginUpdateService {
  private readonly request: NonNullable<PluginUpdateServiceOptions["request"]>;
  private readonly notify: NonNullable<PluginUpdateServiceOptions["notify"]>;
  private readonly openUpdatePage: NonNullable<PluginUpdateServiceOptions["openUpdatePage"]>;
  private readonly showUpdatePrompt: NonNullable<PluginUpdateServiceOptions["showUpdatePrompt"]>;
  private readonly now: NonNullable<PluginUpdateServiceOptions["now"]>;
  private statusBarEl: HTMLElement | null = null;
  private scheduledCheck: number | null = null;
  private started = false;
  /** The next background check may not run before this time. */
  private nextCheckAt = 0;
  private consecutiveFailures = 0;
  private announcedVersion = "";
  private pendingCheck: Promise<PluginUpdateCheckResult> | null = null;
  private pendingManualFeedback = false;

  private readonly handleWake = (): void => {
    this.checkIfDue();
  };

  private readonly handlePause = (): void => {
    this.clearScheduledCheck();
  };

  constructor(
    private readonly plugin: SystemSculptPlugin,
    options: PluginUpdateServiceOptions = {},
  ) {
    this.request = options.request ?? (() => this.fetchLatestRelease());
    this.notify = options.notify ?? ((message, durationMs) => new Notice(message, durationMs));
    this.openUpdatePage = options.openUpdatePage ?? (() => {
      const ownerWindow = typeof window !== "undefined" ? window.activeWindow ?? window : undefined;
      ownerWindow?.open?.(UPDATE_URI, "_blank");
    });
    this.showUpdatePrompt = options.showUpdatePrompt ?? (async (version) => {
      const result = await showPrompt(
        this.plugin.app,
        "Update to unlock the newest capabilities, sharper workflows, and fresh improvements.",
        {
          title: "SystemSculpt just evolved",
          description: `Version ${version} has landed.`,
          primaryButton: "Let's evolve",
          secondaryButton: "Stay here for now",
          icon: "sparkles",
        },
      );
      return result?.confirmed === true;
    });
    this.now = options.now ?? (() => Date.now());
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    // A scheduled check can never outlive an unload that skipped stop().
    this.plugin.register(() => this.stop());
    this.prepareStatusBar();
    this.plugin.addCommand({
      id: "check-for-updates",
      name: "Check for updates",
      callback: () => void this.checkForUpdates({ manual: true }),
    });
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleWake);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.handleWake);
      window.addEventListener("online", this.handleWake);
      window.addEventListener("offline", this.handlePause);
    }
    void this.recordInstalledVersion();
    this.checkIfDue();
  }

  public stop(): void {
    this.clearScheduledCheck();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleWake);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.handleWake);
      window.removeEventListener("online", this.handleWake);
      window.removeEventListener("offline", this.handlePause);
    }
    this.started = false;
    this.pendingCheck = null;
    this.pendingManualFeedback = false;
  }

  public async checkForUpdates(options: { manual?: boolean } = {}): Promise<PluginUpdateCheckResult> {
    if (options.manual === true) this.pendingManualFeedback = true;
    if (this.pendingCheck) return this.pendingCheck;
    this.clearScheduledCheck();
    this.pendingCheck = this.performCheck();
    try {
      return await this.pendingCheck;
    } finally {
      this.pendingCheck = null;
      this.pendingManualFeedback = false;
      this.checkIfDue();
    }
  }

  /**
   * Runs a due background check, or arms one timeout for the next due time.
   * Nothing is armed while the window is hidden or the host is offline.
   */
  private checkIfDue(): void {
    if (!this.started || this.pendingCheck) return;
    if (this.isPaused()) {
      this.clearScheduledCheck();
      return;
    }
    const waitMs = this.nextCheckAt - this.now();
    if (waitMs <= 0) {
      void this.checkForUpdates();
      return;
    }
    if (this.scheduledCheck !== null || typeof window === "undefined") return;
    this.scheduledCheck = window.setTimeout(() => {
      this.scheduledCheck = null;
      this.checkIfDue();
    }, waitMs);
  }

  private isPaused(): boolean {
    if (typeof document !== "undefined" && document.hidden) return true;
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  private clearScheduledCheck(): void {
    if (this.scheduledCheck === null) return;
    if (typeof window !== "undefined") window.clearTimeout(this.scheduledCheck);
    this.scheduledCheck = null;
  }

  private async performCheck(): Promise<PluginUpdateCheckResult> {
    try {
      const fetched = await this.request();
      const release = parsePluginReleaseInfo(fetched.body);
      if (!release) throw new Error("Invalid plugin release response");
      this.consecutiveFailures = 0;
      this.nextCheckAt = this.now() + Math.max(CHECK_INTERVAL_MS, boundedDelayMs(fetched.freshForMs));

      if (compareNumericVersions(release.latestVersion, this.plugin.manifest.version) > 0) {
        this.showUpdateAction(release.latestVersion);
        if (
          this.pendingManualFeedback
          || (
            this.announcedVersion !== release.latestVersion
            && this.plugin.settings.lastAnnouncedPluginRelease !== release.latestVersion
          )
        ) {
          await this.presentUpdate(release.latestVersion);
        }
        return { outcome: "update_available", release };
      }

      this.hideUpdateAction();
      if (this.pendingManualFeedback) {
        this.notify(`SystemSculpt ${this.plugin.manifest.version} is current.`, 5_000);
      }
      return { outcome: "up_to_date", release };
    } catch (error) {
      this.consecutiveFailures += 1;
      const backoffMs = Math.min(
        CHECK_INTERVAL_MS,
        FAILURE_RETRY_BASE_MS * 2 ** Math.min(this.consecutiveFailures - 1, 16),
      );
      const serverRetryMs = error instanceof PluginReleaseRequestError
        ? boundedDelayMs(error.retryAfterMs)
        : 0;
      this.nextCheckAt = this.now() + Math.max(backoffMs, serverRetryMs);
      if (this.pendingManualFeedback) {
        this.notify("Update check is temporarily unavailable. Try again.", 6_000);
      }
      return { outcome: "unavailable" };
    }
  }

  private async fetchLatestRelease(): Promise<PluginReleaseFetch> {
    const response = await new PlatformRequestClient().request({
      url: `${API_BASE_URL}/releases/latest`,
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-plugin-version": this.plugin.manifest.version,
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) {
      throw new PluginReleaseRequestError(
        `Plugin release request failed (${response.status})`,
        retryAfterMs(response.headers.get("retry-after"), this.now()),
      );
    }
    const text = await response.text();
    if (text.length > 8_192) throw new Error("Plugin release response is too large");
    return {
      body: JSON.parse(text) as unknown,
      freshForMs: cacheControlMaxAgeMs(response.headers.get("cache-control")),
    };
  }

  private async recordInstalledVersion(): Promise<void> {
    const currentVersion = this.plugin.manifest.version;
    const previousVersion = this.plugin.settings.lastLoadedPluginVersion;
    if (previousVersion && compareNumericVersions(currentVersion, previousVersion) > 0) {
      this.notify(`SystemSculpt updated to ${currentVersion}.`, 6_000);
    }
    if (previousVersion !== currentVersion) {
      await this.plugin.getSettingsManager().updateSettings({ lastLoadedPluginVersion: currentVersion });
    }
  }

  private async presentUpdate(version: string): Promise<void> {
    this.announcedVersion = version;
    const shouldOpenUpdatePage = await this.showUpdatePrompt(version);
    if (this.plugin.settings.lastAnnouncedPluginRelease !== version) {
      await this.plugin.getSettingsManager().updateSettings({ lastAnnouncedPluginRelease: version });
    }
    if (shouldOpenUpdatePage) this.openUpdatePage();
  }

  private prepareStatusBar(): void {
    if (this.statusBarEl || !hasHostCapability("status-bar")) return;
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
