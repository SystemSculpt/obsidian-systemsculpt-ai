import { type App, TFile, normalizePath, stringifyYaml } from "obsidian";
import { PlatformRequestClient } from "../../services/PlatformRequestClient";
import { SystemSculptEnvironment } from "../../services/api/SystemSculptEnvironment";
import { ensureVaultFolder } from "../../tools/vault/utils";
import { sha256HexFromBytesPortable } from "../../utils/sha256";
import { toSafeVaultFileName } from "../../utils/vaultFileName";

/** Captures the iPhone app sent to the server, waiting for a vault. */
export type PhoneCapture = Readonly<{
  id: string;
  createdAt: string;
  title: string;
  markdown: string;
  tags: readonly string[];
  source: string;
}>;

export type PhoneCaptureSettings = Readonly<{
  licenseKey: string;
  enabled: boolean;
  folder: string;
  askBeforeSaving: boolean;
}>;

export type PhoneCaptureSyncResult = Readonly<{
  /** Notes written by this sync. */
  saved: readonly string[];
  /** Captures already in the vault that were only acknowledged. */
  alreadyInVault: number;
  /** Captures the user chose not to save yet. */
  deferred: number;
  failed: number;
  skipped?: "disabled" | "signed_out" | "busy" | "unavailable";
}>;

export type PhoneCaptureInboxOptions = Readonly<{
  app: App;
  settings: () => PhoneCaptureSettings;
  pluginVersion: string;
  /** Asks whether to save these captures now. Required for "ask before saving". */
  confirm: (captures: readonly PhoneCapture[], folder: string) => Promise<boolean>;
  notify: (message: string) => void;
  onError?: (message: string, error: unknown) => void;
  requestClient?: PlatformRequestClient;
  baseUrl?: string;
  now?: () => number;
}>;

export const DEFAULT_PHONE_CAPTURE_FOLDER = "SystemSculpt/Inbox";
/** Background polls while Obsidian is open. */
export const PHONE_CAPTURE_POLL_INTERVAL_MS = 5 * 60_000;
/** Focus and resume events closer together than this share one sync. */
export const PHONE_CAPTURE_MIN_SYNC_GAP_MS = 60_000;
const PAGE_LIMIT = 50;
const MAX_PAGES_PER_SYNC = 10;
const CAPTURE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MARKDOWN_CHARS = 200_000;
const MAX_TITLE_CHARS = 200;
const MAX_COLLISION_SUFFIX = 100;

export class PhoneCaptureApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "PhoneCaptureApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const value = tag.trim().replace(/^#+/, "").replace(/\s+/g, "-");
  return value && value.length <= 100 ? value : null;
}

/** Reads one inbox item; anything malformed is dropped rather than written. */
export function decodePhoneCapture(value: unknown): PhoneCapture | null {
  if (!isRecord(value)) return null;
  const { id, created_at: createdAt, title, markdown, tags, source } = value;
  if (typeof id !== "string" || !CAPTURE_ID.test(id)) return null;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return null;
  if (typeof markdown !== "string" || markdown.length > MAX_MARKDOWN_CHARS) return null;
  if (value.status !== undefined && value.status !== "ready") return null;
  return {
    id,
    createdAt,
    title: typeof title === "string" ? title.trim().slice(0, MAX_TITLE_CHARS) : "",
    markdown,
    tags: Array.isArray(tags)
      ? [...new Set(tags.map(normalizeTag).filter((tag): tag is string => tag !== null))]
      : [],
    source: typeof source === "string" && source ? source : "ios",
  };
}

function localDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The note body: frontmatter that identifies the capture, then its markdown. */
export function renderPhoneCaptureNote(capture: PhoneCapture): string {
  const frontmatter = stringifyYaml({
    source: capture.source,
    captured: capture.createdAt,
    tags: [...capture.tags],
    capture_id: capture.id,
  });
  return `---\n${frontmatter}---\n\n${capture.markdown.trim()}\n`;
}

function ackIdempotencyKey(captureId: string, vaultPath: string): string {
  const pathHash = sha256HexFromBytesPortable(new TextEncoder().encode(vaultPath)).slice(0, 16);
  return `ack-${captureId}-${pathHash}`;
}

