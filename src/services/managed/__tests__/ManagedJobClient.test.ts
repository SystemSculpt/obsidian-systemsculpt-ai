import fixture from "../../../../testing/fixtures/managed/managed-job-protocol-v1.json";
import imageOutputFixture from "../../../../testing/fixtures/managed/managed-image-output-v1.json";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ManagedJobClient, MANAGED_IMAGE_OUTPUT_DESCRIPTOR, MANAGED_JOB_DESCRIPTORS, MANAGED_JOB_OPERATION_STATUSES, MANAGED_JOB_PROTOCOL } from "../ManagedJobClient";
import { HostedTransportAdapter } from "../adapters/HostedTransportAdapter";

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-request-id": "req-1", ...headers } });
const txJob = (status = "uploading") => ({ id: "job-1", status, filename: "a.wav", content_type: "audio/wav", content_length_bytes: 5, expires_at: "2099-01-01T00:00:00Z" });
const futureUploadExpiry = () => new Date(Date.now() + 600_000).toISOString();
const imageJob = (status = "queued") => ({ id: "img-1", status, created_at: "2026-01-01T00:00:00Z", processing_started_at: null, completed_at: null, expires_at: "2099-01-01T00:00:00Z", error: null, attempt_count: 1 });
const imageContractHeaders = (requestId = "req-1") => ({ "x-request-id": requestId, "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-image-output-contract": "managed-image-output-v1", "x-systemsculpt-capability": "image_generation" });
const imageError = (status: number, code: string, message: string, requestId = "req-1") => json({ contract_version: "managed-image-output-v1", code, message, request_id: requestId }, status, imageContractHeaders(requestId));

