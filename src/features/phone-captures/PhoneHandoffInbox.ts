import { type App, TFile, parseYaml, stringifyYaml } from "obsidian";
import { PlatformRequestClient } from "../../services/PlatformRequestClient";
import { SystemSculptEnvironment } from "../../services/api/SystemSculptEnvironment";
import { ensureVaultFolder } from "../../tools/vault/utils";
import { sha256HexFromBytesPortable } from "../../utils/sha256";
import { parseRetryAfterMs } from "../../utils/retryAfter";
import { PHONE_CAPTURE_MIN_SYNC_GAP_MS, PHONE_CAPTURE_POLL_INTERVAL_MS } from "./PhoneCaptureInbox";

export type HandoffAgent = "systemsculpt" | "claude_code" | "codex";
type HandoffStatus = "pending" | "claimed" | "running" | "needs_approval" | "completed" | "failed" | "cancelled";
export type PhoneHandoff = Readonly<{
  id: string;
  capture_id: string;
  vault_id: string;
  instruction: string;
  agent: HandoffAgent;
  status: HandoffStatus;
  lease_expires_at: string | null;
}>;
export type HandoffSource = Readonly<{ title: string; markdown: string; path: string | null }>;
export type PhoneHandoffItem = Readonly<{
  id: string;
  instruction: string;
  agent: HandoffAgent;
  source: HandoffSource | null;
  state: "pending" | "starting" | "running" | "needs_approval" | "completed" | "failed";
  message?: string;
  resultPath?: string;
}>;
export type HandoffExecution = Readonly<{
  handoff: PhoneHandoff;
  source: HandoffSource;
  reveal: boolean;
  signal: AbortSignal;
  onApproval: (waiting: boolean) => void;
}>;
type Settings = Readonly<{ licenseKey: string; linked: boolean; autoRun: boolean; vaultId: string }>;
type Options = Readonly<{
  app: App;
  pluginVersion: string;
  settings: () => Settings;
  instanceId: string;
  availableAgents: () => Promise<readonly HandoffAgent[]>;
  /** One native or managed ChatSession turn. The session, not this inbox, owns execution and approvals. */
  execute: (execution: HandoffExecution) => Promise<string>;
  requestClient?: PlatformRequestClient;
  baseUrl?: string;
  now?: () => number;
}>;
type Entry = { handoff: PhoneHandoff; item: PhoneHandoffItem };
type Receipt = { file: TFile; data: Record<string, unknown> };
type Active = { abort: AbortController; licenseKey: string; leaseToken: string; expiresAt: number; status: "running" | "needs_approval"; reports: Promise<void>; reportError?: Error; completing?: boolean };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const AGENTS = new Set<unknown>(["systemsculpt", "claude_code", "codex"]);
const STATUSES = new Set<unknown>(["pending", "claimed", "running", "needs_approval", "completed", "failed", "cancelled"]);
const RESULT_FOLDER = "SystemSculpt/Handoffs";
// Two existing inbox polling periods leave room for a delayed heartbeat. This
// is queue ownership, not an execution timeout: it renews throughout approvals.
const LEASE_MS = PHONE_CAPTURE_POLL_INTERVAL_MS * 2;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function relativeMarkdownPath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\\") && ![...value].some(char => char.charCodeAt(0) < 32) && !value.startsWith("/")
    && !value.includes(":") && value.endsWith(".md") && value.split("/").every(part => part !== ".." && part !== "." && part !== "");
}
export function decodePhoneHandoff(value: unknown): PhoneHandoff | null {
  if (!record(value) || typeof value.id !== "string" || !UUID.test(value.id)
    || typeof value.capture_id !== "string" || !UUID.test(value.capture_id)
    || typeof value.vault_id !== "string" || !UUID.test(value.vault_id)
    || typeof value.instruction !== "string" || !value.instruction.trim()
    || !AGENTS.has(value.agent) || !STATUSES.has(value.status)
    || (value.lease_expires_at !== null && (typeof value.lease_expires_at !== "string" || !Number.isFinite(Date.parse(value.lease_expires_at))))) return null;
  return value as unknown as PhoneHandoff;
}
class HandoffApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Handoff request failed (${status}).`); }
}

/** Queue delivery and vault receipts only; never an agent continuation loop. */
export class PhoneHandoffInbox {
  private readonly client: PlatformRequestClient;
  private readonly baseUrl: string;
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, Active>();
  private readonly pendingStatus = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private polling: Promise<void> | null = null;
  private account = "";
  private disposed = false;
  private retryAt = 0;

  constructor(private readonly options: Options) {
    this.client = options.requestClient ?? new PlatformRequestClient();
    this.baseUrl = (options.baseUrl ?? SystemSculptEnvironment.resolveBaseUrl()).replace(/\/+$/, "");
  }

  get items(): readonly PhoneHandoffItem[] { return [...this.entries.values()].map(entry => entry.item); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private update(id: string, changes: Partial<PhoneHandoffItem>): void {
    const entry = this.entries.get(id);
    if (entry) { entry.item = { ...entry.item, ...changes }; this.emit(); }
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private current(key: string): boolean { return !this.disposed && this.options.settings().licenseKey.trim() === key; }
  private requireCurrent(key: string): void { if (!this.current(key)) throw new Error("The handoff account changed."); }

  /** Called on startup, focus and the existing five-minute capture timer. */
  poll(): Promise<void> {
    const key = this.options.settings().licenseKey.trim();
    if (key !== this.account) {
      for (const run of this.active.values()) run.abort.abort();
      this.entries.clear();
      this.pendingStatus.clear();
      this.account = key;
      this.retryAt = 0;
      this.emit();
    }
    if (this.disposed || !key || !this.options.settings().linked || this.now() < this.retryAt) return Promise.resolve();
    if (this.polling) return this.polling;
    const run = this.scan(key).finally(() => { if (this.polling === run) this.polling = null; });
    this.polling = run;
    return run;
  }

  private async scan(key: string): Promise<void> {
    const { vaultId } = this.options.settings();
    if (!UUID.test(vaultId) || !UUID.test(this.options.instanceId)) return;
    const agents = await this.options.availableAgents();
    this.requireCurrent(key);
    await this.request(key, "PUT", "/handoffs/capabilities", {
      vault_id: vaultId, plugin_instance_id: this.options.instanceId,
      vault_name: this.options.app.vault.getName(), agents,
    });
    await this.reconcileStatus(key);
    let cursor: string | null = null;
    const seen = new Set<string>();
    const cursors = new Set<string>();
    do {
      const query = new URLSearchParams({ status: "pending", vault_id: vaultId });
      if (cursor) query.set("after", cursor);
      const response = await this.request(key, "GET", `/handoffs?${query}`);
      if (!record(response) || !Array.isArray(response.handoffs)
        || !(response.next_cursor === null || typeof response.next_cursor === "string")) throw new Error("Invalid handoff list.");
      for (const raw of response.handoffs) {
        const handoff = decodePhoneHandoff(raw);
        if (!handoff || handoff.vault_id !== vaultId || !agents.includes(handoff.agent)) continue;
        if (["completed", "failed", "cancelled"].includes(handoff.status)) continue;
        seen.add(handoff.id);
        if (this.active.has(handoff.id)) continue;
        const entry = this.entries.get(handoff.id);
        if (entry?.item.state === "completed") continue;
        const source = await this.source(key, handoff.capture_id);
        this.requireCurrent(key);
        this.entries.set(handoff.id, {
          handoff,
          item: { id: handoff.id, instruction: handoff.instruction, agent: handoff.agent, source, state: "pending" },
        });
        this.emit();
        if (this.options.settings().autoRun) void this.run(handoff.id, false);
      }
      cursor = response.next_cursor;
      if (cursor && cursors.has(cursor)) throw new Error("Repeated handoff cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.requireCurrent(key);
    for (const [id, entry] of this.entries) {
      if (!seen.has(id) && !this.active.has(id) && entry.item.state === "pending") this.entries.delete(id);
    }
    this.emit();
  }

  /** Explicit Run, or the user's opt-in setting. Claim before any local effect. */
  async run(id: string, reveal = true): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.item.source || entry.item.state !== "pending" || this.active.has(id) || this.disposed) return;
    const key = this.account;
    const run: Active = { abort: new AbortController(), licenseKey: key, leaseToken: "", expiresAt: 0, status: "running", reports: Promise.resolve() };
    this.active.set(id, run);
    this.update(id, { state: "starting", message: undefined });
    let heartbeat: number | undefined;
    try {
      this.requireCurrent(key);
      const response = await this.request(key, "POST", `/handoffs/${id}/claim`, {
        plugin_instance_id: this.options.instanceId, lease_expires_at: this.expiry(),
      });
      const claimed = record(response) ? decodePhoneHandoff(response.handoff) : null;
      if (!claimed || claimed.id !== id || claimed.vault_id !== entry.handoff.vault_id || claimed.agent !== entry.handoff.agent
        || claimed.capture_id !== entry.handoff.capture_id || claimed.instruction !== entry.handoff.instruction
        || !claimed.lease_expires_at || !record(response) || typeof response.lease_token !== "string" || !response.lease_token) throw new Error("Invalid handoff claim.");
      run.leaseToken = response.lease_token;
      run.expiresAt = Date.parse(claimed.lease_expires_at);
      this.requireLease(run);
      heartbeat = window.setInterval(() => { void this.progress(id, run); }, PHONE_CAPTURE_MIN_SYNC_GAP_MS);
      const path = `${RESULT_FOLDER}/${id}.md`;
      const account = this.accountHash(key);
      await ensureVaultFolder(this.options.app, RESULT_FOLDER);
      const receipt = await this.findReceipt(id, key);
      this.requireLease(run);
      if (receipt) {
        if (receipt.data.handoff_state === "completed" && typeof receipt.data.handoff_result === "string" && receipt.data.handoff_result.trim()) {
          await this.complete(id, run, receipt.data.handoff_result, receipt.file);
          return;
        }
        // A lease cannot fence native side effects. Never replay a turn whose
        // durable start receipt exists, including after its note moved.
        throw new Error("This handoff was already started. Review its agent workspace and result note before sending a new handoff.");
      }
      if (this.options.app.vault.getAbstractFileByPath(path)) throw new Error("The handoff result path is occupied.");
      const initial = this.note(entry, account);
      const file = await this.options.app.vault.create(path, initial);
      this.requireLease(run);
      await this.progress(id, run);
      this.requireLease(run);
      const result = await this.options.execute({
        handoff: claimed, source: entry.item.source, reveal, signal: run.abort.signal,
        onApproval: waiting => {
          if (run.completing || run.abort.signal.aborted || this.active.get(id) !== run) return;
          run.status = waiting ? "needs_approval" : "running";
          this.update(id, { state: run.status });
          void this.progress(id, run);
        },
      });
      this.requireLease(run);
      if (!result.trim()) throw new Error("The agent did not return a result. Review the agent workspace before sending a new handoff.");
      // Preserve a user's edits or a concurrent writer rather than overwriting.
      const completed = this.note(entry, account, result);
      await this.options.app.vault.process(file, contents => {
        this.requireLease(run);
        if (contents !== initial) throw new Error("The result note changed while the handoff ran. The agent workspace still has the result.");
        return completed;
      });
      if (await this.options.app.vault.read(file) !== completed) throw new Error("The handoff result could not be verified in the vault.");
      this.requireLease(run);
      await this.complete(id, run, result, file);
    } catch (error) {
      run.abort.abort();
      if (this.current(key)) {
        this.pendingStatus.add(id);
        const failure = run.reportError ?? error;
        const message = this.failureMessage(failure);
        this.update(id, { state: "failed", message });
        // Do not terminally fail after a transport error: completion may already
        // have committed, or a verified result needs reporting on the next poll.
        if (run.leaseToken && !(failure instanceof HandoffApiError) && run.expiresAt > this.now()) {
          await run.reports;
          await this.request(key, "POST", `/handoffs/${id}/fail`, { ...this.owner(run), error_message: message }).catch(() => undefined);
        }
      }
    } finally {
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
      run.abort.abort();
      if (this.active.get(id) === run) this.active.delete(id);
    }
  }

  private expiry(): string { return new Date(this.now() + LEASE_MS).toISOString(); }
  private owner(run: Active): Record<string, string> { return { plugin_instance_id: this.options.instanceId, lease_token: run.leaseToken }; }
  private requireLease(run: Active): void {
    this.requireCurrent(run.licenseKey);
    if (run.reportError !== undefined) throw run.reportError;
    if (run.abort.signal.aborted || run.expiresAt <= this.now()) { run.abort.abort(); throw new Error("Handoff ownership expired. Local execution was stopped; review the workspace before retrying."); }
  }
  private progress(id: string, run: Active): Promise<void> {
    if (run.completing || run.abort.signal.aborted || this.active.get(id) !== run) return run.reports;
    run.reports = run.reports.then(async () => {
      this.requireLease(run);
      const status = run.status;
      const response = await this.request(run.licenseKey, "POST", `/handoffs/${id}/progress`, {
        ...this.owner(run), status, lease_expires_at: this.expiry(),
      });
      const handoff = record(response) ? decodePhoneHandoff(response.handoff) : null;
      if (!handoff?.lease_expires_at) throw new Error("Invalid handoff progress.");
      run.expiresAt = Date.parse(handoff.lease_expires_at);
      this.requireLease(run);
      this.update(id, { state: status });
    }).catch(error => {
      // Preserve the transport cause so a lost heartbeat does not become a
      // terminal /fail when the stopped execution unwinds through requireLease.
      run.reportError ??= error instanceof Error ? error : new Error("Handoff progress failed.");
      // An uncertain heartbeat must not let an unfenced native run continue.
      run.abort.abort();
      if (this.current(run.licenseKey) && this.active.get(id) === run) this.update(id, { state: "failed", message: this.failureMessage(error) });
    });
    return run.reports;
  }
  private async complete(id: string, run: Active, result: string, file: TFile): Promise<void> {
    // Drain existing status writes, but never race a new heartbeat against a
    // terminal request: its late lease-loss reply could undo the local receipt.
    run.completing = true;
    await run.reports;
    this.requireLease(run);
    const receipt = await this.readReceipt(file, run.licenseKey);
    this.requireLease(run);
    if (receipt?.data.handoff_id !== id || receipt.data.handoff_account !== this.accountHash(run.licenseKey)
      || receipt.data.handoff_state !== "completed" || receipt.data.handoff_result !== result || !relativeMarkdownPath(file.path)) {
      throw new Error("The handoff result could not be verified in the vault.");
    }
    const path = file.path;
    await this.request(run.licenseKey, "POST", `/handoffs/${id}/complete`, { ...this.owner(run), result_summary: result, vault_path: path });
    this.pendingStatus.delete(id);
    this.update(id, { state: "completed", resultPath: path, message: undefined });
  }

  /** The pending feed omits terminal work, including a completion whose reply was lost. */
  private async reconcileStatus(key: string): Promise<void> {
    for (const id of this.pendingStatus) {
      const entry = this.entries.get(id);
      if (!entry || this.active.has(id)) continue;
      let response: unknown;
      try { response = await this.request(key, "GET", `/handoffs/${id}`); }
      catch (error) {
        if (!(error instanceof HandoffApiError) || error.status !== 404) throw error;
        this.pendingStatus.delete(id);
        this.update(id, { state: "failed", message: this.failureMessage(error) });
        continue;
      }
      const handoff = record(response) ? decodePhoneHandoff(response.handoff) : null;
      if (!handoff || handoff.id !== id || handoff.vault_id !== entry.handoff.vault_id
        || handoff.capture_id !== entry.handoff.capture_id || handoff.agent !== entry.handoff.agent
        || handoff.instruction !== entry.handoff.instruction) throw new Error("Invalid handoff status.");
      if (handoff.status === "completed") {
        const receipt = await this.findReceipt(id, key);
        this.requireCurrent(key);
        if (!receipt || receipt.data.handoff_state !== "completed" || typeof receipt.data.handoff_result !== "string"
          || !receipt.data.handoff_result.trim() || !relativeMarkdownPath(receipt.file.path)) continue;
        this.update(id, { state: "completed", resultPath: receipt.file.path, message: undefined });
        this.pendingStatus.delete(id);
      } else if (handoff.status === "failed" || handoff.status === "cancelled") {
        this.pendingStatus.delete(id);
        if (handoff.status === "cancelled") this.update(id, { state: "failed", message: this.failureMessage(new HandoffApiError(409, "handoff_cancelled")) });
      }
    }
  }

  private accountHash(key: string): string { return sha256HexFromBytesPortable(new TextEncoder().encode(key)); }

  private async readReceipt(file: TFile, key: string): Promise<Receipt | null> {
    const contents = await this.options.app.vault.read(file);
    this.requireCurrent(key);
    if (this.options.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error("The handoff note changed during verification.");
    const data = this.receipt(contents);
    return data ? { file, data } : null;
  }

  /** Notes may move. Metadata narrows reads; unindexed or changing notes fail closed. */
  private async findReceipt(id: string, key: string): Promise<Receipt | null> {
    const { vault, metadataCache } = this.options.app;
    const account = this.accountHash(key);
    const dirty = new Set<TFile>();
    let generation = 0;
    const changed = (file: unknown) => { generation += 1; if (file instanceof TFile) dirty.add(file); };
    const refs = [vault.on("create", changed), vault.on("modify", changed), vault.on("rename", changed), vault.on("delete", changed)];
    try {
      for (;;) {
        this.requireCurrent(key);
        const baseline = generation;
        const canonical = vault.getAbstractFileByPath(`${RESULT_FOLDER}/${id}.md`);
        const files = new Set([...(canonical instanceof TFile ? [canonical] : []), ...vault.getMarkdownFiles()]);
        let found: Receipt | null = null;
        for (const file of files) {
          const cache = metadataCache.getFileCache(file);
          if (file !== canonical && !dirty.has(file) && cache && (cache.sections?.length || cache.frontmatter)
            && (cache.frontmatter?.handoff_id !== id || cache.frontmatter?.handoff_account !== account)) continue;
          const receipt = await this.readReceipt(file, key);
          if (generation !== baseline) break;
          if (receipt?.data.handoff_id === id && receipt.data.handoff_account === account) { found = receipt; break; }
        }
        if (generation === baseline) return found;
      }
    } finally { for (const ref of refs) vault.offref(ref); }
  }

  private note(entry: Entry, account: string, result?: string): string {
    return `---\n${stringifyYaml({ handoff_id: entry.handoff.id, handoff_account: account, handoff_state: result === undefined ? "started" : "completed", ...(result === undefined ? {} : { handoff_result: result }), source_capture_id: entry.handoff.capture_id, agent: entry.handoff.agent })}---\n\n# From your iPhone\n\n${entry.handoff.instruction}\n\n## Source\n\n${entry.item.source?.path ?? entry.item.source?.title ?? "iPhone capture"}\n\n## Result\n\n${result ?? "Started in the agent workspace. If interrupted, review that workspace before sending this instruction again."}\n`;
  }
  private receipt(content: string): Record<string, unknown> | null {
    const yaml = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
    if (!yaml) return null;
    try { const value: unknown = parseYaml(yaml); return record(value) ? value : null; } catch { return null; }
  }
  private async source(key: string, id: string): Promise<HandoffSource> {
    const response = await this.request(key, "GET", `/captures/${id}`);
    const capture = record(response) && record(response.capture) ? response.capture : null;
    if (!capture || capture.id !== id || typeof capture.markdown !== "string" || !["ready", "delivered"].includes(String(capture.status))) throw new Error("The handoff source is unavailable.");
    const files = this.options.app.vault.getMarkdownFiles();
    const file = files.find(candidate => !candidate.path.startsWith(`${RESULT_FOLDER}/`)
      && this.options.app.metadataCache.getFileCache(candidate)?.frontmatter?.capture_id === id);
    return { title: typeof capture.title === "string" ? capture.title : "iPhone capture", markdown: capture.markdown, path: file && relativeMarkdownPath(file.path) ? file.path : null };
  }
  private failureMessage(error: unknown): string {
    if (error instanceof HandoffApiError) {
      if (["handoff_cancelled", "not_found"].includes(error.code)) return "This handoff was cancelled or its source was deleted. Local execution was stopped.";
      if (["lease_lost", "claim_conflict", "terminal_state"].includes(error.code)) return "This handoff is no longer owned by this workspace. Local execution was stopped.";
      if ([401, 403].includes(error.status)) return "Sign in to SystemSculpt to receive iPhone handoffs.";
      if (error.status === 426) return "Update SystemSculpt to receive iPhone handoffs.";
    }
    // No subprocess messages, request content or raw logs go back to the phone.
    return "The handoff could not finish. Review its agent workspace and result note before sending it again.";
  }
  private async request(key: string, method: string, path: string, body?: unknown): Promise<unknown> {
    this.requireCurrent(key);
    let response: Response;
    try {
      response = await this.client.request({ url: `${this.baseUrl}${path}`, method,
        headers: { ...SystemSculptEnvironment.buildHeaders(key), "x-plugin-version": this.options.pluginVersion },
        body, licenseKey: key, allowTransportFallback: method === "GET" });
    } catch { throw new HandoffApiError(0, "transport_error"); }
    this.requireCurrent(key);
    const text = await response.text();
    this.requireCurrent(key);
    if (!response.ok) {
      const now = this.now();
      const retryMs = parseRetryAfterMs(response.headers.get("Retry-After"), { now });
      if (retryMs !== undefined) this.retryAt = now + retryMs;
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new HandoffApiError(response.status, "invalid_response"); }
    if (!response.ok) {
      const detail = record(payload) && record(payload.error) ? payload.error : payload;
      throw new HandoffApiError(response.status, record(detail) && typeof detail.code === "string" ? detail.code : "request_failed");
    }
    return payload;
  }
  dispose(): void {
    this.disposed = true;
    for (const run of this.active.values()) run.abort.abort();
    this.listeners.clear();
  }
}