/**
 * Delivers captures from the SystemSculpt server inbox into the vault.
 *
 * Each ready capture becomes a new note (never an overwrite), then is
 * acknowledged with its vault path. A capture whose id is already in a note's
 * frontmatter is acknowledged without writing again, so a lost
 * acknowledgement or a second device never duplicates a note it can see.
 */
export class PhoneCaptureInbox {
  private readonly requestClient: PlatformRequestClient;
  private readonly baseUrl: string;
  private running: Promise<PhoneCaptureSyncResult> | null = null;
  private lastSyncAt = Number.NEGATIVE_INFINITY;
  /** Notes written this session, found even before the metadata cache indexes them. */
  private readonly written = new Map<string, string>();
  /** Captures the user declined to save; asked again only by a manual sync. */
  private readonly declined = new Set<string>();
  /** The server rejected this plugin version; stop polling until restart. */
  private upgradeRequired = false;

  constructor(private readonly options: PhoneCaptureInboxOptions) {
    this.baseUrl = (options.baseUrl ?? SystemSculptEnvironment.resolveBaseUrl()).replace(/\/+$/, "");
    this.requestClient = options.requestClient ?? new PlatformRequestClient();
  }

  /** Background trigger (startup, focus, timer): skipped when a sync ran recently. */
  maybeSync(): Promise<PhoneCaptureSyncResult> | null {
    const now = (this.options.now ?? Date.now)();
    if (this.running || now - this.lastSyncAt < PHONE_CAPTURE_MIN_SYNC_GAP_MS) return null;
    return this.sync();
  }

  /** Runs one sync, or joins the one in progress. `manual` asks again about declined captures. */
  sync(options: Readonly<{ manual?: boolean }> = {}): Promise<PhoneCaptureSyncResult> {
    if (this.running) return this.running;
    if (options.manual) this.declined.clear();
    this.lastSyncAt = (this.options.now ?? Date.now)();
    const run = this.run(options.manual === true).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(manual: boolean): Promise<PhoneCaptureSyncResult> {
    const settings = this.options.settings();
    const empty = { saved: [], alreadyInVault: 0, deferred: 0, failed: 0 };
    if (!settings.enabled) return { ...empty, skipped: "disabled" };
    const licenseKey = settings.licenseKey.trim();
    if (!licenseKey) return { ...empty, skipped: "signed_out" };
    if (this.upgradeRequired && !manual) return { ...empty, skipped: "unavailable" };

    const folder = normalizePath(settings.folder.trim() || DEFAULT_PHONE_CAPTURE_FOLDER);
    const saved: string[] = [];
    let alreadyInVault = 0;
    let deferred = 0;
    let failed = 0;
    let cursor: string | null = null;
    try {
      for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
        const listed = await this.list(licenseKey, cursor);
        const pending: PhoneCapture[] = [];
        for (const capture of listed.captures) {
          const existing = this.findInVault(capture.id);
          if (existing) {
            if (await this.acknowledge(licenseKey, capture.id, existing)) alreadyInVault += 1;
            else failed += 1;
          } else if (this.declined.has(capture.id)) {
            deferred += 1;
          } else {
            pending.push(capture);
          }
        }

        let accepted = pending;
        if (pending.length > 0 && settings.askBeforeSaving
          && !(await this.options.confirm(pending, folder))) {
          for (const capture of pending) this.declined.add(capture.id);
          deferred += pending.length;
          accepted = [];
        }

        for (const capture of accepted) {
          let path: string;
          try {
            path = await this.write(capture, folder);
          } catch (error) {
            failed += 1;
            this.options.onError?.("Couldn't save an iOS capture to the vault.", error);
            continue;
          }
          saved.push(path);
          // A failed acknowledgement is retried next sync from the note's frontmatter.
          if (!(await this.acknowledge(licenseKey, capture.id, path))) failed += 1;
        }

        cursor = listed.nextCursor;
        if (!cursor) break;
      }
    } catch (error) {
      if (error instanceof PhoneCaptureApiError && error.status === 426) this.upgradeRequired = true;
      this.options.onError?.("Couldn't check for iOS captures.", error);
      if (manual) this.options.notify(this.describeFailure(error));
      return { saved, alreadyInVault, deferred, failed: failed + 1, skipped: "unavailable" };
    }

    if (saved.length > 0) {
      this.options.notify(
        saved.length === 1
          ? `Saved 1 iOS capture to ${folder}.`
          : `Saved ${saved.length} iOS captures to ${folder}.`,
      );
    } else if (manual) {
      this.options.notify(deferred > 0 ? "iOS captures are waiting to be saved." : "No new iOS captures.");
    }
    return { saved, alreadyInVault, deferred, failed };
  }

