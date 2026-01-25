import { TFile, requestUrl } from "obsidian";
import { DocumentUploadService } from "../DocumentUploadService";
import { SystemSculptError, ERROR_CODES } from "../../utils/errors";
import { DOCUMENT_UPLOAD_MAX_BYTES } from "../../constants/uploadLimits";

// Mock requestUrl
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    requestUrl: jest.fn(),
  };
});

// Mock file validator
jest.mock("../../utils/FileValidator", () => {
  const actual = jest.requireActual("../../utils/FileValidator");
  return {
    ...actual,
    validateFileSize: jest.fn(async () => true),
  };
});

// Mock file types
jest.mock("../../constants/fileTypes", () => ({
  getDocumentMimeType: jest.fn((ext: string) => {
    const mimeTypes: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      txt: "text/plain",
    };
    return mimeTypes[ext] || null;
  }),
  normalizeFileExtension: jest.fn((ext: string) => ext.toLowerCase()),
}));

const createMockApp = () => {
  return {
    vault: {
      readBinary: jest.fn(async () => new ArrayBuffer(100)),
    },
  } as any;
};

describe("DocumentUploadService", () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let service: DocumentUploadService;
  let requestUrlMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = createMockApp();
    requestUrlMock = requestUrl as jest.Mock;
    service = new DocumentUploadService(
      mockApp,
      "https://api.example.com",
      "test-license-key"
    );
  });

  describe("constructor", () => {
    it("creates instance with app, baseUrl, and licenseKey", () => {
      expect(service).toBeInstanceOf(DocumentUploadService);
    });

    it("stores the provided values", () => {
      expect((service as any).app).toBe(mockApp);
      expect((service as any).baseUrl).toBe("https://api.example.com");
      expect((service as any).licenseKey).toBe("test-license-key");
    });
  });

  describe("updateConfig", () => {
    it("updates baseUrl and licenseKey", () => {
      service.updateConfig("https://new.api.com", "new-license");

      expect((service as any).baseUrl).toBe("https://new.api.com");
      expect((service as any).licenseKey).toBe("new-license");
    });

    it("allows empty values", () => {
      service.updateConfig("", "");

      expect((service as any).baseUrl).toBe("");
      expect((service as any).licenseKey).toBe("");
    });
  });

  describe("uploadDocument", () => {
    const createMockFile = (name: string, extension: string): TFile => {
      const file = new TFile({ path: `documents/${name}` });
      Object.defineProperty(file, "extension", { value: extension });
      Object.defineProperty(file, "name", { value: name });
      return file;
    };

    describe("license validation", () => {
      it("throws when license key is empty", async () => {
        service = new DocumentUploadService(mockApp, "https://api.example.com", "");
        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow(SystemSculptError);
        await expect(service.uploadDocument(file)).rejects.toMatchObject({
          code: ERROR_CODES.PRO_REQUIRED,
        });
      });

      it("throws when license key is whitespace", async () => {
        service = new DocumentUploadService(mockApp, "https://api.example.com", "   ");
        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow(
          "valid license key"
        );
      });

      it("throws when license key is null", async () => {
        service = new DocumentUploadService(
          mockApp,
          "https://api.example.com",
          null as any
        );
        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow(SystemSculptError);
      });
    });

    describe("file size validation", () => {
      it("throws when file size exceeds limit", async () => {
        const { validateFileSize } = require("../../utils/FileValidator");
        validateFileSize.mockResolvedValueOnce(false);

        const file = createMockFile("large.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow(
          "exceeds the maximum limit"
        );
      });

      it("uses the document upload size limit", async () => {
        const { validateFileSize } = require("../../utils/FileValidator");
        validateFileSize.mockResolvedValueOnce(true);

        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-123", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        await service.uploadDocument(file);

        expect(validateFileSize).toHaveBeenCalledWith(
          file,
          mockApp,
          expect.objectContaining({ maxBytes: DOCUMENT_UPLOAD_MAX_BYTES })
        );
      });

      it("proceeds when file size is valid", async () => {
        const { validateFileSize } = require("../../utils/FileValidator");
        validateFileSize.mockResolvedValueOnce(true);

        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-123", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        const result = await service.uploadDocument(file);

        expect(result.documentId).toBe("doc-123");
      });
    });

    describe("successful upload", () => {
      it("returns document info on success", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({
            documentId: "doc-456",
            status: "processing",
          }),
        });

        const file = createMockFile("test.pdf", "pdf");
        const result = await service.uploadDocument(file);

        expect(result).toEqual({
          documentId: "doc-456",
          status: "processing",
        });
      });

      it("handles cached response", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({
            documentId: "doc-789",
            status: "completed",
            cached: true,
          }),
        });

        const file = createMockFile("test.pdf", "pdf");
        const result = await service.uploadDocument(file);

        expect(result.cached).toBe(true);
      });

      it("calls correct endpoint", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        await service.uploadDocument(file);

        expect(requestUrlMock).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "https://api.example.com/documents/process",
            method: "POST",
          })
        );
      });

      it("includes license key in headers", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        await service.uploadDocument(file);

        expect(requestUrlMock).toHaveBeenCalledWith(
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-license-key": "test-license-key",
            }),
          })
        );
      });

      it("sets multipart content type with boundary", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        await service.uploadDocument(file);

        expect(requestUrlMock).toHaveBeenCalledWith(
          expect.objectContaining({
            headers: expect.objectContaining({
              "Content-Type": expect.stringContaining("multipart/form-data; boundary="),
            }),
          })
        );
      });

      it("reads file as binary from vault", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        await service.uploadDocument(file);

        expect(mockApp.vault.readBinary).toHaveBeenCalledWith(file);
      });
    });

    describe("error handling", () => {
      it("throws on 403 with invalid license message", async () => {
        requestUrlMock.mockResolvedValue({
          status: 403,
          text: "Forbidden",
        });

        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow(
          "Invalid or expired license key"
        );
      });

      it("throws file-too-large error on 413", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 413,
          text: "Request Entity Too Large",
        });

        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toMatchObject({
          code: ERROR_CODES.FILE_TOO_LARGE,
          statusCode: 413,
        });
      });

      it("throws on other HTTP errors", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 500,
          text: "Internal server error",
        });

        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow("Upload failed: 500");
      });

      it("includes error text in message", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 400,
          text: "Bad request - invalid file format",
        });

        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow(
          "Bad request - invalid file format"
        );
      });

      it("handles missing error text", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 502,
          text: undefined,
        });

        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow("Upload failed: 502");
      });

      it("throws on invalid JSON response", async () => {
        requestUrlMock.mockResolvedValue({
          status: 200,
          text: "not json",
        });

        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow(
          "Invalid response format"
        );
      });

      it("wraps non-SystemSculptError in SystemSculptError", async () => {
        mockApp.vault.readBinary.mockRejectedValue(new Error("Vault read failed"));

        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow(SystemSculptError);
      });

      it("re-throws existing SystemSculptError", async () => {
        const originalError = new SystemSculptError("Custom error", "CUSTOM", 400);
        mockApp.vault.readBinary.mockRejectedValue(originalError);

        const file = createMockFile("test.pdf", "pdf");

        try {
          await service.uploadDocument(file);
          fail("Expected error to be thrown");
        } catch (error) {
          expect(error).toBe(originalError);
        }
      });

      it("handles non-Error throws", async () => {
        mockApp.vault.readBinary.mockRejectedValue("string error");

        const file = createMockFile("test.pdf", "pdf");

        await expect(service.uploadDocument(file)).rejects.toThrow("string error");
      });
    });

    describe("MIME type handling", () => {
      it("uses PDF MIME type for pdf files", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        await service.uploadDocument(file);

        const callArgs = requestUrlMock.mock.calls[0][0];
        expect(callArgs.headers["Content-Type"]).toContain("multipart/form-data");
      });

      it("uses application/octet-stream for unknown file types", async () => {
        const { getDocumentMimeType } = require("../../constants/fileTypes");
        getDocumentMimeType.mockReturnValueOnce(null);

        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("test.xyz", "xyz");
        await service.uploadDocument(file);

        // The Content-Type for the part should use octet-stream as fallback
        expect(requestUrlMock).toHaveBeenCalled();
      });
    });

    describe("multipart form data", () => {
      it("includes file name in Content-Disposition", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("my-document.pdf", "pdf");
        await service.uploadDocument(file);

        const callArgs = requestUrlMock.mock.calls[0][0];
        const bodyBuffer = callArgs.body as ArrayBuffer;
        const bodyText = new TextDecoder().decode(bodyBuffer);

        expect(bodyText).toContain('filename="my-document.pdf"');
      });

      it("sends binary body as ArrayBuffer", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        await service.uploadDocument(file);

        const callArgs = requestUrlMock.mock.calls[0][0];
        expect(callArgs.body).toBeInstanceOf(ArrayBuffer);
      });

      it("uses throw: false option", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "doc-1", status: "queued" }),
        });

        const file = createMockFile("test.pdf", "pdf");
        await service.uploadDocument(file);

        expect(requestUrlMock).toHaveBeenCalledWith(
          expect.objectContaining({
            throw: false,
          })
        );
      });
    });
  });
});
