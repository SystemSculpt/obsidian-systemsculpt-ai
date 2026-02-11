import { TFile, requestUrl } from "obsidian";
import { AudioUploadService } from "../AudioUploadService";
import { AUDIO_UPLOAD_MAX_BYTES } from "../../constants/uploadLimits";

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

// Mock error handling
jest.mock("../../utils/errorHandling", () => {
  const actual = jest.requireActual("../../utils/errorHandling");
  return {
    ...actual,
    logMobileError: jest.fn(),
  };
});

const createMockApp = () => {
  return {
    vault: {
      readBinary: jest.fn(async () => new ArrayBuffer(100)),
    },
  } as any;
};

describe("AudioUploadService", () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let service: AudioUploadService;
  let requestUrlMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = createMockApp();
    requestUrlMock = requestUrl as jest.Mock;
    service = new AudioUploadService(mockApp, "https://api.example.com", "test-license-key");
  });

  describe("constructor", () => {
    it("creates instance with app and baseUrl", () => {
      expect(service).toBeInstanceOf(AudioUploadService);
    });

    it("stores the provided values", () => {
      expect((service as any).app).toBe(mockApp);
      expect((service as any).baseUrl).toBe("https://api.example.com");
      expect((service as any).licenseKey).toBe("test-license-key");
    });
  });

  describe("updateConfig", () => {
    it("updates base URL and license key", () => {
      service.updateConfig("https://new.api.com", "new-license");

      expect((service as any).baseUrl).toBe("https://new.api.com");
      expect((service as any).licenseKey).toBe("new-license");
    });
  });

  describe("updateBaseUrl", () => {
    it("updates the base URL", () => {
      service.updateBaseUrl("https://new.api.com");

      expect((service as any).baseUrl).toBe("https://new.api.com");
    });

    it("allows empty string", () => {
      service.updateBaseUrl("");

      expect((service as any).baseUrl).toBe("");
    });
  });

  describe("uploadAudio", () => {
    const createMockFile = (name: string): TFile => {
      const file = new TFile({ path: `audio/${name}` });
      Object.defineProperty(file, "name", { value: name });
      Object.defineProperty(file, "stat", { value: { size: 1000 } });
      return file;
    };

    describe("file size validation", () => {
      it("throws when license key is missing", async () => {
        service.updateConfig("https://api.example.com", "");
        const file = createMockFile("test.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow(
          "A valid license key is required for audio transcription uploads"
        );
        expect(requestUrlMock).not.toHaveBeenCalled();
      });

      it("throws when file size exceeds limit", async () => {
        const { validateFileSize } = require("../../utils/FileValidator");
        validateFileSize.mockResolvedValueOnce(false);

        const file = createMockFile("large-audio.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow(
          "maximum upload limit"
        );
      });

      it("uses the audio upload size limit", async () => {
        const { validateFileSize } = require("../../utils/FileValidator");
        validateFileSize.mockResolvedValueOnce(true);

        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-123", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        await service.uploadAudio(file);

        expect(validateFileSize).toHaveBeenCalledWith(
          file,
          mockApp,
          expect.objectContaining({ maxBytes: AUDIO_UPLOAD_MAX_BYTES })
        );
      });

      it("proceeds when file size is valid", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-123", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        const result = await service.uploadAudio(file);

        expect(result.documentId).toBe("audio-123");
      });
    });

    describe("successful upload", () => {
      it("returns transcription info on success", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({
            documentId: "audio-456",
            status: "processing",
          }),
        });

        const file = createMockFile("test.mp3");
        const result = await service.uploadAudio(file);

        expect(result).toEqual({
          documentId: "audio-456",
          status: "processing",
        });
      });

      it("handles cached response", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({
            documentId: "audio-789",
            status: "completed",
            cached: true,
          }),
        });

        const file = createMockFile("test.mp3");
        const result = await service.uploadAudio(file);

        expect(result.cached).toBe(true);
      });

      it("calls correct endpoint", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-1", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        await service.uploadAudio(file);

        expect(requestUrlMock).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "https://api.example.com/audio/transcriptions",
            method: "POST",
          })
        );
      });

      it("sets multipart content type with boundary", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-1", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        await service.uploadAudio(file);

        expect(requestUrlMock).toHaveBeenCalledWith(
          expect.objectContaining({
            headers: expect.objectContaining({
              "Content-Type": expect.stringContaining("multipart/form-data; boundary="),
              "x-license-key": "test-license-key",
            }),
          })
        );
      });

      it("reads file as binary from vault", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-1", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        await service.uploadAudio(file);

        expect(mockApp.vault.readBinary).toHaveBeenCalledWith(file);
      });
    });

    describe("error handling", () => {
      it("throws on HTTP error", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 500,
          text: "Internal server error",
        });

        const file = createMockFile("test.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow(
          "Audio upload failed: 500"
        );
      });

      it("throws on 400 error", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 400,
          text: "Bad request",
        });

        const file = createMockFile("test.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow(
          "Audio upload failed: 400"
        );
      });

      it("throws on 403 error", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 403,
          text: "Forbidden",
        });

        const file = createMockFile("test.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow(
          "Audio upload failed: 403"
        );
      });

      it("treats 413 as file-too-large", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 413,
          text: "Request Entity Too Large",
        });

        const file = createMockFile("test.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow(
          "maximum upload limit"
        );
      });

      it("detects payload-too-large errors even without 413 status", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 500,
          text: "FUNCTION_PAYLOAD_TOO_LARGE",
        });

        const file = createMockFile("test.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow(
          "maximum upload limit"
        );
      });

      it("logs error using logMobileError", async () => {
        const { logMobileError } = require("../../utils/errorHandling");
        requestUrlMock.mockResolvedValueOnce({
          status: 500,
          text: "Server error",
        });

        const file = createMockFile("test.mp3");

        try {
          await service.uploadAudio(file);
        } catch (e) {
          // Expected
        }

        expect(logMobileError).toHaveBeenCalledWith(
          "AudioUploadService",
          "Audio upload failed",
          expect.any(Error),
          expect.objectContaining({
            filename: "test.mp3",
            fileSize: 1000,
            endpoint: "https://api.example.com/audio/transcriptions",
          })
        );
      });

      it("re-throws the error after logging", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 500,
          text: "Server error",
        });

        const file = createMockFile("test.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow();
      });

      it("handles vault read errors", async () => {
        mockApp.vault.readBinary.mockRejectedValueOnce(
          new Error("Vault read failed")
        );

        const file = createMockFile("test.mp3");

        await expect(service.uploadAudio(file)).rejects.toThrow(
          "Vault read failed"
        );
      });
    });

    describe("multipart form data", () => {
      it("includes file name in Content-Disposition", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-1", status: "queued" }),
        });

        const file = createMockFile("my-audio.mp3");
        await service.uploadAudio(file);

        const callArgs = requestUrlMock.mock.calls[0][0];
        const bodyBuffer = callArgs.body as ArrayBuffer;
        const bodyText = new TextDecoder().decode(bodyBuffer);

        expect(bodyText).toContain('filename="my-audio.mp3"');
      });

      it("sends binary body as ArrayBuffer", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-1", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        await service.uploadAudio(file);

        const callArgs = requestUrlMock.mock.calls[0][0];
        expect(callArgs.body).toBeInstanceOf(ArrayBuffer);
      });

      it("uses throw: false option", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-1", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        await service.uploadAudio(file);

        expect(requestUrlMock).toHaveBeenCalledWith(
          expect.objectContaining({
            throw: false,
          })
        );
      });

      it("uses application/octet-stream content type for file", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-1", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        await service.uploadAudio(file);

        const callArgs = requestUrlMock.mock.calls[0][0];
        const bodyBuffer = callArgs.body as ArrayBuffer;
        const bodyText = new TextDecoder().decode(bodyBuffer);

        expect(bodyText).toContain("Content-Type: application/octet-stream");
      });
    });

    describe("different file types", () => {
      it("handles mp3 files", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-1", status: "queued" }),
        });

        const file = createMockFile("test.mp3");
        const result = await service.uploadAudio(file);

        expect(result.documentId).toBe("audio-1");
      });

      it("handles wav files", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-2", status: "queued" }),
        });

        const file = createMockFile("test.wav");
        const result = await service.uploadAudio(file);

        expect(result.documentId).toBe("audio-2");
      });

      it("handles m4a files", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-3", status: "queued" }),
        });

        const file = createMockFile("test.m4a");
        const result = await service.uploadAudio(file);

        expect(result.documentId).toBe("audio-3");
      });

      it("handles ogg files", async () => {
        requestUrlMock.mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ documentId: "audio-4", status: "queued" }),
        });

        const file = createMockFile("test.ogg");
        const result = await service.uploadAudio(file);

        expect(result.documentId).toBe("audio-4");
      });
    });
  });
});
