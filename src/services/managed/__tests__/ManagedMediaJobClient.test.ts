import { ManagedMediaJobClient, ManagedMediaJobError, MANAGED_MEDIA_JOB_PROTOCOL } from "../ManagedMediaJobClient";
import { HostedTransportAdapter } from "../adapters/HostedTransportAdapter";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const SHA_1_2 = "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222";
const v2Headers = (requestId = "req-1") => ({ "x-request-id": requestId, "x-systemsculpt-contract": "managed-capabilities-v2", "x-systemsculpt-job-contract": MANAGED_MEDIA_JOB_PROTOCOL });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...v2Headers(), ...headers } });
const envelope = (status: number, code: string, message: string, requestId = "req-1") => json({ contract_version: MANAGED_MEDIA_JOB_PROTOCOL, code, message, request_id: requestId }, status, v2Headers(requestId));
const createJob = (status = "queued", extra: Record<string, unknown> = {}) => ({ id: JOB_ID, status, model: "test/model-1", created_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", error: null, ...extra });
const mediaJob = (status = "queued", extra: Record<string, unknown> = {}) => ({ id: JOB_ID, status, model: "test/model-1", created_at: "2026-01-01T00:00:00Z", processing_started_at: null, completed_at: null, expires_at: "2099-01-01T00:00:00Z", error: null, attempt_count: 1, ...extra });
const succeededJob = (extra: Record<string, unknown> = {}) => mediaJob("succeeded", { processing_started_at: "2026-01-01T00:00:01Z", completed_at: "2026-01-01T00:00:02Z", ...extra });
const usage = (raw_usd = 0.1) => ({ raw_usd, cost_source: "provider", estimated: false });
const imageOutput = { index: 0, mime_type: "image/png" as const, size_bytes: 2, sha256: SHA_1_2, width: 10, height: 20 };
const videoOutput = { index: 0, mime_type: "video/mp4" as const, size_bytes: 2, sha256: SHA_1_2, width: 1920, height: 1080, duration_seconds: 8 };
const futureUploadExpiry = () => new Date(Date.now() + 600_000).toISOString();
const downloadStartedAt = () => new Date(Date.now() - 500).toISOString();
const imageDownloadHeaders = (overrides: Record<string, string> = {}) => ({ ...v2Headers(), "x-systemsculpt-output-index": "0", "x-systemsculpt-content-sha256": SHA_1_2, "x-systemsculpt-download-started-at": downloadStartedAt(), "x-systemsculpt-download-requested-at": new Date().toISOString(), "content-type": "image/png", "content-length": "2", "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "content-disposition": "attachment; filename=\"systemsculpt-image-0.png\"", ...overrides });
const videoDownloadHeaders = (overrides: Record<string, string> = {}) => ({ ...v2Headers(), "x-systemsculpt-output-index": "0", "x-systemsculpt-content-sha256": SHA_1_2, "x-systemsculpt-download-started-at": downloadStartedAt(), "x-systemsculpt-download-requested-at": new Date().toISOString(), "content-type": "video/mp4", "content-length": "2", "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "content-disposition": "attachment; filename=\"systemsculpt-video-0.mp4\"", ...overrides });
const frame = (role: "first_frame" | "last_frame" = "first_frame") => ({ role, type: "uploaded" as const, key: "inputs/key-a", mime_type: "image/png" as const, size_bytes: 1, sha256: "a".repeat(64) });

describe("ManagedMediaJobClient managed-job-protocol-v2 wire contract", () => {
  const request = jest.fn();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6.0.0", licenseKey: () => "license", requestClient: { request } as any });
  const client = new ManagedMediaJobClient(transport, undefined, () => "req-1");
  beforeEach(() => { request.mockReset(); });

  it.each([
    ["images.create", () => client.images.create({ prompt: "x", model: "test/model-1" }, "op"), "image_generation", true],
    ["images.status", () => client.images.status(JOB_ID), "image_generation", false],
    ["images.list", () => client.images.list(), "image_generation", false],
    ["images.prepareInputs", () => client.images.prepareInputs([{ mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }], async () => new ArrayBuffer(1)), "image_generation", false],
    ["videos.create", () => client.videos.create({ model: "test/model-1", prompt: "x" }, "op"), "video_generation", true],
    ["videos.status", () => client.videos.status(JOB_ID), "video_generation", false],
    ["videos.list", () => client.videos.list(), "video_generation", false],
    ["images.acknowledgeDelivery", () => client.images.acknowledgeDelivery(JOB_ID, { download_completed_offset_ms: 1, displayed_offset_ms: 2, vault_write_completed_offset_ms: 3 }), "image_generation", false],
  ] as const)("sends exact scoped v2 headers for %s", async (_name, invoke, capability, idem) => {
    request.mockResolvedValue(json({})); await invoke().catch(() => undefined);
    const headers = request.mock.calls[0][0].headers;
    expect(headers["x-systemsculpt-capability"]).toBe(capability);
    expect(headers["x-systemsculpt-job-contract"]).toBe(MANAGED_MEDIA_JOB_PROTOCOL);
    expect(headers["x-systemsculpt-contract"]).toBe("managed-capabilities-v2");
    expect(headers["x-request-id"]).toBe("req-1");
    expect(Object.hasOwn(headers, "x-plugin-version")).toBe(false);
    expect(Object.hasOwn(headers, "idempotency-key")).toBe(idem);
    expect(headers).not.toHaveProperty("Idempotency-Key");
    if (idem) expect(headers["idempotency-key"]).toBe("op:create");
  });

  it("creates an image job with a model and returns only the v2 envelope", async () => {
    request.mockResolvedValue(json({ job: createJob(), poll_url: `/api/plugin/images/generations/jobs/${JOB_ID}` }, 202));
    const body = { prompt: "a red fox", model: "test/model-1", options: { count: 2, aspect_ratio: "16:9", image_size: "2K" as const, seed: 7 } };
    const result = await client.images.create(body, "operation-1");
    expect(result).toEqual({ job: createJob(), poll_url: `/api/plugin/images/generations/jobs/${JOB_ID}` });
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({ method: "POST", body, url: "https://api.test/api/plugin/images/generations/jobs" }));
  });

  it("creates a video job with frame images and surfaces idempotent replay", async () => {
    request.mockResolvedValue(json({ job: createJob("processing"), poll_url: `/api/plugin/videos/generations/jobs/${JOB_ID}`, idempotent_replay: true }, 202));
    const body = { model: "test/model-1", prompt: "a fox runs", frame_images: [frame("first_frame"), frame("last_frame")], options: { duration_seconds: 8, resolution: "1080p" as const, aspect_ratio: "16:9", generate_audio: true, seed: 3 } };
    const result = await client.videos.create(body, "operation-1");
    expect(result).toEqual({ job: createJob("processing"), poll_url: `/api/plugin/videos/generations/jobs/${JOB_ID}`, idempotent_replay: true });
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({ method: "POST", body, url: "https://api.test/api/plugin/videos/generations/jobs" }));
  });

  it.each([
    ["image empty prompt", () => client.images.create({ prompt: "" }, "op")],
    ["image long prompt", () => client.images.create({ prompt: "x".repeat(8001) }, "op")],
    ["image model", () => client.images.create({ prompt: "x", model: "bad model!" }, "op")],
    ["image extra key", () => client.images.create({ prompt: "x", extra: true } as any, "op")],
    ["image count", () => client.images.create({ prompt: "x", options: { count: 5 } }, "op")],
    ["image aspect", () => client.images.create({ prompt: "x", options: { aspect_ratio: "wide" } }, "op")],
    ["image size", () => client.images.create({ prompt: "x", options: { image_size: "huge" } } as any, "op")],
    ["image seed", () => client.images.create({ prompt: "x", options: { seed: -1 } }, "op")],
    ["image input key", () => client.images.create({ prompt: "x", input_images: [{ type: "uploaded", key: "https://storage/key", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }] }, "op")],
    ["image too many inputs", () => client.images.create({ prompt: "x", input_images: Array.from({ length: 5 }, () => ({ type: "uploaded" as const, key: "k", mime_type: "image/png" as const, size_bytes: 1, sha256: "a".repeat(64) })) }, "op")],
    ["image idempotency", () => client.images.create({ prompt: "x" }, "bad:id")],
    ["image missing idempotency", () => client.images.create({ prompt: "x" }, undefined as never)],
    ["video missing model", () => client.videos.create({ prompt: "x" } as any, "op")],
    ["video duplicate roles", () => client.videos.create({ model: "test/model-1", prompt: "x", frame_images: [frame("first_frame"), frame("first_frame")] }, "op")],
    ["video frame role", () => client.videos.create({ model: "test/model-1", prompt: "x", frame_images: [{ ...frame(), role: "middle_frame" as any }] }, "op")],
    ["video duration", () => client.videos.create({ model: "test/model-1", prompt: "x", options: { duration_seconds: 61 } }, "op")],
    ["video resolution", () => client.videos.create({ model: "test/model-1", prompt: "x", options: { resolution: "1080p?" } } as any, "op")],
    ["video aspect", () => client.videos.create({ model: "test/model-1", prompt: "x", options: { aspect_ratio: "wide" } }, "op")],
    ["video audio flag", () => client.videos.create({ model: "test/model-1", prompt: "x", options: { generate_audio: "yes" } } as any, "op")],
    ["list limit", () => client.images.list({ limit: 101 })],
    ["list before", () => client.videos.list({ before: "not-date" })],
    ["list status", () => client.images.list({ status: "completed" as any })],
    ["status job id", () => client.images.status("img-1")],
    ["download job id", () => client.videos.downloadOutput("not-a-uuid", 0, videoOutput)],
    ["download index", () => client.images.downloadOutput(JOB_ID, 4, imageOutput)],
    ["download index mismatch", () => client.images.downloadOutput(JOB_ID, 1, imageOutput)],
    ["download metadata", () => client.videos.downloadOutput(JOB_ID, 0, { ...videoOutput, sha256: "not-hex" })],
    ["delivery timing order", () => client.images.acknowledgeDelivery(JOB_ID, { download_completed_offset_ms: 3, displayed_offset_ms: 2, vault_write_completed_offset_ms: 4 })],
    ["video delivery outputs", () => client.videos.acknowledgeDelivery(JOB_ID, { download_completed_offset_ms: 1, displayed_offset_ms: 2, vault_write_completed_offset_ms: 3, outputs: [] })],
  ])("rejects invalid request matrix: %s", async (_name, invoke) => { await expect(Promise.resolve().then(invoke)).rejects.toMatchObject({ code: "invalid_request" }); expect(request).not.toHaveBeenCalled(); });

  it.each([
    ["create relative poll_url", () => client.images.create({ prompt: "x" }, "op"), { job: createJob(), poll_url: "https://evil/poll" }],
    ["create scheme-relative poll_url", () => client.images.create({ prompt: "x" }, "op"), { job: createJob(), poll_url: "//evil/poll" }],
    ["create job extra field", () => client.images.create({ prompt: "x" }, "op"), { job: { ...createJob(), url: "https://signed" }, poll_url: "/poll" }],
    ["create legacy status", () => client.images.create({ prompt: "x" }, "op"), { job: createJob("uploading"), poll_url: "/poll" }],
    ["status root extra field", () => client.images.status(JOB_ID), { job: succeededJob(), outputs: [imageOutput], usage: usage(), provider: "leak" }],
    ["status succeeded without outputs", () => client.images.status(JOB_ID), { job: succeededJob(), outputs: [], usage: usage() }],
    ["status succeeded without completion", () => client.images.status(JOB_ID), { job: succeededJob({ completed_at: null }), outputs: [imageOutput], usage: usage() }],
    ["status processing without start", () => client.images.status(JOB_ID), { job: mediaJob("processing"), outputs: [], usage: usage() }],
    ["status queued with start", () => client.images.status(JOB_ID), { job: mediaJob("queued", { processing_started_at: "2026-01-01T00:00:01Z" }), outputs: [], usage: usage() }],
    ["status queued with outputs", () => client.images.status(JOB_ID), { job: mediaJob(), outputs: [imageOutput], usage: usage() }],
    ["status duplicate output index", () => client.images.status(JOB_ID), { job: succeededJob(), outputs: [imageOutput, imageOutput], usage: usage() }],
    ["status negative usage", () => client.images.status(JOB_ID), { job: succeededJob(), outputs: [imageOutput], usage: usage(-1) }],
    ["status poll bound", () => client.images.status(JOB_ID), { job: mediaJob(), outputs: [], usage: usage(0), poll_after_ms: 3_600_001 }],
    ["status identity change", () => client.images.status(JOB_ID), { job: succeededJob({ id: "223e4567-e89b-42d3-a456-426614174000" }), outputs: [imageOutput], usage: usage() }],
    ["status signed output field", () => client.images.status(JOB_ID), { job: succeededJob(), outputs: [{ ...imageOutput, url: "https://signed/x" }], usage: usage() }],
    ["video output missing duration", () => client.videos.status(JOB_ID), { job: succeededJob(), outputs: [{ index: 0, mime_type: "video/mp4", size_bytes: 2, sha256: SHA_1_2, width: 1, height: 1 }], usage: usage() }],
    ["image output with duration", () => client.images.status(JOB_ID), { job: succeededJob(), outputs: [{ ...imageOutput, duration_seconds: 8 }], usage: usage() }],
    ["video output wrong mime", () => client.videos.status(JOB_ID), { job: succeededJob(), outputs: [{ ...videoOutput, mime_type: "image/png" }], usage: usage() }],
    ["list next_before", () => client.videos.list(), { items: [], next_before: "not-date" }],
    ["list item shape", () => client.images.list(), { items: [{ job: mediaJob(), outputs: [], usage: usage(), extra: 1 }], next_before: null }],
  ] as const)("rejects malformed v2 response: %s", async (_name, invoke, payload) => { request.mockResolvedValue(json(payload)); await expect(invoke()).rejects.toMatchObject({ code: "malformed_response" }); });

  it("returns progress hints from the body and falls back to Retry-After", async () => {
    request.mockResolvedValueOnce(json({ job: mediaJob("processing", { processing_started_at: "2026-01-01T00:00:01Z" }), outputs: [], usage: usage(0), poll_after_ms: 1500, typical_duration_ms: 45_000 }));
    await expect(client.videos.status(JOB_ID)).resolves.toMatchObject({ poll_after_ms: 1500, typical_duration_ms: 45_000 });
    request.mockResolvedValueOnce(json({ job: mediaJob("processing", { processing_started_at: "2026-01-01T00:00:01Z" }), outputs: [], usage: usage(0) }, 200, { "retry-after": "2" }));
    await expect(client.images.status(JOB_ID)).resolves.toMatchObject({ poll_after_ms: 2_000 });
  });

  it("returns succeeded status metadata for both media kinds without signed fields", async () => {
    request.mockResolvedValueOnce(json({ job: succeededJob(), outputs: [imageOutput], usage: usage() }));
    const image = await client.images.status(JOB_ID);
    expect(image.outputs).toEqual([imageOutput]);
    request.mockResolvedValueOnce(json({ job: succeededJob(), outputs: [videoOutput], usage: usage() }));
    const video = await client.videos.status(JOB_ID);
    expect(video.outputs).toEqual([videoOutput]);
    expect(JSON.stringify([image, video])).not.toMatch(/signed|url/);
  });

  it("constructs the generation list query from typed fields", async () => {
    request.mockResolvedValue(json({ items: [{ job: mediaJob(), outputs: [], usage: usage(0) }], next_before: null }));
    const result = await client.videos.list({ limit: 10, before: "2026-01-01T00:00:00Z", status: "failed" });
    expect(result.items).toHaveLength(1);
    expect(request.mock.calls[0][0].url).toContain("/api/plugin/videos/generations/jobs?limit=10&before=2026-01-01T00%3A00%3A00Z&status=failed");
  });

  it.each([
    ["image", () => client.images.status(JOB_ID), "image_generation_failed"],
    ["video", () => client.videos.status(JOB_ID), "video_generation_failed"],
  ] as const)("surfaces the server's curated %s terminal failure detail", async (_kind, invoke, code) => {
    request.mockResolvedValue(json({ job: mediaJob("failed", { processing_started_at: "2026-01-01T00:00:01Z", completed_at: "2026-01-01T00:00:02Z", error: { code: "provider_timeout", message: "The provider timed out before finishing this job." } }), outputs: [], usage: { raw_usd: 0, cost_source: "not_billed", estimated: false } }));
    await expect(invoke()).rejects.toMatchObject({ code, message: "The provider timed out before finishing this job.", jobFailure: { jobId: JOB_ID, code: "provider_timeout" }, retryable: false, requestId: "req-1" });
  });

  it("degrades unsafe terminal failure detail to the generic message and maps expiry", async () => {
    request.mockResolvedValueOnce(json({ job: mediaJob("failed", { processing_started_at: "2026-01-01T00:00:01Z", completed_at: "2026-01-01T00:00:02Z", error: { code: "Bad Code!", message: "multi\nline provider stack" } }), outputs: [], usage: usage(0) }));
    await expect(client.images.status(JOB_ID)).rejects.toMatchObject({ code: "image_generation_failed", message: "Managed job failed.", jobFailure: { jobId: JOB_ID, code: null } });
    request.mockResolvedValueOnce(json({ job: mediaJob("expired"), outputs: [], usage: usage(0) }));
    await expect(client.videos.status(JOB_ID)).rejects.toMatchObject({ code: "job_expired", retryable: false });
  });

  it("throws the terminal failure when a create replays onto a failed job", async () => {
    request.mockResolvedValue(json({ job: createJob("failed", { error: { code: "provider_error", message: "The provider rejected this job." } }), poll_url: "/poll", idempotent_replay: true }));
    await expect(client.videos.create({ model: "test/model-1", prompt: "x" }, "op")).rejects.toMatchObject({ code: "video_generation_failed", message: "The provider rejected this job.", jobFailure: { jobId: JOB_ID, code: "provider_error" } });
  });

  it("maps exact v2 error envelopes with request ID echo and retryability", async () => {
    request.mockResolvedValueOnce(envelope(402, "insufficient_credits", "Not enough credits are available for this generation."));
    await expect(client.images.create({ prompt: "x" }, "op")).rejects.toMatchObject({ code: "insufficient_credits", message: "Not enough credits are available for this generation.", status: 402, requestId: "req-1", retryable: false });
    request.mockResolvedValueOnce(envelope(429, "rate_limited", "Too many media requests."));
    await expect(client.videos.status(JOB_ID)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it.each([
    [400, "invalid_request", false], [401, "license_required", false], [402, "payment_required", false], [403, "license_rejected", false], [404, "not_found", false], [409, "operation_conflict", false], [413, "invalid_request", false], [426, "upgrade_required", false], [429, "rate_limited", true], [502, "temporarily_unavailable", true], [503, "temporarily_unavailable", true],
  ] as const)("falls back to the HTTP %s taxonomy when the envelope is not exact", async (status, code, retryable) => {
    request.mockResolvedValue(json({ contract_version: MANAGED_MEDIA_JOB_PROTOCOL, code: "server_code", message: "detail", request_id: "req-1", storage: "secret" }, status, { ...v2Headers(), "retry-after": "5" }));
    await expect(client.images.status(JOB_ID)).rejects.toMatchObject({ code, status, requestId: "req-1", retryable, retryAfterMs: 5_000, message: expect.not.stringContaining("secret") });
  });

  it("ignores an envelope whose request ID does not echo and non-JSON error bodies", async () => {
    request.mockResolvedValueOnce(envelope(404, "not_found", "Job not found.", "different-id"));
    await expect(client.images.status(JOB_ID)).rejects.toMatchObject({ code: "not_found", message: "The managed media job was not found." });
    request.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 503, headers: v2Headers() }));
    await expect(client.videos.status(JOB_ID)).rejects.toMatchObject({ code: "temporarily_unavailable", retryable: true });
  });

  it("rejects mismatched response request IDs on successful JSON responses", async () => {
    request.mockResolvedValue(json({ job: mediaJob(), outputs: [], usage: usage(0) }, 200, { "x-request-id": "different-id" }));
    await expect(client.images.status(JOB_ID)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("prepares v2 inputs with exact upload headers and returns keys in index order", async () => {
    const signed = jest.spyOn(transport as any, "uploadSignedInput").mockResolvedValue(undefined);
    request.mockResolvedValue(json({ contract: "systemsculpt-image-input-upload-v1", upload_id: "up-1", expires_at: futureUploadExpiry(), input_uploads: [
      { index: 1, upload: { method: "PUT", url: "https://signed/b", headers: { "content-type": "image/webp" }, expires_in_seconds: 900, expires_at: futureUploadExpiry() }, input_image: { type: "uploaded", key: "key-b", mime_type: "image/webp", size_bytes: 2, sha256: "b".repeat(64) } },
      { index: 0, upload: { method: "PUT", url: "https://signed/a", headers: { "content-type": "image/png" }, expires_in_seconds: 900, expires_at: futureUploadExpiry() }, input_image: { type: "uploaded", key: "key-a", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) } },
    ] }));
    const publicResult = await client.images.prepareInputs([
      { mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) },
      { mime_type: "image/webp", size_bytes: 2, sha256: "b".repeat(64) },
    ], async index => new Uint8Array(index === 0 ? [1] : [2, 2]).buffer);
    expect(publicResult).toEqual({ uploadId: "up-1", inputs: [
      { type: "uploaded", key: "key-a", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) },
      { type: "uploaded", key: "key-b", mime_type: "image/webp", size_bytes: 2, sha256: "b".repeat(64) },
    ] });
    expect(JSON.stringify(publicResult)).not.toContain("signed");
    expect(signed.mock.calls.map(call => [call[0], call[2], call[3].byteLength])).toEqual([
      ["https://signed/b", { "content-type": "image/webp" }, 2],
      ["https://signed/a", { "content-type": "image/png" }, 1],
    ]);
    signed.mockRestore();
  });

  it.each([
    ["wrong contract", { contract: "managed-job-protocol-v1" }],
    ["extra upload header", { entryHeaders: { "content-type": "image/png", authorization: "secret" } }],
    ["non-https upload", { url: "http://signed/a" }],
    ["mismatched input identity", { sha256: "c".repeat(64) }],
  ] as const)("rejects a malformed prepare response: %s", async (_name, override: Record<string, unknown>) => {
    request.mockResolvedValue(json({ contract: (override.contract as string) ?? "systemsculpt-image-input-upload-v1", upload_id: "up-1", expires_at: futureUploadExpiry(), input_uploads: [
      { index: 0, upload: { method: "PUT", url: (override.url as string) ?? "https://signed/a", headers: (override.entryHeaders as Record<string, string>) ?? { "content-type": "image/png" }, expires_in_seconds: 900, expires_at: futureUploadExpiry() }, input_image: { type: "uploaded", key: "key-a", mime_type: "image/png", size_bytes: 1, sha256: (override.sha256 as string) ?? "a".repeat(64) } },
    ] }));
    await expect(client.images.prepareInputs([{ mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }], async () => new ArrayBuffer(1))).rejects.toMatchObject({ code: "malformed_response" });
  });

  it.each([
    ["image", () => client.images.downloadOutput(JOB_ID, 0, imageOutput), imageDownloadHeaders(), imageOutput, "images"],
    ["video", () => client.videos.downloadOutput(JOB_ID, 0, videoOutput), videoDownloadHeaders(), videoOutput, "videos"],
  ] as const)("downloads one verified %s output with exact headers and integrity", async (_kind, invoke, headers, metadata, segment) => {
    request.mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200, headers }));
    const result = await invoke();
    expect([...new Uint8Array(result.bytes)]).toEqual([1, 2]);
    expect(result.metadata).toEqual(metadata);
    expect(result.delivery.download_started_at).toBe(headers["x-systemsculpt-download-started-at"]);
    expect(result.delivery.download_completed_offset_ms).toBeGreaterThanOrEqual(0);
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({ url: `https://api.test/api/plugin/${segment}/generations/jobs/${JOB_ID}/outputs/0`, method: "GET", preserveResponseHeaders: true }));
    expect(request.mock.calls[0][0].headers["x-systemsculpt-job-contract"]).toBe(MANAGED_MEDIA_JOB_PROTOCOL);
    expect(JSON.stringify(request.mock.calls[0][0])).not.toContain("signed");
  });

  it("downloads a valid chunked media output when content-length is absent", async () => {
    const { "content-length": _omit, ...headers } = videoDownloadHeaders();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2]));
        controller.close();
      },
    });
    request.mockResolvedValue(new Response(body, { status: 200, headers }));
    const result = await client.videos.downloadOutput(JOB_ID, 0, videoOutput);
    expect([...new Uint8Array(result.bytes)]).toEqual([1, 2]);
  });

  it("measures a retried download without comparing the server and device clocks", async () => {
    const elapsedTimes = [1_000, 1_250];
    const clockIndependentClient = new ManagedMediaJobClient(
      transport,
      () => Date.parse("2035-01-01T00:00:00.000Z"),
      () => "req-1",
      () => elapsedTimes.shift() as number,
    );
    request.mockResolvedValue(new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: videoDownloadHeaders({
        "x-systemsculpt-download-started-at": "2026-08-22T12:00:00.000Z",
        "x-systemsculpt-download-requested-at": "2026-08-22T12:00:05.000Z",
      }),
    }));

    const result = await clockIndependentClient.videos.downloadOutput(JOB_ID, 0, videoOutput);

    expect(result.delivery.download_completed_offset_ms).toBe(5_250);
  });

  it.each([
    ["content type", videoDownloadHeaders({ "content-type": "video/webm" }), "content-type"],
    ["disposition", videoDownloadHeaders({ "content-disposition": "inline" }), "disposition"],
    ["job contract", videoDownloadHeaders({ "x-systemsculpt-job-contract": "managed-job-protocol-v1" }), "x-systemsculpt-job-contract"],
    ["index", videoDownloadHeaders({ "x-systemsculpt-output-index": "1" }), "x-systemsculpt-output-index"],
    ["hash header", videoDownloadHeaders({ "x-systemsculpt-content-sha256": "b".repeat(64) }), "x-systemsculpt-content-sha256"],
    ["cache policy", videoDownloadHeaders({ "cache-control": "public" }), "cache-control"],
    ["content length", videoDownloadHeaders({ "content-length": "3" }), "content-length"],
    ["download timing", videoDownloadHeaders({ "x-systemsculpt-download-started-at": "not-a-date" }), "x-systemsculpt-download-started-at"],
    ["download request timing", videoDownloadHeaders({ "x-systemsculpt-download-requested-at": "not-a-date" }), "x-systemsculpt-download-requested-at"],
  ] as const)("rejects media output %s mismatch without returning bytes", async (_name, headers, diagnostic) => {
    request.mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200, headers }));
    await expect(client.videos.downloadOutput(JOB_ID, 0, videoOutput)).rejects.toMatchObject({ code: "malformed_response", message: expect.stringContaining(diagnostic) });
  });

  it("rejects and cancels an oversized chunked media body", async () => {
    const cancel = jest.fn();
    const { "content-length": _omit, ...headers } = imageDownloadHeaders();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel });
    request.mockResolvedValue(new Response(body, { status: 200, headers }));
    await expect(client.images.downloadOutput(JOB_ID, 0, imageOutput)).rejects.toMatchObject({ code: "malformed_response", message: "Managed media output exceeded expected size." });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["truncated", new Uint8Array([1])],
    ["empty", null],
  ])("rejects a %s media body after bounded reading", async (_label, body) => {
    const { "content-length": _omit, ...headers } = imageDownloadHeaders();
    request.mockResolvedValue(new Response(body, { status: 200, headers }));
    await expect(client.images.downloadOutput(JOB_ID, 0, imageOutput)).rejects.toMatchObject({ code: "malformed_response", message: "Managed media output integrity mismatch." });
  });

  it("rejects a redirect instead of interpreting it as media bytes", async () => {
    request.mockResolvedValue(new Response(null, { status: 302, headers: v2Headers() }));
    await expect(client.images.downloadOutput(JOB_ID, 0, imageOutput)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("maps v2 error envelopes on download responses", async () => {
    request.mockResolvedValue(envelope(409, "output_not_ready", "The requested output is not ready."));
    await expect(client.videos.downloadOutput(JOB_ID, 0, videoOutput)).rejects.toMatchObject({ code: "output_not_ready", status: 409, requestId: "req-1" });
  });

  it("acknowledges image delivery and sorts measured video outputs", async () => {
    request.mockResolvedValueOnce(json({ acknowledged: true, acknowledged_at: "2026-08-22T12:00:00.000Z" }));
    await expect(client.images.acknowledgeDelivery(JOB_ID, {
      download_completed_offset_ms: 100,
      displayed_offset_ms: 120,
      vault_write_completed_offset_ms: 150,
    })).resolves.toEqual({ acknowledged: true, acknowledged_at: "2026-08-22T12:00:00.000Z" });
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({
      method: "POST",
      url: `https://api.test/api/plugin/images/generations/jobs/${JOB_ID}/delivery`,
      body: { download_completed_offset_ms: 100, displayed_offset_ms: 120, vault_write_completed_offset_ms: 150 },
    }));

    request.mockResolvedValueOnce(json({ acknowledged: true, acknowledged_at: "2026-08-22T12:00:01.000Z" }));
    await client.videos.acknowledgeDelivery(JOB_ID, {
      download_completed_offset_ms: 200,
      displayed_offset_ms: 220,
      vault_write_completed_offset_ms: 250,
      outputs: [
        { index: 1, width: 1280, height: 720, duration_seconds: 8 },
        { index: 0, width: 1920, height: 1080, duration_seconds: 8 },
      ],
    });
    expect(request.mock.calls[1][0].body.outputs.map((output: { index: number }) => output.index)).toEqual([0, 1]);
  });

  it("returns AbortError with no partial result when aborted while reading output bytes", async () => {
    const controller = new AbortController();
    request.mockResolvedValue(new Response(new ReadableStream({ pull(stream) { controller.abort(); stream.error(new DOMException("Aborted", "AbortError")); } }), { status: 200, headers: imageDownloadHeaders() }));
    await expect(client.images.downloadOutput(JOB_ID, 0, imageOutput, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("pre-aborts before dispatch and exposes the typed error class", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(client.videos.status(JOB_ID, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.images.downloadOutput(JOB_ID, 0, imageOutput, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue(json({}, 404));
    const failure = await client.images.status(JOB_ID).catch(error => error);
    expect(failure).toBeInstanceOf(ManagedMediaJobError);
  });
});
