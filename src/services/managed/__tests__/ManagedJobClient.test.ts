import fixture from "../../../../testing/fixtures/managed/managed-job-protocol-v1.json";
import { ManagedJobClient, MANAGED_JOB_DESCRIPTORS, MANAGED_JOB_PROTOCOL } from "../ManagedJobClient";
import { HostedTransportAdapter } from "../adapters/HostedTransportAdapter";

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-request-id": "req-1", ...headers } });
const txJob = (status = "uploading") => ({ id: "job-1", status, filename: "a.wav", content_type: "audio/wav", content_length_bytes: 5, expires_at: "2099-01-01T00:00:00Z" });
const imageJob = (status = "queued") => ({ id: "img-1", status, created_at: "2026-01-01T00:00:00Z", processing_started_at: null, completed_at: null, expires_at: "2099-01-01T00:00:00Z", error: null, attempt_count: 1 });

describe("ManagedJobClient exact wire contract", () => {
  const request = jest.fn();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6.0.0", licenseKey: () => "license", requestClient: { request } as any });
  const client = new ManagedJobClient(transport);
  beforeEach(() => { request.mockReset(); });

  it("pins every fixture operation/status/header declaration", () => {
    for (const f of fixture.descriptors) {
      const d = MANAGED_JOB_DESCRIPTORS[f.capability as keyof typeof MANAGED_JOB_DESCRIPTORS];
      expect(Object.entries(d.paths).map(([name, [method, path]]) => ({ name, method, path }))).toEqual(f.operations.map(({ name, method, path }) => ({ name, method, path })));
      expect(d.statuses).toEqual([...f.statuses.non_terminal, ...f.statuses.terminal]);
      expect(d.version).toEqual(f.version.required_on); expect(d.idempotent).toEqual(f.idempotency.required_on);
    }
  });

  it.each([
    ["transcription.create", () => client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 1 }, "op"), "transcription", true, true],
    ["transcription.part_url", () => client.transcription.partUrl("job", 1), "transcription", false, false],
    ["transcription.upload_complete", () => client.transcription.complete("job", [{ partNumber: 1, etag: "e" }], "op"), "transcription", true, true],
    ["transcription.upload_abort", () => client.transcription.abortUpload("job"), "transcription", false, false],
    ["transcription.start", () => client.transcription.start("job", "op"), "transcription", true, true],
    ["transcription.status", () => client.transcription.status("job"), "transcription", false, false],
    ["document.create", () => client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 1 }, "op"), "document_processing", true, true],
    ["document.part_url", () => client.documents.partUrl("doc", 1), "document_processing", false, false],
    ["document.upload_complete", () => client.documents.complete("doc", [{ partNumber: 1, etag: "e" }], "op"), "document_processing", true, true],
    ["document.upload_abort", () => client.documents.abortUpload("doc"), "document_processing", false, false],
    ["document.start", () => client.documents.start("doc", "op"), "document_processing", true, true],
    ["document.status", () => client.documents.status("doc"), "document_processing", false, false],
    ["document.download", () => client.documents.download("doc"), "document_processing", false, false],
    ["image.input_prepare", () => client.images.prepareInputs([{ mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }], async () => new ArrayBuffer(1)), "image_generation", false, false],
    ["image.generation_create", () => client.images.create({ prompt: "x" }, "op"), "image_generation", false, true],
    ["image.generation_list", () => client.images.list(), "image_generation", false, false],
    ["image.generation_status", () => client.images.status("img"), "image_generation", false, false],
  ] as const)("uses exact operation header presence/absence for %s", async (_name, invoke, capability, version, idem) => {
    request.mockResolvedValue(json({})); await invoke().catch(() => undefined); const headers = request.mock.calls[0][0].headers;
    expect(headers["x-systemsculpt-capability"]).toBe(capability); expect(headers["x-systemsculpt-job-contract"]).toBe(MANAGED_JOB_PROTOCOL);
    expect(Object.hasOwn(headers, "x-plugin-version")).toBe(version); expect(Object.hasOwn(headers, "idempotency-key")).toBe(idem); expect(headers).not.toHaveProperty("Idempotency-Key");
  });

  it("sends exact transcription create body/headers and returns only durable public fields", async () => {
    request.mockResolvedValue(json({ job: txJob(), upload: { part_size_bytes: 5, total_parts: 1, part_url_expires_in_seconds: 900 } }));
    const result = await client.transcription.create({ filename: "a.wav", contentType: "audio/wav", contentLengthBytes: 5 }, "operation-1");
    expect(result).toEqual({ job: txJob(), upload: { part_size_bytes: 5, total_parts: 1, part_url_expires_in_seconds: 900 } });
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({ method: "POST", body: { filename: "a.wav", contentType: "audio/wav", contentLengthBytes: 5 }, headers: {
      "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-capability": "transcription", "x-plugin-version": "6.0.0", "idempotency-key": "operation-1:create",
    } }));
  });

  it("parses document, multipart part, result and image list discriminants", async () => {
    request.mockResolvedValueOnce(json({ document: { id: "doc-1", status: "uploading" }, upload: { part_size_bytes: 10, total_parts: 1, part_url_expires_in_seconds: 900, expires_at: "2099-01-01T00:00:00Z" } }));
    expect((await client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 10 }, "op")).document.id).toBe("doc-1");
    request.mockResolvedValueOnce(json({ part: { part_number: 1, method: "PUT", url: "https://signed/x", url_expires_in_seconds: 900, expected_content_length_bytes: 10 } }));
    const part = await client.documents.partUrl("doc-1", 1); expect(part).toEqual({ part_number: 1, expected_content_length_bytes: 10 }); expect(JSON.stringify(part)).not.toContain("signed");
    request.mockResolvedValueOnce(json({ result: { content: [], text: "x", markdown: "x", images: [], metadata: {} } }));
    expect((await client.documents.download("doc-1")).result.text).toBe("x");
    request.mockResolvedValueOnce(json({ items: [{ job: imageJob(), outputs: [], usage: { raw_usd: 0.1, cost_source: "provider", estimated: false } }], next_before: null }));
    expect((await client.images.list()).items).toHaveLength(1);
  });

  it("keeps image signed URL/headers/storage keys internal while uploading supplied bytes", async () => {
    const signed = jest.spyOn(transport as any, "uploadSignedInput").mockResolvedValue(undefined);
    request.mockResolvedValue(json({ contract: MANAGED_JOB_PROTOCOL, upload_id: "up-1", expires_at: "2099-01-01T00:00:00Z", input_uploads: [{ index: 0, upload: { method: "PUT", url: "https://signed/x", headers: { authorization: "secret" }, expires_in_seconds: 900, expires_at: "2099-01-01T00:00:00Z" }, input_image: { type: "uploaded", key: "storage-key", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) } }] }));
    const publicResult = await client.images.prepareInputs([{ mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }], async index => { expect(index).toBe(0); return new Uint8Array([1]).buffer; });
    expect(publicResult).toEqual({ uploadId: "up-1", inputs: [{ index: 0, mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }] });
    expect(JSON.stringify(publicResult)).not.toMatch(/signed|authorization|storage-key/);
    expect(signed).toHaveBeenCalled(); signed.mockRestore();
  });

  it.each([
    ["transcription create", () => client.transcription.create({ filename: "", contentType: "audio/wav", contentLengthBytes: 1 }, "op")],
    ["document content type", () => client.documents.create({ filename: "a", contentType: "text/plain", contentLengthBytes: 1 }, "op")],
    ["part zero", () => client.transcription.partUrl("job", 0)],
    ["duplicate parts", () => client.documents.complete("doc", [{ partNumber: 1, etag: "a" }, { partNumber: 1, etag: "b" }], "op")],
    ["image prompt", () => client.images.create({ prompt: "" })],
    ["image uploaded key", () => client.images.create({ prompt: "x", input_images: [{ type: "uploaded", key: "https://storage/key", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }] })],
    ["image count", () => client.images.create({ prompt: "x", options: { count: 5 } })],
    ["image aspect", () => client.images.create({ prompt: "x", options: { aspect_ratio: "wide" } })],
    ["image size", () => client.images.create({ prompt: "x", options: { image_size: "8K" } })],
    ["image seed", () => client.images.create({ prompt: "x", options: { seed: -1 } })],
    ["image idempotency", () => client.images.create({ prompt: "x" }, "bad:id")],
    ["list limit", () => client.images.list({ limit: 101 })],
    ["list before", () => client.images.list({ before: "not-date" })],
    ["list status", () => client.images.list({ status: "completed" as any })],
  ])("rejects invalid request matrix: %s", async (_name, invoke) => { await expect(Promise.resolve().then(invoke)).rejects.toMatchObject({ code: "invalid_request" }); expect(request).not.toHaveBeenCalled(); });

  it.each([
    ["transcription create", () => client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 1 }, "op"), { job: { id: "job", status: "uploading" }, upload: {} }],
    ["transcription status", () => client.transcription.status("job"), { job: { ...txJob(), error: null }, transcript: 5, progress: 2 }],
    ["document create", () => client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 1 }, "op"), { job: { id: "doc", status: "uploading" }, upload: {} }],
    ["document status", () => client.documents.status("doc"), { document: { id: "doc", status: "expired", error: null, progress: 0 } }],
    ["part", () => client.documents.partUrl("doc", 1), { part: { part_number: 1, method: "POST", url: "https://signed", url_expires_in_seconds: 900, expected_content_length_bytes: 1 } }],
    ["result", () => client.documents.download("doc"), { result: { content: "bad", text: "x", markdown: "x", images: [], metadata: {} } }],
    ["input prepare", () => client.images.prepareInputs([{ mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }], async () => new ArrayBuffer(1)), { contract: MANAGED_JOB_PROTOCOL, upload_id: "u", expires_at: "2099-01-01T00:00:00Z", input_uploads: [{ index: 0, upload: { method: "PUT", url: "https://s", headers: {}, expires_in_seconds: 900, expires_at: "2099-01-01T00:00:00Z" }, input_image: { type: "provider", key: "k", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) } }] }],
    ["image create", () => client.images.create({ prompt: "x" }), { job: imageJob(), poll_url: 5 }],
    ["image list", () => client.images.list(), { items: [{ job: imageJob(), outputs: [], usage: { raw_usd: -1, cost_source: "provider", estimated: false } }], next_before: null }],
    ["image status discriminant", () => client.images.status("img"), { job: { ...imageJob("succeeded"), completed_at: null }, outputs: [], usage: { raw_usd: 1, cost_source: "provider", estimated: false } }],
  ] as const)("rejects malformed actual %s parser", async (_name, invoke, payload) => { request.mockResolvedValue(json(payload)); await expect(invoke()).rejects.toMatchObject({ code: "malformed_response" }); });

  it("constructs generation list query from typed fields", async () => {
    request.mockResolvedValue(json({ items: [], next_before: null })); await client.images.list({ limit: 10, before: "2026-01-01T00:00:00Z", status: "failed" });
    expect(request.mock.calls[0][0].url).toContain("limit=10&before=2026-01-01T00%3A00%3A00Z&status=failed");
  });

  it.each([
    [400, "invalid_request", false], [401, "license_required", false], [402, "payment_required", false], [403, "license_rejected", false], [409, "operation_conflict", false], [426, "upgrade_required", false], [429, "rate_limited", true], [502, "temporarily_unavailable", true], [503, "temporarily_unavailable", true],
  ])("maps HTTP %s exactly with request ID/retryability", async (status, code, retryable) => {
    request.mockResolvedValue(json({ code }, status, { "retry-after": "5" }));
    await expect(client.transcription.status("job")).rejects.toMatchObject({ code, status, requestId: "req-1", retryable });
  });

  it("maps terminal status errors exactly and omits forbidden status headers", async () => {
    request.mockResolvedValue(json({ job: { ...txJob("failed"), error: null }, transcript: null, progress: 1 }));
    await expect(client.transcription.status("job")).rejects.toMatchObject({ code: "transcription_failed", requestId: "req-1", retryable: false });
    expect(request.mock.calls[0][0].headers).toEqual({ "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-capability": "transcription" });
  });
});
