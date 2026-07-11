import fixture from "../../../../testing/fixtures/managed/managed-job-protocol-v1.json";
import { ManagedJobClient, MANAGED_JOB_DESCRIPTORS, MANAGED_JOB_PROTOCOL } from "../ManagedJobClient";
import { HostedTransportAdapter } from "../adapters/HostedTransportAdapter";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-request-id": "req-1" } });

describe("ManagedJobClient", () => {
  const request = jest.fn();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6.0.0", licenseKey: () => "license", requestClient: { request } as any });
  const client = new ManagedJobClient(transport);
  beforeEach(() => { request.mockReset(); request.mockResolvedValue(json({ job: { id: "job-1", status: "uploading" }, upload: { part_size_bytes: 5, total_parts: 1, part_url_expires_in_seconds: 900 } })); });

  it("pins every fixture operation, status set, and operation-scoped header rule", () => {
    for (const fixtureDescriptor of fixture.descriptors) {
      const capability = fixtureDescriptor.capability as keyof typeof MANAGED_JOB_DESCRIPTORS;
      const descriptor = MANAGED_JOB_DESCRIPTORS[capability];
      expect(descriptor).toBeDefined();
      expect(Object.entries(descriptor.paths).map(([name, [method, path]]) => ({ name, method, path }))).toEqual(
        fixtureDescriptor.operations.map(({ name, method, path }) => ({ name, method, path })),
      );
      expect(descriptor.statuses).toEqual([...fixtureDescriptor.statuses.non_terminal, ...fixtureDescriptor.statuses.terminal]);
      expect(descriptor.version).toEqual(fixtureDescriptor.version.required_on);
      expect(descriptor.idempotent).toEqual(fixtureDescriptor.idempotency.required_on);
      expect(fixtureDescriptor.auth).toEqual({ type: "license", header: "x-license-key" });
      expect(fixtureDescriptor.cancellation.supported).toBe(false);
    }
  });

  it("sends exact operation-scoped transcription create headers and validates snake_case response", async () => {
    const result = await client.transcription.create({ filename: "a.wav", contentType: "audio/wav", contentLengthBytes: 5 }, "operation-1");
    expect(result.job).toEqual({ id: "job-1", status: "uploading" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.test/api/plugin/audio/transcriptions/jobs", method: "POST", licenseKey: "license",
      headers: {
        "x-systemsculpt-contract": "managed-capabilities-v2",
        "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL,
        "x-systemsculpt-capability": "transcription",
        "x-plugin-version": "6.0.0",
        "idempotency-key": "operation-1:create",
      },
    }));
  });

  it("omits version and idempotency headers on status and rejects document expired", async () => {
    request.mockResolvedValueOnce(json({ job: { id: "doc-1", status: "expired" } }));
    await expect(client.documents.status("doc-1")).rejects.toMatchObject({ code: "malformed_response" });
    expect(request.mock.calls[0][0].headers).toEqual({
      "x-systemsculpt-contract": "managed-capabilities-v2",
      "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL,
      "x-systemsculpt-capability": "document_processing",
    });
  });

  it("keeps signed image upload values call-local and rejects unsupported image resume/cancel", async () => {
    request.mockResolvedValueOnce(json({ contract: MANAGED_JOB_PROTOCOL, upload_id: "up-1", expires_at: "2099-01-01T00:00:00Z", input_uploads: [{ index: 0, upload: { method: "PUT", url: "https://signed.test/x", headers: { secret: "x" }, expires_in_seconds: 900, expires_at: "2099-01-01T00:00:00Z" }, input_image: { type: "uploaded", key: "key", mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) } }] }));
    const prepared = await client.images.prepareInputs([{ mime_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) }], async (upload) => {
      expect(upload.url).toBe("https://signed.test/x");
    });
    expect(JSON.stringify(prepared)).not.toContain("signed.test");
    await expect(client.images.resume("job")).rejects.toMatchObject({ code: "unsupported_operation" });
    await expect(client.images.cancel("job")).rejects.toMatchObject({ code: "unsupported_operation" });
  });

  it.each([400, 401, 402, 403, 426, 429, 502, 503])("surfaces bounded public transport errors for %s", async (status) => {
    request.mockResolvedValueOnce(new Response("x".repeat(4000), { status, headers: { "x-request-id": "req-err" } }));
    await expect(client.transcription.status("job-1")).rejects.toMatchObject({ code: "managed_job_error", status, requestId: "req-err" });
  });
});
