import fs from "fs";
import os from "os";
import path from "path";
import { TFile, requestUrl } from "obsidian";
import { DocumentUploadJobsService } from "../DocumentUploadJobsService";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    requestUrl: jest.fn(),
  };
});

describe("DocumentUploadJobsService", () => {
  let requestUrlMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    requestUrlMock = requestUrl as jest.Mock;
  });

  it("uploads file parts via signed URLs and completes the job", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-docjobs-"));
    const absolutePath = path.join(tmpDir, "paper.pdf");
    const bytes = new TextEncoder().encode("ABCDEFGHIJKL"); // 12 bytes
    fs.writeFileSync(absolutePath, bytes);

    const mockApp = {
      vault: {
        adapter: {
          getFullPath: jest.fn(() => absolutePath),
        },
      },
    } as any;

    const file = new TFile({ path: "papers/paper.pdf" });
    Object.defineProperty(file, "extension", { value: "pdf" });
    Object.defineProperty(file, "name", { value: "paper.pdf" });
    Object.defineProperty(file, "path", { value: "papers/paper.pdf" });
    Object.defineProperty(file, "stat", { value: { size: bytes.byteLength } });

    const partSizeBytes = 5;
    const totalParts = 3;

    requestUrlMock.mockImplementation(async (args: any) => {
      const url: string = args.url;
      const method: string = (args.method || "GET").toUpperCase();

      if (url === "https://api.example.com/documents/jobs" && method === "POST") {
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            documentId: "doc-1",
            status: "uploading",
            upload: { partSizeBytes, totalParts },
          }),
        };
      }

      if (url.includes("/documents/jobs/doc-1/upload/part-url") && method === "GET") {
        const u = new URL(url);
        const partNumber = Number(u.searchParams.get("partNumber"));
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            part: { url: `https://r2.test/part-${partNumber}` },
          }),
        };
      }

      if (url.startsWith("https://r2.test/part-") && method === "PUT") {
        const partNumber = Number(url.split("-").pop());
        return {
          status: 200,
          headers: { etag: `"etag-${partNumber}"` },
          text: "",
        };
      }

      if (url === "https://api.example.com/documents/jobs/doc-1/upload/complete" && method === "POST") {
        return { status: 200, text: JSON.stringify({ success: true, document: { id: "doc-1", status: "queued" } }) };
      }

      if (url === "https://api.example.com/documents/jobs/doc-1/start" && method === "POST") {
        return { status: 202, text: JSON.stringify({ success: true }) };
      }

      throw new Error(`Unexpected requestUrl call: ${method} ${url}`);
    });

    const service = new DocumentUploadJobsService(
      mockApp,
      "https://api.example.com",
      "test-license-key"
    );

    const result = await service.uploadDocumentViaJobs(file);
    expect(result).toEqual({ documentId: "doc-1", status: "processing" });

    // Verify PUT bodies match original bytes in order (5,5,2)
    const putCalls = requestUrlMock.mock.calls
      .map((c) => c[0])
      .filter((c) => String(c.method).toUpperCase() === "PUT");
    expect(putCalls).toHaveLength(3);

    const body1 = new Uint8Array(putCalls[0].body as ArrayBuffer);
    const body2 = new Uint8Array(putCalls[1].body as ArrayBuffer);
    const body3 = new Uint8Array(putCalls[2].body as ArrayBuffer);

    expect(Array.from(body1)).toEqual(Array.from(bytes.slice(0, 5)));
    expect(Array.from(body2)).toEqual(Array.from(bytes.slice(5, 10)));
    expect(Array.from(body3)).toEqual(Array.from(bytes.slice(10, 12)));
  });
});

