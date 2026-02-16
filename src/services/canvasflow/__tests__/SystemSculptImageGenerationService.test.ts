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

  it("does not send license headers when downloading cross-origin output URLs", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
      headers: { "content-type": "image/png" },
    });

    const service = new SystemSculptImageGenerationService({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_test",
    });

    const result = await service.downloadImage("https://cdn.example.com/generated/image.png");
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
});
