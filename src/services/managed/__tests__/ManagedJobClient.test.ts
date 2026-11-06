import fixture from "../../../../testing/fixtures/managed/managed-job-protocol-v1.json";
import imageOutputFixture from "../../../../testing/fixtures/managed/managed-image-output-v1.json";
import { ManagedJobClient, MANAGED_JOB_DESCRIPTORS, MANAGED_JOB_OPERATION_STATUSES, MANAGED_JOB_PROTOCOL } from "../ManagedJobClient";
import { HostedTransportAdapter } from "../adapters/HostedTransportAdapter";
import retryFixture from "../../../../testing/fixtures/retry-after.json";

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-request-id": "req-1", ...headers } });
const txJob = (status = "uploading") => ({ id: "job-1", status, filename: "a.wav", content_type: "audio/wav", content_length_bytes: 5, expires_at: "2099-01-01T00:00:00Z" });

describe("ManagedJobClient exact wire contract", () => {
  const request = jest.fn();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6.0.0", licenseKey: () => "license", requestClient: { request } as any });
  const client = new ManagedJobClient(transport);
  beforeEach(() => { request.mockReset(); });

  it("retains the historical closed image output companion fixture", () => {
    expect(imageOutputFixture.contract_version).toBe("managed-image-output-v1");
    expect(imageOutputFixture.operations).toEqual([
      { name: "generation_status_metadata", method: "GET", path: "/api/plugin/images/generations/jobs/{jobId}", response_transport: "json", output_fields: ["index", "mime_type", "size_bytes", "sha256", "width", "height"] },
      { name: "generation_list_metadata", method: "GET", path: "/api/plugin/images/generations/jobs", query: ["limit", "before", "status"], response_transport: "json", output_fields: ["index", "mime_type", "size_bytes", "sha256", "width", "height"] },
      expect.objectContaining({ name: "generation_output_download", method: "GET", path: "/api/plugin/images/generations/jobs/{jobId}/outputs/{outputIndex}", response_transport: "binary" }),
    ]);
    expect(imageOutputFixture.forbidden_response_fields).toEqual(["url", "signed_url", "object_key", "r2_object_key", "provider", "model", "storage", "etag"]);
  });

  it("pins every fixture operation/status/header declaration", () => {
    for (const f of fixture.descriptors.filter(item => item.capability !== "image_generation")) {
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

  it("parses document, multipart part and result discriminants", async () => {
    request.mockResolvedValueOnce(json({ document: { id: "doc-1", status: "uploading" }, upload: { part_size_bytes: 10, total_parts: 1, part_url_expires_in_seconds: 900, expires_at: "2099-01-01T00:00:00Z" } }));
    await expect(client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 10 }, "op")).resolves.toMatchObject({ document: { id: "doc-1" } });
    request.mockResolvedValueOnce(json({ part: { part_number: 1, method: "PUT", url: "https://signed/x", url_expires_in_seconds: 900, expected_content_length_bytes: 10 } })).mockResolvedValueOnce(new Response("", { status: 200, headers: { etag: `"${"a".repeat(32)}"` } }));
    const part = await client.documents.uploadPart("doc-1", 1, new Uint8Array(10).buffer); expect(part).toEqual({ partNumber: 1, etag: `"${"a".repeat(32)}"` }); expect(JSON.stringify(part)).not.toContain("signed");
    request.mockResolvedValueOnce(json({ result: { content: [], text: "x", markdown: "x", images: [], metadata: {} } }));
    await expect(client.documents.download("doc-1")).resolves.toMatchObject({ result: { text: "x" } });
    // Only the completed-result transfer has the shared generous deadline.
    expect(request.mock.calls.at(-1)?.[0].timeoutMs).toBe(10 * 60_000);
    expect(request.mock.calls.slice(0, -1).every(([input]) => input.timeoutMs === undefined)).toBe(true);
  });

  it("accepts canonical document progress and array downloads while rejecting legacy wire shapes", async () => {
    request.mockResolvedValueOnce(json({ document: { id: "doc-1", status: "completed", error: null, progress: 1 } }));
    await expect(client.documents.status("doc-1")).resolves.toMatchObject({ document: { progress: 1 } });

    request.mockResolvedValueOnce(json({ document: { id: "doc-1", status: "completed", error: null, progress: 100 } }));
    await expect(client.documents.status("doc-1")).rejects.toMatchObject({ code: "malformed_response" });

    request.mockResolvedValueOnce(json({ result: { content: [], text: "x", markdown: "x", images: {}, metadata: {} } }));
    await expect(client.documents.download("doc-1")).rejects.toMatchObject({ code: "malformed_response" });
  });

  it.each(retryFixture.cases)("carries $name through signed uploads, HTTP errors and status hints", async ({ header, milliseconds }) => {
    const now = jest.spyOn(Date, "now").mockReturnValue(retryFixture.now);
    const headers: Record<string, string> = header === null ? {} : { "Retry-After": header };
    const retryAfterMs = milliseconds ?? undefined;
    try {
      for (const capability of ["transcription", "documents"] as const) {
        request.mockResolvedValueOnce(json({ part: {
          part_number: 1, method: "PUT", url: "https://signed/part", url_expires_in_seconds: 900, expected_content_length_bytes: 1,
        } })).mockResolvedValueOnce(new Response("Unavailable", { status: 503, headers }));
        await expect(client[capability].uploadPart("job-1", 1, new Uint8Array([1]).buffer))
          .rejects.toMatchObject({ status: 503, retryable: true, retryAfterMs });
        request.mockResolvedValueOnce(new Response("Unavailable", { status: 503, headers }));
        await expect(client[capability].status("job-1")).rejects.toMatchObject({ retryAfterMs });
      }
      request.mockResolvedValueOnce(json({ document: { id: "doc-1", status: "processing", error: null, progress: 0.5 } }, 200, headers));
      const status = await client.documents.status("doc-1");
      expect(typeof status === "object" && status !== null && "poll_after_ms" in status ? status.poll_after_ms : undefined).toBe(retryAfterMs);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps Retry-After outside strict response bodies while exposing the server poll hint", async () => {
    request.mockResolvedValueOnce(json(
      { document: { id: "doc-1", status: "processing", error: null, progress: 0.5 } },
      200,
      { "retry-after": "2" },
    ));

    await expect(client.documents.status("doc-1")).resolves.toEqual({
      document: { id: "doc-1", status: "processing", error: null, progress: 0.5 },
      poll_after_ms: 2_000,
    });
  });

  it.each([
    ["transcription create", () => client.transcription.create({ filename: "", contentType: "audio/wav", contentLengthBytes: 1 }, "op")],
    ["transcription extra", () => client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 1, extra: true } as any, "op")],
    ["transcription timestamped", () => client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 1, timestamped: "yes" } as any, "op")],
    ["document extra", () => client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 1, extra: true } as any, "op")],
    ["document content type", () => client.documents.create({ filename: "a", contentType: "text/plain", contentLengthBytes: 1 }, "op")],
    ["part zero", () => client.transcription.uploadPart("job", 0, new ArrayBuffer(1))],
    ["duplicate parts", () => client.documents.complete("doc", [{ partNumber: 1, etag: "a".repeat(32) }, { partNumber: 1, etag: "b".repeat(32) }], "op")],
  ])("rejects invalid request matrix: %s", async (_name, invoke) => { await expect(Promise.resolve().then(invoke)).rejects.toMatchObject({ code: "invalid_request" }); expect(request).not.toHaveBeenCalled(); });

  it.each([
    ["transcription create", () => client.transcription.create({ filename: "a", contentType: "audio/wav", contentLengthBytes: 1 }, "op"), { job: { id: "job", status: "uploading" }, upload: {} }],
    ["transcription status", () => client.transcription.status("job"), { job: { ...txJob(), error: null }, transcript: 5, progress: 2 }],
    ["document create", () => client.documents.create({ filename: "a.pdf", contentType: "application/pdf", contentLengthBytes: 1 }, "op"), { job: { id: "doc", status: "uploading" }, upload: {} }],
    ["document status", () => client.documents.status("doc"), { document: { id: "doc", status: "expired", error: null, progress: 0 } }],
    ["part", () => client.documents.uploadPart("doc", 1, new ArrayBuffer(1)), { part: { part_number: 1, method: "POST", url: "https://signed", url_expires_in_seconds: 900, expected_content_length_bytes: 1 } }],
    ["part expiry", () => client.documents.uploadPart("doc", 1, new ArrayBuffer(1)), { part: { part_number: 1, method: "PUT", url: "https://signed", url_expires_in_seconds: 899, expected_content_length_bytes: 1 } }],
    ["result", () => client.documents.download("doc"), { result: { content: "bad", text: "x", markdown: "x", images: [], metadata: {} } }],
  ] as const)("rejects malformed actual %s parser", async (_name, invoke, payload) => { request.mockResolvedValue(json(payload)); await expect(invoke()).rejects.toMatchObject({ code: "malformed_response" }); });

  it.each([
    [400, "invalid_request", false], [401, "license_required", false], [402, "payment_required", false], [403, "license_rejected", false], [409, "operation_conflict", false], [426, "upgrade_required", false], [429, "rate_limited", true], [502, "temporarily_unavailable", true], [503, "temporarily_unavailable", true],
  ])("maps HTTP %s exactly with request ID/retryability", async (status, code, retryable) => {
    request.mockResolvedValue(json({ code }, status, { "retry-after": "5" }));
    await expect(client.transcription.status("job")).rejects.toMatchObject({
      code,
      status,
      requestId: "req-1",
      retryable,
      retryAfterMs: 5_000,
    });
  });

  it("turns a 402 into the credits message instead of a raw status (#300)", async () => {
    request.mockResolvedValue(json({ error: { code: "insufficient_credits" } }, 402));

    await expect(client.documents.start("doc-1", "op")).rejects.toMatchObject({
      code: "payment_required",
      status: 402,
      message: "Not enough credits. Add more to continue.",
      retryable: false,
    });
  });

  it("turns a retryable 503 into a customer-facing availability message", async () => {
    request.mockResolvedValue(json({ code: "temporarily_unavailable" }, 503));

    await expect(client.transcription.status("job")).rejects.toMatchObject({
      code: "temporarily_unavailable",
      message: "SystemSculpt processing is temporarily unavailable.",
      retryable: true,
    });
  });

  it.each([
    ["transcription.upload_complete", () => client.transcription.complete("job", [{ partNumber: 1, etag: "a".repeat(32) }], "op"), (status: string) => ({ job: { id: "job", status } }), "queued", "uploading"],
    ["transcription.start", () => client.transcription.start("job", "op"), (status: string) => ({ job: { id: "job", status } }), "queued", "uploading"],
    ["document.upload_complete", () => client.documents.complete("doc", [{ partNumber: 1, etag: "a".repeat(32) }], "op"), (status: string) => ({ document: { id: "doc", status } }), "queued", "uploading"],
    ["document.start", () => client.documents.start("doc", "op"), (status: string) => ({ document: { id: "doc", status } }), "queued", "uploading"],
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

  it("maps terminal status errors exactly and omits forbidden status headers", async () => {
    request.mockResolvedValue(json({ job: { ...txJob("failed"), error: null }, transcript: null, progress: 1 }));
    await expect(client.transcription.status("job")).rejects.toMatchObject({ code: "transcription_failed", requestId: "req-1", retryable: false });
    expect(request.mock.calls[0][0].headers).toEqual({ "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-capability": "transcription" });
  });
});
