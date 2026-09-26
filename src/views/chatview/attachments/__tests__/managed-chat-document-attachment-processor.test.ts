import { requestUrl, type App } from "obsidian";
import type SystemSculptPlugin from "../../../../main";
import { PlatformRequestClient } from "../../../../services/PlatformRequestClient";
import { HostedTransportAdapter } from "../../../../services/managed/adapters/HostedTransportAdapter";
import { ManagedJobRecoveryStore, type ManagedRecoveryAdapter } from "../../../../services/managed/ManagedJobRecoveryStore";
import { ChatMessageAttachmentCollection } from "../ChatMessageAttachments";
import { ManagedChatDocumentAttachmentProcessor } from "../ManagedChatDocumentAttachmentProcessor";

class MemoryRecoveryAdapter implements ManagedRecoveryAdapter {
  readonly storageDomain = "memory:chat-documents";
  readonly capabilities = { read: true, write: true, list: true, mkdir: true, atomicRename: true, remove: true };
  readonly files = new Map<string, string>();
  async read(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error("missing"); return value; }
  async write(path: string, value: string) { this.files.set(path, value); }
  async exists(path: string) { return this.files.has(path); }
  async list(path: string) { return [...this.files.keys()].filter((file) => file.startsWith(`${path}/`)); }
  async mkdir(_path: string) {}
  async rename(from: string, to: string) { this.files.set(to, await this.read(from)); this.files.delete(from); }
  async remove(path: string) { this.files.delete(path); }
}

const bytes = new TextEncoder().encode("%PDF").buffer;
const input = { name: "report.pdf", mimeType: "application/pdf" as const, bytes, fingerprint: `sha256:${"a".repeat(64)}` as const };
const pdf = { name: input.name, type: input.mimeType, size: bytes.byteLength } as File;
const result = { content: [], text: "Converted", markdown: "# Converted", images: [], metadata: {} };

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 2_000 && !predicate(); index++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

