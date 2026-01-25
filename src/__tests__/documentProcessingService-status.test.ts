import { DocumentProcessingService } from "../services/DocumentProcessingService";
import type { HttpResponseShim } from "../utils/httpClient";

const service: any = Object.create(DocumentProcessingService.prototype);
const parseStatus = (response: Partial<HttpResponseShim>): any =>
  service.parseDocumentStatusResponse(response as HttpResponseShim);

describe("DocumentProcessingService.parseDocumentStatusResponse", () => {
  it("prefers normalized status in nested payloads", () => {
    const response = {
      status: 200,
      json: {
        status: "processing",
        data: { normalizedStatus: "completed", error: null, progress: 84 },
      },
    } as HttpResponseShim;

    const result = parseStatus(response);

    expect(result.normalizedStatus).toBe("completed");
    expect(result.progress).toBe(84);
  });

  it("falls back to top-level status when normalized is missing", () => {
    const response = {
      status: 200,
      json: { status: "processing" },
    } as HttpResponseShim;

    const result = parseStatus(response);

    expect(result.normalizedStatus).toBe("processing");
  });

  it("bubbles error messages when provided", () => {
    const response = {
      status: 200,
      json: {
        status: "error",
        data: { error: "Quota exceeded" },
      },
    } as HttpResponseShim;

    const result = parseStatus(response);

    expect(result.normalizedStatus).toBe("error");
    expect(result.error).toBe("Quota exceeded");
  });
});

describe("DocumentProcessingService.mapNormalizedStatusToStage", () => {
  it("maps queued status", () => {
    expect(service.mapNormalizedStatusToStage("queued")).toBe("queued");
  });

  it("maps processing-like statuses", () => {
    expect(service.mapNormalizedStatusToStage("extracting")).toBe("processing");
    expect(service.mapNormalizedStatusToStage("processing")).toBe("processing");
  });

  it("maps completion statuses to ready", () => {
    expect(service.mapNormalizedStatusToStage("completed")).toBe("ready");
    expect(service.mapNormalizedStatusToStage("ready")).toBe("ready");
  });

  it("maps failure statuses to error", () => {
    expect(service.mapNormalizedStatusToStage("failed")).toBe("error");
    expect(service.mapNormalizedStatusToStage("error")).toBe("error");
  });
});
