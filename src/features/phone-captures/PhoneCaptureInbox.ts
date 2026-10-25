import { type App, type EventRef, type TAbstractFile, TFile, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { PlatformRequestClient } from "../../services/PlatformRequestClient";
import { SystemSculptEnvironment } from "../../services/api/SystemSculptEnvironment";
import { ensureVaultFolder } from "../../tools/vault/utils";
import { sha256HexFromBytesPortable } from "../../utils/sha256";
import { toSafeVaultFileName } from "../../utils/vaultFileName";

type PhoneCaptureFormat =
  | { mode: "note" | "transcript"; meetingFrontmatter: null }
  | { mode: "meeting"; meetingFrontmatter: string };

/** Captures the iPhone app sent to the server, waiting for a vault. */
export type PhoneCapture = Readonly<{
  id: string;
  createdAt: string;
  title: string;
  markdown: string;
  tags: readonly string[];
  source: string;
} & PhoneCaptureFormat>;

/** @internal Tests type their fixtures with this. */
export type PhoneCaptureSettings = Readonly<{
  licenseKey: string;
  enabled: boolean;
  folder: string;
  meetingsFolder: string;
  askBeforeSaving: boolean;
  /** The account has used the iOS app. Until then the inbox is never polled. */
  linked: boolean;
}>;

export type PhoneCaptureSyncResult = Readonly<{
  /** Notes written by this sync and verified in the vault before acknowledgement. */
  saved: readonly string[];
  /** Captures already in the vault that were only acknowledged. */
  alreadyInVault: number;
  /** Captures the user chose not to save yet. */
  deferred: number;
  /** Failed saves, acknowledgements, or inbox checks. */
  failed: number;
  /** Subset of failed: notes verified in the vault whose acknowledgement failed. */
  unacknowledged: number;
  skipped?: "disabled" | "signed_out" | "not_linked" | "busy" | "unavailable";
}>;

export type PhoneCaptureInboxOptions = Readonly<{
  app: App;
  settings: () => PhoneCaptureSettings;
  pluginVersion: string;
  /** Asks whether to save these captures now. Required for "ask before saving". */
  confirm: (captures: readonly PhoneCapture[], folder: string) => Promise<boolean>;
  notify: (message: string) => void;
  /** Whether the account has used the iOS app; false when the server doesn't say. Rejects when it can't ask. */
  checkLinked: () => Promise<boolean>;
  /** Remembers the link, so later startups poll the inbox right away. */
  onLinked: (licenseKey: string) => Promise<void>;
  onError?: (message: string, error: unknown) => void;
  requestClient?: PlatformRequestClient;
  baseUrl?: string;
  now?: () => number;
}>;

export const DEFAULT_PHONE_CAPTURE_FOLDER = "SystemSculpt/Inbox";
export const DEFAULT_PHONE_MEETING_FOLDER = "SystemSculpt/Meetings";
/** Background polls while Obsidian is open. */
export const PHONE_CAPTURE_POLL_INTERVAL_MS = 5 * 60_000;
/** Focus and resume events closer together than this share one sync. */
export const PHONE_CAPTURE_MIN_SYNC_GAP_MS = 60_000;
/**
 * Before the account has used the iOS app, background triggers ask about the link this often.
 * @internal Tests assert against this value.
 */
export const PHONE_CAPTURE_LINK_CHECK_GAP_MS = 30 * 60_000;
const PAGE_LIMIT = 50;
const MAX_PAGES_PER_SYNC = 10;
const CAPTURE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The server transcribes recordings up to 8 hours: about 450,000 characters of speech. */
const MAX_MARKDOWN_CHARS = 1_000_000;
const MAX_FRONTMATTER_CHARS = 64 * 1024;
/**
 * The largest note identity reconciliation reads. A capture note (up to 3
 * UTF-8 bytes per markdown character, plus frontmatter) must fit, or a long
 * capture is saved but never verified and acknowledged.
 */
const MAX_IDENTITY_NOTE_BYTES = 4 * 1024 * 1024;
/** Includes reading back each note the sync writes: about ten of the largest. */
const MAX_IDENTITY_READ_BYTES_PER_SYNC = 32 * 1024 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_COLLISION_SUFFIX = 100;

class PhoneCaptureApiError extends Error {
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
function decodePhoneCapture(value: unknown): PhoneCapture | null {
  if (!isRecord(value)) return null;
  const { id, created_at: createdAt, title, markdown, tags, source } = value;
  if (typeof id !== "string" || !CAPTURE_ID.test(id)) return null;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return null;
  if (typeof markdown !== "string" || markdown.length > MAX_MARKDOWN_CHARS) return null;
  if (value.status !== undefined && value.status !== "ready") return null;
  let format: PhoneCaptureFormat;
  if (value.mode === "meeting") {
    const frontmatter = isRecord(value.meeting) ? value.meeting.frontmatter : null;
    if (typeof frontmatter !== "string" || !frontmatter.endsWith("\n")
      || frontmatter.length > MAX_FRONTMATTER_CHARS || /^(?:---|\.\.\.)[ \t]*\r?$/m.test(frontmatter)) return null;
    try {
      const parsed: unknown = parseYaml(frontmatter);
      if (!isRecord(parsed) || parsed.capture_id !== id || parsed.type !== "meeting") return null;
    } catch {
      return null;
    }
    format = { mode: "meeting", meetingFrontmatter: frontmatter };
  } else {
    // Missing mode is the original note contract. Unknown additive modes use
    // the same portable note representation until the client knows their UI.
    format = { mode: value.mode === "transcript" ? "transcript" : "note", meetingFrontmatter: null };
  }
  return {
    ...format,
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
function renderPhoneCaptureNote(capture: PhoneCapture): string {
  // Meeting metadata and body are rendered by the server. Keep the canonical
  // bytes shared with the iPhone export; parsing above validates identity only.
  const frontmatter = capture.meetingFrontmatter ?? stringifyYaml({
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
  /** Captures the user declined to save; asked again only by a manual sync. */
  private readonly declined = new Set<string>();
  /** The server rejected this plugin version; stop polling until restart. */
  private upgradeRequired = false;
  private lastLinkCheckAt = Number.NEGATIVE_INFINITY;
  private accountKey = "";

  private refreshAccount(): void {
    const key = this.options.settings().licenseKey.trim();
    if (key === this.accountKey) return;
    this.accountKey = key;
    this.lastSyncAt = this.lastLinkCheckAt = Number.NEGATIVE_INFINITY;
    this.declined.clear();
    this.upgradeRequired = false;
  }

  private isCurrentAccount(licenseKey: string): boolean {
    return this.options.settings().licenseKey.trim() === licenseKey;
  }

  private requireCurrentAccount(licenseKey: string): void {
    if (!this.isCurrentAccount(licenseKey)) throw new Error("The capture account changed during sync.");
  }

  constructor(private readonly options: PhoneCaptureInboxOptions) {
    this.baseUrl = (options.baseUrl ?? SystemSculptEnvironment.resolveBaseUrl()).replace(/\/+$/, "");
    this.requestClient = options.requestClient ?? new PlatformRequestClient();
  }

  /** Background trigger (startup, focus, timer): skipped when a sync ran recently. */
  maybeSync(): Promise<PhoneCaptureSyncResult> | null {
    this.refreshAccount();
    const now = (this.options.now ?? Date.now)();
    if (this.running || now - this.lastSyncAt < PHONE_CAPTURE_MIN_SYNC_GAP_MS) return null;
    return this.sync();
  }

  /** Another read reported the account's iOS app link: check it now instead of on the next trigger. */
  linkReported(): Promise<PhoneCaptureSyncResult> | null {
    if (this.running || this.options.settings().linked) return null;
    this.lastLinkCheckAt = Number.NEGATIVE_INFINITY;
    return this.sync();
  }

  /** Runs one sync, or joins the one in progress. `manual` asks again about declined captures. */
  sync(options: Readonly<{ manual?: boolean }> = {}): Promise<PhoneCaptureSyncResult> {
    if (this.running) return this.running;
    this.refreshAccount();
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
    const empty = { saved: [], alreadyInVault: 0, deferred: 0, failed: 0, unacknowledged: 0 };
    if (!settings.enabled) return { ...empty, skipped: "disabled" };
    const licenseKey = settings.licenseKey.trim();
    if (!licenseKey) return { ...empty, skipped: "signed_out" };
    if (this.upgradeRequired && !manual) return { ...empty, skipped: "unavailable" };

    const folder = normalizePath(settings.folder.trim() || DEFAULT_PHONE_CAPTURE_FOLDER);
    const meetingsFolder = normalizePath(settings.meetingsFolder.trim() || DEFAULT_PHONE_MEETING_FOLDER);
    const destination = (capture: PhoneCapture) => capture.mode === "meeting" ? meetingsFolder : folder;
    if (!settings.linked && !(await this.detectLink(manual, licenseKey))) return { ...empty, skipped: "not_linked" };
    const saved: string[] = [];
    let alreadyInVault = 0;
    let deferred = 0;
    let failed = 0;
    let unacknowledged = 0;
    let checkFailure: string | undefined;
    let cursor: string | null = null;
    // One bounded index per sync, kept current by vault events across every await.
    // Nothing (including listeners or remembered paths) survives the sync.
    const identity = new CaptureNoteIndex(this.options.app);
    try {
      for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
        this.requireCurrentAccount(licenseKey);
        const listed = await this.list(licenseKey, cursor);
        this.requireCurrentAccount(licenseKey);
        const pending: PhoneCapture[] = [];
        for (const capture of listed.captures) {
          const existing = await identity.use(() => {
            this.requireCurrentAccount(licenseKey);
            const path = identity.find(capture.id);
            return path ? this.acknowledge(licenseKey, capture.id, path) : null;
          });
          if (existing !== null) {
            if (existing) alreadyInVault += 1;
            else {
              failed += 1;
              unacknowledged += 1;
            }
          } else if (this.declined.has(capture.id)) {
            deferred += 1;
          } else {
            pending.push(capture);
          }
        }

        this.requireCurrentAccount(licenseKey);
        let accepted = pending;
        if (pending.length > 0 && settings.askBeforeSaving
          && !(await this.options.confirm(pending, [...new Set(pending.map(destination))].join(" and ")))) {
          this.requireCurrentAccount(licenseKey);
          for (const capture of pending) this.declined.add(capture.id);
          deferred += pending.length;
          accepted = [];
        }

        for (const capture of accepted) {
          try {
            this.requireCurrentAccount(licenseKey);
            const written = await this.write(capture, destination(capture), identity, licenseKey);
            // Reconcile again after create: never acknowledge a deleted/replaced
            // file, and use the actual path if it moved while the write completed.
            const acknowledged = await identity.use(() => {
              this.requireCurrentAccount(licenseKey);
              const path = identity.find(capture.id);
              if (!path) throw new Error("The saved capture is no longer in the vault.");
              if (written) saved.push(path);
              return this.acknowledge(licenseKey, capture.id, path);
            });
            if (!acknowledged) {
              failed += 1;
              unacknowledged += 1;
            } else if (!written) alreadyInVault += 1;
          } catch (error) {
            if (!this.isCurrentAccount(licenseKey)) throw error;
            failed += 1;
            this.options.onError?.("Couldn't save an iOS capture to the vault.", error);
          }
        }

        cursor = listed.nextCursor;
        if (!cursor) break;
      }
    } catch (error) {
      if (!this.isCurrentAccount(licenseKey)) return { ...empty, skipped: "signed_out" };
      if (error instanceof PhoneCaptureApiError && error.status === 426) this.upgradeRequired = true;
      this.options.onError?.("Couldn't check for iOS captures.", error);
      failed += 1;
      checkFailure = this.describeFailure(error);
    } finally {
      identity.dispose();
    }

    const result: PhoneCaptureSyncResult = {
      saved, alreadyInVault, deferred, failed, unacknowledged,
      ...(checkFailure ? { skipped: "unavailable" as const } : {}),
    };
    if (this.isCurrentAccount(licenseKey) && (manual || saved.length > 0)) this.notifyResult(result, manual, checkFailure);
    return result;
  }

  /**
   * A manual sync always answers. An automatic one stays quiet when every
   * capture saved, and speaks only when something it saved came with a
   * failure, so the new notes themselves are the receipt.
   */
  private notifyResult(result: PhoneCaptureSyncResult, manual: boolean, checkFailure?: string): void {
    const { saved, alreadyInVault, deferred, failed, unacknowledged } = result;
    const captures = (count: number) => `${count} iOS capture${count === 1 ? "" : "s"}`;
    const saveFailures = failed - unacknowledged - (checkFailure ? 1 : 0);
    if (!manual && !saveFailures && !unacknowledged && !checkFailure) return;
    const messages: string[] = [];
    if (saved.length) {
      const folders = [...new Set(saved.map(path => path.split("/").slice(0, -1).join("/") || "the vault root"))];
      messages.push(`Saved ${captures(saved.length)} to ${folders.join(" and ")}.`);
    }
    if (alreadyInVault) {
      messages.push(`${captures(alreadyInVault)} ${alreadyInVault === 1 ? "is" : "are"} already in this vault.`);
    }
    if (saveFailures) messages.push(`Couldn't save ${captures(saveFailures)}.`);
    if (unacknowledged) messages.push(`Delivery confirmation pending for ${captures(unacknowledged)} already in this vault.`);
    if (deferred) messages.push("iOS captures are waiting to be saved.");
    if (saveFailures || unacknowledged) messages.push("Sync again to retry.");
    if (checkFailure) messages.push(checkFailure);
    this.options.notify(messages.length ? messages.join(" ") : "No new iOS captures.");
  }

  /**
   * Until the account has used the iOS app the inbox stays dormant: no
   * capture requests and no notices. The first time the server reports the
   * link, it is remembered; the iOS captures settings show where notes go.
   */
  private async detectLink(manual: boolean, licenseKey: string): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    if (!manual && now - this.lastLinkCheckAt < PHONE_CAPTURE_LINK_CHECK_GAP_MS) return false;
    this.lastLinkCheckAt = now;
    try {
      if (!(await this.options.checkLinked()) || !this.isCurrentAccount(licenseKey)) return false;
      await this.options.onLinked(licenseKey);
      if (!this.isCurrentAccount(licenseKey)) return false;
    } catch (error) {
      this.options.onError?.("Couldn't check whether the iOS app is linked.", error);
      return false;
    }
    return true;
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

  private async write(capture: PhoneCapture, folder: string, identity: CaptureNoteIndex, licenseKey: string): Promise<string | null> {
    const { vault } = this.options.app;
    await ensureVaultFolder(this.options.app, folder);
    const stem = toSafeVaultFileName(
      `${capture.title || "iOS capture"} ${localDate(capture.createdAt)}`,
      { fallback: "iOS capture", maxBytes: 180 },
    );
    const content = renderPhoneCaptureNote(capture);
    for (let n = 1; n <= MAX_COLLISION_SUFFIX; n += 1) {
      const path = normalizePath(`${folder}/${n === 1 ? stem : `${stem} ${n}`}.md`);
      const outcome = await identity.use(() => {
        // Confirmation, folder creation and collision retries all yield. Check
        // identity again, with no await between that check and starting create.
        this.requireCurrentAccount(licenseKey);
        if (identity.find(capture.id)) return "existing" as const;
        if (vault.getAbstractFileByPath(path) || identity.hasPath(path)) return "collision" as const;
        return vault.create(path, content).then(() => "created" as const, (error: unknown) => {
          if (vault.getAbstractFileByPath(path)) return "collision" as const;
          throw error;
        });
      });
      if (outcome === "existing") return null;
      if (outcome === "created") return path;
    }
    throw new Error("No free file name for the capture.");
  }
}

/**
 * A sync-scoped view of actual note identities. Indexed notes need no disk
 * reads; only unindexed or changed notes are read, sequentially. Uncertainty
 * (read failure, churn or a budget limit) stops delivery, never means absent.
 */
class CaptureNoteIndex {
  private readonly entries = new Map<TFile, { path: string; id: string | null }>();
  private readonly ids = new Map<string, Set<TFile>>();
  private readonly paths = new Map<string, number>();
  private readonly dirty = new Map<TFile, number>();
  private readonly refs: EventRef[];
  private initialized = false;
  private rebuild = false;
  private exhausted = false;
  private changes = 0;
  private scans = 0;
  private reads = 0;
  private bytes = 0;

  constructor(private readonly app: App) {
    const { vault } = app;
    const changed = (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return;
      this.remove(file);
      this.dirty.delete(file);
      if (++this.changes > 4096 || this.dirty.size >= 4096) {
        this.exhausted = true;
      } else if (file.extension === "md") {
        this.dirty.set(file, this.changes);
      }
    };
    this.refs = [
      vault.on("create", changed),
      vault.on("modify", changed),
      vault.on("rename", (file) => {
        if (file instanceof TFile) changed(file);
        else this.rebuild = true; // A folder move changes all descendant paths.
      }),
      vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.remove(file);
          this.dirty.delete(file);
        } else this.rebuild = true;
      }),
    ];
  }

  dispose(): void {
    for (const ref of this.refs) this.app.vault.offref(ref);
  }

  find(id: string): string | null {
    return this.ids.get(id)?.values().next().value?.path ?? null;
  }

  hasPath(path: string): boolean {
    return this.paths.has(path.toLowerCase());
  }

  /** Invoke the action without yielding after reconciliation, even to a caller. */
  async use<T>(action: () => T | Promise<T>): Promise<T> {
    for (;;) {
      if (this.exhausted) throw new Error("Capture identity reconciliation changed too often. Retry after indexing.");
      if (!this.initialized || this.rebuild) this.scan();
      const next = this.dirty.entries().next().value;
      if (!next) return action();
      const [file, change] = next;
      const { vault } = this.app;
      if (vault.getAbstractFileByPath(file.path) !== file) {
        this.dirty.delete(file);
        continue;
      }
      const { size, mtime } = file.stat;
      // Bound both work and allocation; retry after Obsidian indexes a large
      // import instead of scanning all of its contents or creating duplicates.
      if (++this.reads > 1024 || size > MAX_IDENTITY_NOTE_BYTES
        || (this.bytes += size) > MAX_IDENTITY_READ_BYTES_PER_SYNC) {
        throw new Error("Capture identity read budget reached. Retry after indexing.");
      }
      const content = await vault.read(file);
      if (this.dirty.get(file) !== change) continue;
      if (file.stat.size !== size || file.stat.mtime !== mtime) continue;
      if (content.length > MAX_IDENTITY_NOTE_BYTES) throw new Error("Capture identity note is too large.");
      // Only parse YAML frontmatter, never capture_id-like text in the body.
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content)?.[1];
      if (frontmatter && frontmatter.length > MAX_FRONTMATTER_CHARS) throw new Error("Capture frontmatter is too large.");
      const parsed: unknown = frontmatter ? parseYaml(frontmatter) : null;
      this.put(file, isRecord(parsed) ? parsed.capture_id : null);
      this.dirty.delete(file);
    }
  }

  private scan(): void {
    const files = this.app.vault.getMarkdownFiles();
    if (++this.scans > 3 || files.length > 100_000) throw new Error("Capture identity scan budget reached.");
    this.entries.clear();
    this.ids.clear();
    this.paths.clear();
    // Keep invalidations across a folder-triggered rescan: cached metadata may
    // still describe the old contents of a file changed during this sync.
    for (const file of files) {
      if (this.dirty.has(file)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      // obsidian://new can create an empty file, then fill it. A non-null
      // empty snapshot is not evidence that the nonempty note has no identity.
      if (cache && (file.stat.size === 0 || cache.sections?.length || cache.frontmatter)) {
        this.put(file, cache.frontmatter?.capture_id);
      } else this.dirty.set(file, this.changes);
    }
    this.initialized = true;
    this.rebuild = false;
  }

  private remove(file: TFile): void {
    const old = this.entries.get(file);
    if (!old) return;
    this.entries.delete(file);
    const path = old.path.toLowerCase();
    const count = this.paths.get(path)!;
    if (count === 1) this.paths.delete(path);
    else this.paths.set(path, count - 1);
    if (old.id) {
      const matches = this.ids.get(old.id)!;
      matches.delete(file);
      if (!matches.size) this.ids.delete(old.id);
    }
  }

  private put(file: TFile, value: unknown): void {
    this.remove(file);
    if (this.entries.size >= 100_000) throw new Error("Capture identity index is full.");
    const id = typeof value === "string" && CAPTURE_ID.test(value) ? value : null;
    this.entries.set(file, { path: file.path, id });
    const path = file.path.toLowerCase();
    this.paths.set(path, (this.paths.get(path) ?? 0) + 1);
    if (id) {
      const matches = this.ids.get(id) ?? new Set<TFile>();
      matches.add(file);
      this.ids.set(id, matches);
    }
  }
}
