import { requestUrl } from "obsidian";
import { SystemSculptImageGenerationService } from "../SystemSculptImageGenerationService";

const requestUrlMock = requestUrl as unknown as jest.Mock;

describe("SystemSculptImageGenerationService", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("fetch disabled in test"));
  });

  it("lists available image models", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        contract: "systemsculpt-image-v1",
        provider: "openrouter",
        models: [
          {
            id: "openai/gpt-5-image-mini",
            name: "OpenAI GPT-5 Image Mini",
            provider: "openrouter",
            supports_image_input: true,
          },
        ],
      },
      headers: { "content-type": "application/json" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const response = await service.listModels();
    expect(response.contract).toBe("systemsculpt-image-v1");
    expect(response.models[0]?.id).toBe("openai/gpt-5-image-mini");

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(String(call?.url || "")).toContain("/images/models");
    expect(call?.headers?.["x-license-key"]).toBe("license_test");
  });

  it("creates a generation job", async () => {
    requestUrlMock.mockResolvedValue({
      status: 202,
      json: {
        job: {
          id: "job_123",
          status: "queued",
          model: "openai/gpt-5-image-mini",
          created_at: "2026-02-16T00:00:00.000Z",
        },
        poll_url: "/api/v1/images/generations/jobs/job_123",
      },
      headers: { "content-type": "application/json" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const response = await service.createGenerationJob({
      model: "openai/gpt-5-image-mini",
      prompt: "A tiny robot",
      input_images: [],
      options: {
        count: 1,
        aspect_ratio: "1:1",
      },
    });

    expect(response.job.id).toBe("job_123");

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(String(call?.url || "")).toContain("/images/generations/jobs");
    expect(call?.method).toBe("POST");
    expect(String(call?.body || "")).toContain("A tiny robot");
  });

  it("falls back to requestUrl only for transport failures", async () => {
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        contract: "systemsculpt-image-v1",
        provider: "openrouter",
        models: [
          {
            id: "openai/gpt-5-image-mini",
            name: "OpenAI GPT-5 Image Mini",
            provider: "openrouter",
            supports_image_input: true,
          },
        ],
      },
      headers: { "content-type": "application/json" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const response = await service.listModels();
    expect(response.models[0]?.id).toBe("openai/gpt-5-image-mini");
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to requestUrl on fetch HTTP errors", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Provider unavailable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })
    );

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    await expect(service.listModels()).rejects.toThrow("Provider unavailable");
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("uses poll_url for status checks and parses poll_after_ms hints", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        job: {
          id: "job_123",
          status: "processing",
          model: "openai/gpt-5-image-mini",
          created_at: "2026-02-16T00:00:00.000Z",
        },
        outputs: [],
        poll_after_ms: 1350,
      },
      headers: { "content-type": "application/json" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const result = await service.getGenerationJob("job_123", {
      pollUrl: "https://edge.systemsculpt.com/api/v1/images/generations/jobs/job_123",
    });
    expect(result.poll_after_ms).toBe(1350);
    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(String(call?.url || "")).toBe("https://edge.systemsculpt.com/api/v1/images/generations/jobs/job_123");
    expect(call?.headers?.["x-license-key"]).toBeUndefined();
  });

  it("does not duplicate /api/v1 when poll_url already includes versioned API path", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        job: {
          id: "job_123",
          status: "processing",
          model: "openai/gpt-5-image-mini",
          created_at: "2026-02-16T00:00:00.000Z",
        },
        outputs: [],
      },
      headers: { "content-type": "application/json" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    await service.getGenerationJob("job_123", {
      pollUrl: "/api/v1/images/generations/jobs/job_123",
    });

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(String(call?.url || "")).toBe("https://api.systemsculpt.com/api/v1/images/generations/jobs/job_123");
  });

  it("waits for job completion and returns outputs", async () => {
    requestUrlMock
      .mockResolvedValueOnce({
        status: 200,
        json: {
          job: {
            id: "job_123",
            status: "queued",
            model: "openai/gpt-5-image-mini",
            created_at: "2026-02-16T00:00:00.000Z",
          },
          outputs: [],
        },
        headers: { "content-type": "application/json" },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          job: {
            id: "job_123",
            status: "succeeded",
            model: "openai/gpt-5-image-mini",
            created_at: "2026-02-16T00:00:00.000Z",
          },
          outputs: [
            {
              index: 0,
              mime_type: "image/png",
              size_bytes: 1024,
              width: 1024,
              height: 1024,
              url: "https://example.com/image.png",
              url_expires_in_seconds: 1800,
            },
          ],
        },
        headers: { "content-type": "application/json" },
      });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const result = await service.waitForGenerationJob("job_123", { pollIntervalMs: 1 });
    expect(result.job.status).toBe("succeeded");
    expect(result.outputs[0]?.url).toBe("https://example.com/image.png");
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
  });

  it("passes pollUrl through waitForGenerationJob polling", async () => {
    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const getJobSpy = jest
      .spyOn(service, "getGenerationJob")
      .mockResolvedValueOnce({
        job: {
          id: "job_123",
          status: "queued",
          model: "openai/gpt-5-image-mini",
          created_at: "2026-02-16T00:00:00.000Z",
        },
        outputs: [],
        poll_after_ms: 1,
      })
      .mockResolvedValueOnce({
        job: {
          id: "job_123",
          status: "succeeded",
          model: "openai/gpt-5-image-mini",
          created_at: "2026-02-16T00:00:00.000Z",
        },
        outputs: [],
      });

    await service.waitForGenerationJob("job_123", {
      pollIntervalMs: 1,
      maxPollIntervalMs: 2,
      initialPollDelayMs: 1,
      pollUrl: "/api/v1/images/generations/jobs/job_123",
    });

    expect(getJobSpy).toHaveBeenCalledTimes(2);
    expect(getJobSpy).toHaveBeenNthCalledWith(1, "job_123", { pollUrl: "/api/v1/images/generations/jobs/job_123" });
    expect(getJobSpy).toHaveBeenNthCalledWith(2, "job_123", { pollUrl: "/api/v1/images/generations/jobs/job_123" });
  });

  it("blocks untrusted cross-origin output URLs", async () => {
    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    await expect(
      service.downloadImage("https://cdn.example.com/generated/image.png")
    ).rejects.toThrow("Image download blocked");
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("allows trusted signed cross-origin output URLs without license headers", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
      headers: { "content-type": "image/png" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const result = await service.downloadImage(
      "https://cdn.systemsculpt.com/generated/image.png?signature=abc123"
    );
    expect(result.arrayBuffer).toBeInstanceOf(ArrayBuffer);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call?.headers?.["x-license-key"]).toBeUndefined();
  });

  it("allows signed Cloudflare R2 output URLs", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      arrayBuffer: new Uint8Array([4, 5, 6]).buffer,
      headers: { "content-type": "image/png" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const result = await service.downloadImage(
      "https://systemsculpt-assets.f7fef583e37a84651a069a44fedc24e2.r2.cloudflarestorage.com/generated/image-generations/job/outputs/output-0000.png?X-Amz-Signature=abc123&X-Amz-Algorithm=AWS4-HMAC-SHA256"
    );
    expect(result.arrayBuffer).toBeInstanceOf(ArrayBuffer);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call?.headers?.["x-license-key"]).toBeUndefined();
  });

  it("sends license headers when downloading same-origin output URLs", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      arrayBuffer: new Uint8Array([9, 8, 7]).buffer,
      headers: { "content-type": "image/png" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const result = await service.downloadImage("https://api.systemsculpt.com/files/generated/image.png");
    expect(result.arrayBuffer).toBeInstanceOf(ArrayBuffer);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call?.headers?.["x-license-key"]).toBe("license_test");
  });

  it("times out polling when a job never reaches a terminal state", async () => {
    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    jest.spyOn(service, "getGenerationJob").mockResolvedValue({
      job: {
        id: "job_123",
        status: "queued",
        model: "openai/gpt-5-image-mini",
        created_at: "2026-02-16T00:00:00.000Z",
      },
      outputs: [],
    });

    await expect(
      service.waitForGenerationJob("job_123", { pollIntervalMs: 1, maxPollIntervalMs: 2, maxWaitMs: 25 })
    ).rejects.toThrow("timed out");
  });

  it("fails after repeated polling request errors", async () => {
    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    jest.spyOn(service, "getGenerationJob").mockRejectedValue(new Error("network down"));

    await expect(
      service.waitForGenerationJob("job_123", { pollIntervalMs: 1, maxPollIntervalMs: 2, maxWaitMs: 100 })
    ).rejects.toThrow("polling failed");
  });
});