  private describeFailure(error: unknown): string {
    if (error instanceof PhoneCaptureApiError) {
      if (error.status === 401 || error.status === 403) return "Sign in to SystemSculpt to receive iOS captures.";
      if (error.status === 426) return "Update SystemSculpt to receive iOS captures.";
    }
    return "Couldn't check for iOS captures. Try again in a moment.";
  }

  private async list(
    licenseKey: string,
    cursor: string | null,
  ): Promise<Readonly<{ captures: PhoneCapture[]; nextCursor: string | null }>> {
    const query = new URLSearchParams({ status: "ready", limit: String(PAGE_LIMIT) });
    if (cursor) query.set("after", cursor);
    const payload = await this.request(licenseKey, "GET", `/captures?${query.toString()}`);
    const captures = isRecord(payload) && Array.isArray(payload.captures) ? payload.captures : [];
    const nextCursor = isRecord(payload) && typeof payload.next_cursor === "string" && payload.next_cursor
      ? payload.next_cursor
      : null;
    return {
      captures: captures.map(decodePhoneCapture).filter((c): c is PhoneCapture => c !== null),
      nextCursor,
    };
  }

  private async acknowledge(licenseKey: string, captureId: string, vaultPath: string): Promise<boolean> {
    try {
      await this.request(
        licenseKey,
        "POST",
        `/captures/${encodeURIComponent(captureId)}/ack`,
        { vault_path: vaultPath },
        ackIdempotencyKey(captureId, vaultPath),
      );
      return true;
    } catch (error) {
      this.options.onError?.("Couldn't mark an iOS capture as delivered.", error);
      return false;
    }
  }

  private async request(
    licenseKey: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const response = await this.requestClient.request({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        ...SystemSculptEnvironment.buildHeaders(licenseKey),
        "x-plugin-version": this.options.pluginVersion,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body,
      licenseKey,
      allowTransportFallback: method === "GET",
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      throw new PhoneCaptureApiError(
        typeof error.message === "string" ? error.message : `Capture request failed (${response.status}).`,
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
      );
    }
    return payload;
  }

  /** The note that already holds this capture, by its `capture_id` frontmatter. */
  private findInVault(captureId: string): string | null {
    const { vault, metadataCache } = this.options.app;
    const remembered = this.written.get(captureId);
    if (remembered && vault.getAbstractFileByPath(remembered) instanceof TFile) return remembered;
    for (const file of vault.getMarkdownFiles()) {
      if (metadataCache.getFileCache(file)?.frontmatter?.capture_id === captureId) return file.path;
    }
    return null;
  }

  private async write(capture: PhoneCapture, folder: string): Promise<string> {
    const { vault } = this.options.app;
    await ensureVaultFolder(this.options.app, folder);
    const stem = toSafeVaultFileName(
      `${capture.title || "iOS capture"} ${localDate(capture.createdAt)}`,
      { fallback: "iOS capture", maxBytes: 180 },
    );
    const content = renderPhoneCaptureNote(capture);
    // macOS, Windows and iOS disks ignore letter case, so a note whose name
    // differs only in case already holds the path there.
    const taken = new Set(vault.getMarkdownFiles().map((file) => file.path.toLowerCase()));
    for (let n = 1; n <= MAX_COLLISION_SUFFIX; n += 1) {
      const path = normalizePath(`${folder}/${n === 1 ? stem : `${stem} ${n}`}.md`);
      if (vault.getAbstractFileByPath(path) || taken.has(path.toLowerCase())) continue;
      try {
        await vault.create(path, content);
      } catch (error) {
        // Another writer took the name between the check and the create.
        if (vault.getAbstractFileByPath(path)) continue;
        throw error;
      }
      this.written.set(capture.id, path);
      return path;
    }
    throw new Error("No free file name for the capture.");
  }
}