describe("ManagedJobClient exact wire contract", () => {
  const request = jest.fn();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6.0.0", licenseKey: () => "license", requestClient: { request } as any });
  const client = new ManagedJobClient(transport, undefined, () => "req-1");
  beforeEach(() => { request.mockReset(); });

  it("pins the exact closed managed image output companion fixture", () => {
    const bytes = readFileSync(path.resolve(__dirname, "../../../../testing/fixtures/managed/managed-image-output-v1.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("8b8437a586ad727c5afd777bb47f4ecc4866e7b51b19f8decdb17cea68f55dff");
    expect(MANAGED_IMAGE_OUTPUT_DESCRIPTOR).toEqual(imageOutputFixture);
    expect(imageOutputFixture.contract_version).toBe("managed-image-output-v1");
    expect(imageOutputFixture.operations).toEqual([
      { name: "generation_status_metadata", method: "GET", path: "/api/plugin/images/generations/jobs/{jobId}", response_transport: "json", output_fields: ["index", "mime_type", "size_bytes", "sha256", "width", "height"] },
      { name: "generation_list_metadata", method: "GET", path: "/api/plugin/images/generations/jobs", query: ["limit", "before", "status"], response_transport: "json", output_fields: ["index", "mime_type", "size_bytes", "sha256", "width", "height"] },
      expect.objectContaining({ name: "generation_output_download", method: "GET", path: "/api/plugin/images/generations/jobs/{jobId}/outputs/{outputIndex}", response_transport: "binary" }),
    ]);
    expect(imageOutputFixture.forbidden_response_fields).toEqual(["url", "signed_url", "object_key", "r2_object_key", "provider", "model", "storage", "etag"]);
  });

  it("pins every fixture operation/status/header declaration", () => {
    for (const f of fixture.descriptors) {
      const d = MANAGED_JOB_DESCRIPTORS[f.capability as keyof typeof MANAGED_JOB_DESCRIPTORS];
      expect(Object.entries(d.paths).map(([name, [method, path]]) => ({ name, method, path }))).toEqual(f.operations.map(({ name, method, path }) => ({ name, method, path })));
      expect(d.statuses).toEqual([...f.statuses.non_terminal, ...f.statuses.terminal]);
      expect(d.version).toEqual(f.version.required_on); expect(d.idempotent).toEqual(f.idempotency.required_on);
      expect(MANAGED_JOB_OPERATION_STATUSES[f.capability as keyof typeof MANAGED_JOB_OPERATION_STATUSES]).toEqual(f.status_discriminants);
    }
  });

  it.each([
    ["transcription.create", () => client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 1 }, "op"), "transcription", true, true],
    ["transcription.part_url", () => client.transcription.uploadPart("job", 1, new Uint8Array([1]).buffer), "transcription", false, false],
    ["transcription.upload_complete", () => client.transcription.complete("job", [{ partNumber: 1, etag: "e".repeat(32) }], "op"), "transcription", true, true],
    ["transcription.upload_abort", () => client.transcription.abortUpload("job"), "transcription", false, false],
    ["transcription.start", () => client.transcription.start("job", "op"), "transcription", true, true],
    ["transcription.status", () => client.transcription.status("job"), "transcription", false, false],
    ["document.create", () => client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 1 }, "op"), "document_processing", true, true],
    ["document.part_url", () => client.documents.uploadPart("doc", 1, new Uint8Array([1]).buffer), "document_processing", false, false],
    ["document.upload_complete", () => client.documents.complete("doc", [{ partNumber: 1, etag: "e".repeat(32) }], "op"), "document_processing", true, true],
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

  it.each([
    ["transcription", 899], ["transcription", 901], ["document_processing", 899], ["document_processing", 901],
  ] as const)("rejects %s create upload URL lifetime %s instead of exact 900", async (capability, lifetime) => {
    const payload = capability === "transcription"
      ? { job: txJob(), upload: { part_size_bytes: 5, total_parts: 1, part_url_expires_in_seconds: lifetime } }
      : { document: { id: "doc", status: "uploading" }, upload: { part_size_bytes: 5, total_parts: 1, part_url_expires_in_seconds: lifetime, expires_at: "2099-01-01T00:00:00Z" } };
    request.mockResolvedValue(json(payload)); const invoke = capability === "transcription" ? client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 5 }, "op") : client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 5 }, "op");
    await expect(invoke).rejects.toMatchObject({ code: "malformed_response" });
  });

  it.each([["2025-12-31T23:59:59Z", false], ["2026-01-01T00:00:00Z", false], ["2026-01-01T00:00:01Z", true]] as const)("validates document upload expiry %s future=%s", async (expires_at, accepted) => {
    const deterministic = new ManagedJobClient(transport, () => Date.parse("2026-01-01T00:00:00Z")); request.mockResolvedValue(json({ document: { id: "doc", status: "uploading" }, upload: { part_size_bytes: 5, total_parts: 1, part_url_expires_in_seconds: 900, expires_at } }));
    const result = deterministic.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 5 }, "op"); if (accepted) await expect(result).resolves.toBeDefined(); else await expect(result).rejects.toMatchObject({ code: "malformed_response" });
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
    request.mockResolvedValueOnce(json({ part: { part_number: 1, method: "PUT", url: "https://signed/x", url_expires_in_seconds: 900, expected_content_length_bytes: 10 } })).mockResolvedValueOnce(new Response("", { status: 200, headers: { etag: `"${"a".repeat(32)}"` } }));
    const part = await client.documents.uploadPart("doc-1", 1, new Uint8Array(10).buffer); expect(part).toEqual({ partNumber: 1, etag: `"${"a".repeat(32)}"` }); expect(JSON.stringify(part)).not.toContain("signed");
    request.mockResolvedValueOnce(json({ result: { content: [], text: "x", markdown: "x", images: [], metadata: {} } }));
    expect((await client.documents.download("doc-1")).result.text).toBe("x");
    request.mockResolvedValueOnce(json({ items: [{ job: imageJob(), outputs: [], usage: { raw_usd: 0.1, cost_source: "provider", estimated: false } }], next_before: null }));
    expect((await client.images.list()).items).toHaveLength(1);
  });

  it("keeps image signed URL/headers/storage keys internal while uploading supplied bytes", async () => {
    const signed = jest.spyOn(transport as any, "uploadSignedInput").mockResolvedValue(undefined);
    request.mockResolvedValue(json({ contract: MANAGED_JOB_PROTOCOL, upload_id: "up-1", expires_at: futureUploadExpiry(), input_uploads: [{ index: 0, upload: { method: "PUT", url: "https://signed/x", headers: { authorization: "secret" }, expires_in_seconds: 900, expires_at: futureUploadExpiry() }, input_image: { type: "uploaded", key: "storage-key", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) } }] }));
    const publicResult = await client.images.prepareInputs([{ mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }], async index => { expect(index).toBe(0); return new Uint8Array([1]).buffer; });
    expect(publicResult).toEqual({ uploadId: "up-1", inputs: [{ index: 0, mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }] });
    expect(JSON.stringify(publicResult)).not.toMatch(/signed|authorization|storage-key/);
    expect(signed).toHaveBeenCalled(); signed.mockRestore();
  });

  it.each([
    ["transcription create", () => client.transcription.create({ filename: "", contentType: "audio/wav", contentLengthBytes: 1 }, "op")],
    ["transcription extra", () => client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 1, extra: true } as any, "op")],
    ["transcription timestamped", () => client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 1, timestamped: "yes" } as any, "op")],
    ["document extra", () => client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 1, extra: true } as any, "op")],
    ["document content type", () => client.documents.create({ filename: "a", contentType: "text/plain", contentLengthBytes: 1 }, "op")],
    ["part zero", () => client.transcription.uploadPart("job", 0, new ArrayBuffer(1))],
    ["duplicate parts", () => client.documents.complete("doc", [{ partNumber: 1, etag: "a".repeat(32) }, { partNumber: 1, etag: "b".repeat(32) }], "op")],
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
    ["part", () => client.documents.uploadPart("doc", 1, new ArrayBuffer(1)), { part: { part_number: 1, method: "POST", url: "https://signed", url_expires_in_seconds: 900, expected_content_length_bytes: 1 } }],
    ["part expiry", () => client.documents.uploadPart("doc", 1, new ArrayBuffer(1)), { part: { part_number: 1, method: "PUT", url: "https://signed", url_expires_in_seconds: 899, expected_content_length_bytes: 1 } }],
    ["result", () => client.documents.download("doc"), { result: { content: "bad", text: "x", markdown: "x", images: [], metadata: {} } }],
    ["input prepare", () => client.images.prepareInputs([{ mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }], async () => new ArrayBuffer(1)), { contract: MANAGED_JOB_PROTOCOL, upload_id: "u", expires_at: futureUploadExpiry(), input_uploads: [{ index: 0, upload: { method: "PUT", url: "https://s", headers: {}, expires_in_seconds: 900, expires_at: futureUploadExpiry() }, input_image: { type: "provider", key: "k", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) } }] }],
    ["image create", () => client.images.create({ prompt: "x" }), { job: imageJob(), poll_url: 5 }],
    ["image list", () => client.images.list(), { items: [{ job: imageJob(), outputs: [], usage: { raw_usd: -1, cost_source: "provider", estimated: false } }], next_before: null }],
    ["image status discriminant", () => client.images.status("img"), { job: { ...imageJob("succeeded"), completed_at: null }, outputs: [], usage: { raw_usd: 1, cost_source: "provider", estimated: false } }],
    ["image output expiry", () => client.images.status("img"), { job: { ...imageJob("succeeded"), processing_started_at: "2026-01-01T00:00:01Z", completed_at: "2026-01-01T00:00:02Z" }, outputs: [{ index: 0, mime_type: "image/png", size_bytes: 1, width: 1, height: 1, url: "https://signed/x", url_expires_in_seconds: 1799 }], usage: { raw_usd: 1, cost_source: "provider", estimated: false } }],
  ] as const)("rejects malformed actual %s parser", async (_name, invoke, payload) => { request.mockResolvedValue(json(payload)); await expect(invoke()).rejects.toMatchObject({ code: "malformed_response" }); });

  it("negotiates metadata-only status/list and rejects legacy signed output fields", async () => {
    const metadata = { index: 0, mime_type: "image/png", size_bytes: 2, sha256: "a".repeat(64), width: null, height: 20 };
    request.mockResolvedValueOnce(json({ job: { ...imageJob("succeeded"), processing_started_at: "2026-01-01T00:00:01Z", completed_at: "2026-01-01T00:00:02Z" }, outputs: [metadata], usage: { raw_usd: 1, cost_source: "provider", estimated: false } }));
    expect((await client.images.status("img-1")).outputs).toEqual([metadata]);
    expect(request.mock.calls[0][0].headers).toMatchObject({ "x-systemsculpt-image-output-contract": "managed-image-output-v1", "x-request-id": expect.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/) });
    request.mockResolvedValueOnce(json({ items: [{ job: imageJob(), outputs: [], usage: { raw_usd: 0, cost_source: "provider", estimated: false } }], next_before: null }));
    await client.images.list();
    expect(request.mock.calls[1][0].headers["x-systemsculpt-image-output-contract"]).toBe("managed-image-output-v1");
    request.mockResolvedValueOnce(json({ job: { ...imageJob("succeeded"), processing_started_at: "2026-01-01T00:00:01Z", completed_at: "2026-01-01T00:00:02Z" }, outputs: [{ ...metadata, url: "https://signed/output" }], usage: { raw_usd: 1, cost_source: "provider", estimated: false } }));
    await expect(client.images.status("img-1")).rejects.toMatchObject({ code: "malformed_response" });
  });

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

  it.each([
    ["transcription.upload_complete", () => client.transcription.complete("job", [{ partNumber: 1, etag: "a".repeat(32) }], "op"), (status: string) => ({ job: { id: "job", status } }), "queued", "uploading"],
    ["transcription.start", () => client.transcription.start("job", "op"), (status: string) => ({ job: { id: "job", status } }), "queued", "uploading"],
    ["document.upload_complete", () => client.documents.complete("doc", [{ partNumber: 1, etag: "a".repeat(32) }], "op"), (status: string) => ({ document: { id: "doc", status } }), "queued", "uploading"],
    ["document.start", () => client.documents.start("doc", "op"), (status: string) => ({ document: { id: "doc", status } }), "queued", "uploading"],
    ["image.generation_create", () => client.images.create({ prompt: "x" }), (status: string) => ({ job: { id: "img", status, created_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", error: null }, poll_url: "/poll" }), "queued", "uploading"],
  ] as const)("enforces operation-specific status discriminants for %s", async (_name, invoke, payload, allowed, forbidden) => {
    request.mockResolvedValueOnce(json(payload(allowed))); await expect(invoke()).resolves.toBeDefined();
    request.mockResolvedValueOnce(json(payload(forbidden))); await expect(invoke()).rejects.toMatchObject({ code: "malformed_response" });
  });

  it.each(["transcription", "document_processing"] as const)("accepts fixture failed as successful %s upload_abort acknowledgement", async capability => {
    request.mockResolvedValue(json(capability === "transcription" ? { job: { id: "job", status: "failed" } } : { document: { id: "doc", status: "failed" } }));
    const result = capability === "transcription" ? await client.transcription.abortUpload("job") : await client.documents.abortUpload("doc");
    expect((result as any)[capability === "transcription" ? "job" : "document"].status).toBe("failed");
  });

  it("rejects a mismatched returned part identity before signed upload", async () => {
    request.mockResolvedValue(json({ part: { part_number: 2, method: "PUT", url: "https://signed/wrong", url_expires_in_seconds: 900, expected_content_length_bytes: 1 } }));
    await expect(client.transcription.uploadPart("job", 1, new ArrayBuffer(1))).rejects.toMatchObject({ code: "malformed_response" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uploads multipart bytes call-locally, forwards signed headers, validates ETag, and honors abort/errors", async () => {
    const controller = new AbortController();
    request.mockResolvedValueOnce(json({ part: { part_number: 1, method: "PUT", url: "https://signed/x", url_expires_in_seconds: 900, expected_content_length_bytes: 1 } }))
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { etag: `"${"f".repeat(32)}-1"` } }));
    await expect(client.transcription.uploadPart("job", 1, new Uint8Array([1]).buffer, controller.signal)).resolves.toEqual({ partNumber: 1, etag: `"${"f".repeat(32)}-1"` });
    expect(request.mock.calls[1][0]).toEqual(expect.objectContaining({ url: "https://signed/x", method: "PUT", headers: {}, signal: controller.signal }));
    expect(JSON.stringify(request.mock.calls[0][0])).not.toContain("signed/x");

    request.mockReset(); request.mockResolvedValueOnce(json({ part: { part_number: 1, method: "PUT", url: "https://signed/x", url_expires_in_seconds: 900, expected_content_length_bytes: 1 } })).mockResolvedValueOnce(new Response("", { status: 200, headers: { etag: "Bearer secret" } }));
    await expect(client.transcription.uploadPart("job", 1, new ArrayBuffer(1))).rejects.toMatchObject({ code: "malformed_response" });
    request.mockReset(); request.mockResolvedValueOnce(json({ part: { part_number: 1, method: "PUT", url: "https://signed/x", url_expires_in_seconds: 900, expected_content_length_bytes: 1 } })).mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(client.transcription.uploadPart("job", 1, new ArrayBuffer(1))).rejects.toMatchObject({ code: "managed_job_error" });
    request.mockReset(); controller.abort(); await expect(client.transcription.uploadPart("job", 1, new ArrayBuffer(1), controller.signal)).rejects.toMatchObject({ name: "AbortError" }); expect(request).not.toHaveBeenCalled();
  });

  it("downloads one named first-party image output and verifies its bytes and headers", async () => {
    const bytes = new Uint8Array([1, 2]);
    const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: 2, sha256: "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222", width: 10, height: 20 };
    request.mockResolvedValue(new Response(bytes, { status: 200, headers: { "x-request-id": "req-1", "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-image-output-contract": "managed-image-output-v1", "x-systemsculpt-capability": "image_generation", "x-systemsculpt-output-index": "0", "x-systemsculpt-content-sha256": metadata.sha256, "content-type": "image/png", "content-length": "2", "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "content-disposition": "attachment; filename=\"systemsculpt-image-0.png\"" } }));
    const result = await client.images.downloadOutput("123e4567-e89b-42d3-a456-426614174000", 0, metadata);
    expect([...new Uint8Array(result.bytes)]).toEqual([1, 2]);
    expect(result.metadata).toEqual(metadata);
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({ url: "https://api.test/api/plugin/images/generations/jobs/123e4567-e89b-42d3-a456-426614174000/outputs/0", method: "GET", preserveResponseHeaders: true }));
    expect(request.mock.calls[0][0].headers["x-systemsculpt-image-output-contract"]).toBe("managed-image-output-v1");
    expect(JSON.stringify(request.mock.calls[0][0])).not.toContain("signed");
  });

  it.each([
    ["content length", { "content-length": "1" }], ["content type", { "content-type": "image/jpeg" }],
    ["index", { "x-systemsculpt-output-index": "1" }], ["hash header", { "x-systemsculpt-content-sha256": "b".repeat(64) }],
    ["contract", { "x-systemsculpt-image-output-contract": "other" }], ["disposition", { "content-disposition": "inline" }],
  ])("rejects image output %s mismatch without returning bytes", async (_name, override) => {
    const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: 2, sha256: "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222", width: 1, height: 1 };
    request.mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "x-request-id": "req-1", "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-image-output-contract": "managed-image-output-v1", "x-systemsculpt-capability": "image_generation", "x-systemsculpt-output-index": "0", "x-systemsculpt-content-sha256": metadata.sha256, "content-type": "image/png", "content-length": "2", "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "content-disposition": "attachment; filename=\"systemsculpt-image-0.png\"", ...override } }));
    await expect(client.images.downloadOutput("123e4567-e89b-42d3-a456-426614174000", 0, metadata)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it.each([
    [400, "invalid_request", "The managed image output request is invalid.", false],
    [400, "unsupported_image_output_contract", "Expected managed-image-output-v1.", false],
    [401, "license_required", "A valid license is required.", false], [403, "license_rejected", "License access is forbidden.", false],
    [404, "not_found", "Image output was not found.", false], [409, "output_not_ready", "Image output is not ready.", false],
    [426, "upgrade_required", "A newer SystemSculpt plugin version is required.", false], [429, "rate_limited", "Too many image output requests.", true],
    [500, "internal_error", "The managed image output request could not be completed.", false], [503, "temporarily_unavailable", "The managed image output is temporarily unavailable.", true],
  ] as const)("maps exact image companion envelope %s/%s for download, status, and list", async (status, code, message, retryable) => {
    const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: 2, sha256: "a".repeat(64), width: null, height: null };
    for (const invoke of [
      () => client.images.downloadOutput("123e4567-e89b-42d3-a456-426614174000", 0, metadata),
      () => client.images.status("img-1"),
      () => client.images.list(),
    ]) {
      request.mockResolvedValueOnce(imageError(status, code, message));
      await expect(invoke()).rejects.toMatchObject({ code, status, requestId: "req-1", retryable, message });
    }
  });

  it("rejects mismatched companion response request IDs for download, status, and list", async () => {
    const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: 2, sha256: "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222", width: 1, height: 1 };
    request.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { ...imageContractHeaders("different-id"), "x-systemsculpt-output-index": "0", "x-systemsculpt-content-sha256": metadata.sha256, "content-type": "image/png", "content-length": "2", "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "content-disposition": "attachment; filename=\"systemsculpt-image-0.png\"" } }));
    await expect(client.images.downloadOutput("123e4567-e89b-42d3-a456-426614174000", 0, metadata)).rejects.toMatchObject({ code: "malformed_response" });
    request.mockResolvedValueOnce(json({ job: imageJob(), outputs: [], usage: { raw_usd: 0, cost_source: "provider", estimated: false } }, 200, imageContractHeaders("different-id")));
    await expect(client.images.status("img-1")).rejects.toMatchObject({ code: "malformed_response" });
    request.mockResolvedValueOnce(json({ items: [], next_before: null }, 200, imageContractHeaders("different-id")));
    await expect(client.images.list()).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects non-closed image companion error envelopes without exposing arbitrary fields", async () => {
    request.mockResolvedValue(imageError(404, "not_found", "Image output was not found.", "different-id"));
    await expect(client.images.status("img-1")).rejects.toMatchObject({ code: "malformed_response" });
    request.mockResolvedValue(json({ contract_version: "managed-image-output-v1", code: "not_found", message: "Image output was not found.", request_id: "req-1", storage: "secret" }, 404, imageContractHeaders()));
    await expect(client.images.list()).rejects.toMatchObject({ code: "malformed_response", message: expect.not.stringContaining("secret") });
  });

  it("returns AbortError with no partial result when aborted while reading output bytes", async () => {
    const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: 2, sha256: "a".repeat(64), width: null, height: null };
    const controller = new AbortController();
    const headers = { "x-request-id": "req-1", "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-image-output-contract": "managed-image-output-v1", "x-systemsculpt-capability": "image_generation", "x-systemsculpt-output-index": "0", "x-systemsculpt-content-sha256": metadata.sha256, "content-type": "image/png", "content-length": "2", "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "content-disposition": "attachment; filename=\"systemsculpt-image-0.png\"" };
    request.mockResolvedValue(new Response(new ReadableStream({ pull(stream) { controller.abort(); stream.error(new DOMException("Aborted", "AbortError")); } }), { status: 200, headers }));
    await expect(client.images.downloadOutput("123e4567-e89b-42d3-a456-426614174000", 0, metadata, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects invalid image output identity/metadata and pre-abort before dispatch", async () => {
    const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: 2, sha256: "a".repeat(64), width: null, height: null };
    await expect(client.images.downloadOutput("https://signed/output", 0, metadata)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.images.downloadOutput("123e4567-e89b-42d3-a456-426614174000", 1, metadata)).rejects.toMatchObject({ code: "invalid_request" });
    const controller = new AbortController(); controller.abort();
    await expect(client.images.downloadOutput("123e4567-e89b-42d3-a456-426614174000", 0, metadata, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps terminal status errors exactly and omits forbidden status headers", async () => {
    request.mockResolvedValue(json({ job: { ...txJob("failed"), error: null }, transcript: null, progress: 1 }));
    await expect(client.transcription.status("job")).rejects.toMatchObject({ code: "transcription_failed", requestId: "req-1", retryable: false });
    expect(request.mock.calls[0][0].headers).toEqual({ "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-capability": "transcription" });
  });
});