function harness(transportKind: "requestUrl" | "fetch" = "requestUrl") {
  const storage = new MemoryRecoveryAdapter();
  const recovery = new ManagedJobRecoveryStore(storage);
  const requestClient = new PlatformRequestClient();
  const request = jest.spyOn(requestClient, "request");
  const admission = { acquireLease: jest.fn(async () => ({ outcome: "allowed" as const })) };
  const transport = new HostedTransportAdapter({
    baseUrl: transportKind === "fetch" ? "http://127.0.0.1:8787" : "https://api.test",
    pluginVersion: "6.10.0", licenseKey: () => "test-license", requestClient,
  });
  const plugin = { getManagedCapabilityGraph: () => ({ admission, transport, recovery }) } as unknown as SystemSculptPlugin;
  const processor = new ManagedChatDocumentAttachmentProcessor({} as App, plugin);
  const collection = new ChatMessageAttachmentCollection(async () => bytes, processor);
  const state = { downloadReady: false, processing: false, polls: 0, creates: [] as string[] };
  const response = (payload: unknown, headers: Record<string, string> = {}) => ({
    status: 200, headers, text: JSON.stringify(payload), json: payload, arrayBuffer: new ArrayBuffer(0),
  });
  const route = (url: string, headers: Record<string, string> = {}) => {
    if (url.endsWith("/documents/jobs")) {
      state.creates.push(headers["idempotency-key"]);
      return response({ document: { id: "doc-1", status: "uploading" }, upload: {
        part_size_bytes: bytes.byteLength, total_parts: 1, part_url_expires_in_seconds: 900,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      } });
    }
    if (url.includes("/upload/part-url")) return response({ part: {
      part_number: 1, method: "PUT", url: "https://upload.test/part", url_expires_in_seconds: 900,
      expected_content_length_bytes: bytes.byteLength,
    } });
    if (url === "https://upload.test/part") return response({}, { etag: "a".repeat(32) });
    if (url.endsWith("/upload/complete")) return response({ document: { id: "doc-1", status: "queued" } });
    if (url.endsWith("/start")) return response({ document: { id: "doc-1", status: "processing" } });
    if (url.endsWith("/download")) return state.downloadReady ? response({ result }) : null;
    if (url.endsWith("/documents/doc-1")) {
      state.polls++;
      return response({ document: { id: "doc-1", status: state.processing ? "processing" : "completed", error: null,
        progress: state.processing ? Math.min(0.99, state.polls / 100) : 1 } }, { "retry-after": "60" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  (requestUrl as jest.Mock).mockImplementation(async ({ url, headers }) => route(url, headers) ?? new Promise(() => undefined));
  const oldFetch = window.fetch;
  window.fetch = jest.fn(async (url, init) => {
    const routed = route(String(url), init?.headers as Record<string, string>);
    // Headers arrive, but this body never completes. The real platform client
    // must keep its transfer deadline and user cancellation active through it.
    return routed
      ? new Response(routed.text, { status: routed.status, headers: routed.headers })
      : new Response(new ReadableStream<Uint8Array>({ start(controller) {
        const abort = () => controller.error(new DOMException("Aborted", "AbortError"));
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) abort();
      } }));
  });
  const download = () => request.mock.calls.find(([value]) => value.url.endsWith("/download"))?.[0];
  const operationId = () => state.creates[0].replace(/:create$/, "");
  return { processor, collection, recovery, state, admission, download, operationId, restore: () => { window.fetch = oldFetch; } };
}

describe("ManagedChatDocumentAttachmentProcessor through the plugin capability graph", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it.each(["requestUrl", "fetch"] as const)("forwards cancellation to a stalled %s download and intentionally discards recovery", async (kind) => {
    const h = harness(kind);
    try {
      const controller = new AbortController();
      const pending = h.processor.prepare(input, { signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await until(() => Boolean(h.download()));
      expect(h.download()?.signal).toBe(controller.signal);
      controller.abort();
      await rejected;
      await expect(h.recovery.readOptional("document_processing", h.operationId())).resolves.toBeNull();
      expect(h.state.creates).toHaveLength(1);
    } finally { h.restore(); }
  });

  it.each(["requestUrl", "fetch"] as const)("retains a timed-out %s transfer and Retry resumes the SAME operation and job", async (kind) => {
    const h = harness(kind);
    try {
      const pending = h.collection.addFiles([pdf]);
      await until(() => Boolean(h.download()));
      const deadline = h.download()?.timeoutMs;
      expect(typeof deadline).toBe("number");
      expect(deadline).toBeGreaterThanOrEqual(120_000);
      await jest.advanceTimersByTimeAsync(deadline as number);
      expect((await pending).issues).toHaveLength(1);
      expect(h.download()?.signal?.aborted).toBe(false);
      const operationId = h.operationId();
      await expect(h.recovery.read("document_processing", operationId)).resolves.toMatchObject({ phase: "result_ready", jobId: "doc-1" });
      const failed = h.collection.displaySnapshot()[0];
      h.state.downloadReady = true;
      const retried = await h.collection.retry(failed.id);
      expect(retried.issues).toEqual([]);
      expect(retried.accepted).toHaveLength(1);
      expect(h.state.creates).toEqual([`${operationId}:create`]);
      expect(h.admission.acquireLease).toHaveBeenCalledTimes(1);
      await expect(h.recovery.read("document_processing", operationId)).resolves.toMatchObject({ phase: "completed", jobId: "doc-1" });
    } finally { h.collection.dispose(); h.restore(); }
  });

  it("continues observing healthy processing past the former whole-job deadline", async () => {
    const h = harness();
    try {
      h.state.processing = true;
      let settled = false;
      const pending = h.collection.addFiles([pdf]).then((value) => { settled = true; return value; });
      await until(() => h.state.polls > 0);
      await jest.advanceTimersByTimeAsync(20 * 60_000);
      expect(settled).toBe(false);
      expect(h.state.polls).toBeGreaterThan(15);
      expect(h.download()).toBeUndefined();
      await expect(h.recovery.read("document_processing", h.operationId())).resolves.toMatchObject({ phase: "processing" });
      h.state.processing = false;
      h.state.downloadReady = true;
      await jest.advanceTimersByTimeAsync(60_000);
      expect((await pending).accepted).toHaveLength(1);
      expect(h.state.creates).toHaveLength(1);
    } finally { h.collection.dispose(); h.restore(); }
  });

  it.each(["create", "upload"] as const)("recovers the same operation after an interrupted %s response", async (phase) => {
    const h = harness();
    try {
      const nativeRequest = requestUrl as jest.Mock;
      const route = nativeRequest.getMockImplementation()!;
      const dispatches: Array<{ body: unknown; headers: Record<string, string> }> = [];
      nativeRequest.mockImplementation(async (request) => {
        const target = phase === "create"
          ? request.url.endsWith("/documents/jobs")
          : request.url === "https://upload.test/part";
        if (target) {
          dispatches.push(request);
          const response = await route(request);
          // The service received the dispatch; only its response was lost.
          if (dispatches.length <= 2) return new Promise(() => undefined);
          return response;
        }
        return route(request);
      });
      const pending = h.collection.addFiles([pdf]);
      await until(() => dispatches.length === 1);
      await jest.advanceTimersByTimeAsync(120_000);
      expect((await pending).issues).toHaveLength(1);
      const operationId = h.operationId();
      await expect(h.recovery.read("document_processing", operationId)).resolves.toMatchObject({
        phase: phase === "create" ? "create_dispatching" : "part_dispatching",
      });
      const retryInterrupted = h.collection.retry(h.collection.displaySnapshot()[0].id);
      await until(() => dispatches.length === 2);
      await jest.advanceTimersByTimeAsync(120_000);
      expect((await retryInterrupted).issues).toHaveLength(1);
      h.state.downloadReady = true;
      const retried = await h.collection.retry(h.collection.displaySnapshot()[0].id);
      expect(retried.issues).toEqual([]);
      expect(retried.accepted).toHaveLength(1);
      expect(dispatches).toHaveLength(3);
      expect(dispatches[1].body).toEqual(dispatches[0].body);
      expect(dispatches[2].body).toEqual(dispatches[0].body);
      if (phase === "create") {
        expect(dispatches.map((request) => request.headers["idempotency-key"]))
          .toEqual([`${operationId}:create`, `${operationId}:create`, `${operationId}:create`]);
      }
      expect(new Set(h.state.creates)).toEqual(new Set([`${operationId}:create`]));
      expect(h.admission.acquireLease).toHaveBeenCalledTimes(1);
      await expect(h.recovery.read("document_processing", operationId)).resolves.toMatchObject({ phase: "completed", jobId: "doc-1" });
    } finally { h.collection.dispose(); h.restore(); }
  });

  it.each(["initial", "retry"] as const)("retains the completed result for explicit Retry after late Stop during %s processing", async (attempt) => {
    const h = harness();
    try {
      if (attempt === "retry") {
        const first = h.collection.addFiles([pdf]);
        await until(() => Boolean(h.download()));
        await jest.advanceTimersByTimeAsync(h.download()!.timeoutMs as number);
        await first;
      }
      h.state.downloadReady = true;
      const complete = h.recovery.completeLocalCommit.bind(h.recovery);
      let completed = false;
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      jest.spyOn(h.recovery, "completeLocalCommit").mockImplementationOnce(async (...args) => {
        const record = await complete(...args);
        completed = true;
        await delayed;
        return record;
      });
      const pending = attempt === "initial" ? h.collection.addFiles([pdf]) : h.collection.retry(h.collection.displaySnapshot()[0].id);
      await until(() => completed);
      const operationId = h.operationId();
      h.collection.cancelProcessing();
      release();
      expect((await pending).accepted).toHaveLength(0);
      expect(h.collection.displaySnapshot()[0].status).toBe("failed");
      await expect(h.recovery.read("document_processing", operationId)).resolves.toMatchObject({ phase: "completed" });
      const requestsBeforeRetry = (requestUrl as jest.Mock).mock.calls.length;
      const retried = await h.collection.retry(h.collection.displaySnapshot()[0].id);
      expect(retried.issues).toEqual([]);
      expect(retried.accepted[0].contentPart).toMatchObject({ type: "text", text: expect.stringContaining("# Converted") });
      expect((requestUrl as jest.Mock).mock.calls).toHaveLength(requestsBeforeRetry);
      expect(h.state.creates).toEqual([`${operationId}:create`]);
      expect(h.admission.acquireLease).toHaveBeenCalledTimes(1);
      expect(h.recovery.completeLocalCommit).toHaveBeenCalledTimes(1);
    } finally { h.collection.dispose(); h.restore(); }
  });

  it.each([
    ["remove", "during"], ["clear", "during"], ["dispose", "during"],
    ["remove", "after"], ["clear", "after"], ["dispose", "after"],
  ] as const)("%s %s completion discards the chip and its completed Retry result", async (action, timing) => {
    const h = harness();
    try {
      const first = h.collection.addFiles([pdf]);
      await until(() => Boolean(h.download()));
      await jest.advanceTimersByTimeAsync(h.download()!.timeoutMs as number);
      await first;
      const id = h.collection.displaySnapshot()[0].id;
      h.state.downloadReady = true;
      const complete = h.recovery.completeLocalCommit.bind(h.recovery);
      let completed = false;
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      jest.spyOn(h.recovery, "completeLocalCommit").mockImplementationOnce(async (...args) => {
        const record = await complete(...args);
        completed = true;
        await delayed;
        return record;
      });
      const pending = h.collection.retry(id);
      await until(() => completed);
      const discard = () => action === "remove" ? h.collection.remove(id) : h.collection[action]();
      if (timing === "during") discard();
      else h.collection.cancelProcessing();
      release();
      expect((await pending).accepted).toHaveLength(0);
      if (timing === "after") discard();
      expect((await h.collection.retry(id)).accepted).toHaveLength(0);
      expect(h.collection.displaySnapshot()).toEqual([]);
      expect(h.admission.acquireLease).toHaveBeenCalledTimes(1);
      await expect(h.recovery.read("document_processing", h.operationId())).resolves.toMatchObject({ phase: "completed" });
    } finally { h.collection.dispose(); h.restore(); }
  });

  it("discards retained recovery when a timed-out attachment is removed", async () => {
    const h = harness();
    try {
      const pending = h.collection.addFiles([pdf]);
      await until(() => Boolean(h.download()));
      expect(typeof h.download()?.timeoutMs).toBe("number");
      await jest.advanceTimersByTimeAsync(h.download()!.timeoutMs as number);
      await pending;
      h.collection.remove(h.collection.displaySnapshot()[0].id);
      await until(() => h.download()?.signal?.aborted === true);
      // Drain the asynchronous local recovery cleanup through its public read.
      for (let index = 0; index < 20; index++) {
        if (!(await h.recovery.readOptional("document_processing", h.operationId()))) break;
      }
      await expect(h.recovery.readOptional("document_processing", h.operationId())).resolves.toBeNull();
      expect(h.collection.displaySnapshot()).toEqual([]);
    } finally { h.collection.dispose(); h.restore(); }
  });
});
