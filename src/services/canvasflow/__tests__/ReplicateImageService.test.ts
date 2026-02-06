import { requestUrl } from "obsidian";
import { ReplicateImageService } from "../ReplicateImageService";

const requestUrlMock = requestUrl as unknown as jest.Mock;

describe("ReplicateImageService", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("fetch disabled in test"));
  });

  it("resolves latest version id from model slug", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { latest_version: { id: "ver123" } },
      headers: { "content-type": "application/json" },
    });

    const service = new ReplicateImageService("r8_test");
    const res = await service.resolveLatestVersion("acme/my-model");
    expect(res.latestVersionId).toBe("ver123");
    expect(requestUrlMock).toHaveBeenCalled();
    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(String(call?.url || "")).toContain("/v1/models/acme/my-model");
  });

  it("searches models via /search when available", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        models: [
          {
            model: { owner: "foo", name: "bar", description: "desc", cover_image_url: "https://example.com/cover.png" },
            metadata: { tags: ["text-to-image"] },
          },
        ],
      },
      headers: { "content-type": "application/json" },
    });

    const service = new ReplicateImageService("r8_test");
    const res = await service.searchModels("flux", { limit: 10 });
    expect(res[0]?.slug).toBe("foo/bar");
    expect(res[0]?.tags).toEqual(["text-to-image"]);
  });

  it("falls back to legacy QUERY /models when /search fails", async () => {
    requestUrlMock
      .mockResolvedValueOnce({
        status: 404,
        json: { detail: "Not found" },
        headers: { "content-type": "application/json" },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { results: [{ owner: "x", name: "y", description: "legacy" }] },
        headers: { "content-type": "application/json" },
      });

    const service = new ReplicateImageService("r8_test");
    const res = await service.searchModels("whatever", { limit: 10 });
    expect(res[0]?.slug).toBe("x/y");
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
    const secondCall = requestUrlMock.mock.calls[1]?.[0];
    expect(secondCall?.method).toBe("QUERY");
  });

  it("lists public models with pagination", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        next: "https://api.replicate.com/v1/models?cursor=abc",
        previous: null,
        results: [{ owner: "o", name: "n", description: "d" }],
      },
      headers: { "content-type": "application/json" },
    });

    const service = new ReplicateImageService("r8_test");
    const page = await service.listModelsPage();
    expect(page.results[0]?.slug).toBe("o/n");
    expect(page.next).toContain("cursor=abc");
  });
});
