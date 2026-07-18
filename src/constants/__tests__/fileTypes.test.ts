/**
 * @jest-environment node
 */
import {
  AUDIO_FILE_EXTENSIONS,
  MANAGED_DOCUMENT_CONVERSION_EXTENSIONS,
  MANAGED_DOCUMENT_MIME_TYPE_MAP,
  normalizeFileExtension,
  isAudioFileExtension,
  isAutoDocumentConversionFileExtension,
  isManagedDocumentConversionFileExtension,
  getManagedDocumentMimeType,
} from "../fileTypes";

describe("managed document file types", () => {
  it("matches the immutable managed create contract exactly", () => {
    expect([...MANAGED_DOCUMENT_CONVERSION_EXTENSIONS]).toEqual(["pdf", "png", "jpg", "jpeg", "webp"]);
    expect(MANAGED_DOCUMENT_MIME_TYPE_MAP).toEqual({
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
    });
  });

  it.each(["pdf", "png", "jpg", "jpeg", "webp", " PDF "])("allows explicit managed conversion for %s", (extension) => {
    expect(isManagedDocumentConversionFileExtension(extension)).toBe(true);
  });

  it.each(["doc", "docx", "ppt", "pptx", "xls", "xlsx", "svg", "mp3", ""])("does not advertise unsupported managed conversion for %s", (extension) => {
    expect(isManagedDocumentConversionFileExtension(extension)).toBe(false);
  });

  it("auto-converts only PDF when adding a file to Chat context", () => {
    expect(isAutoDocumentConversionFileExtension("pdf")).toBe(true);
    for (const extension of ["png", "jpg", "jpeg", "webp", "docx"]) {
      expect(isAutoDocumentConversionFileExtension(extension)).toBe(false);
    }
  });

  it("returns only managed-contract MIME types", () => {
    expect(getManagedDocumentMimeType("PDF")).toBe("application/pdf");
    expect(getManagedDocumentMimeType("jpg")).toBe("image/jpeg");
    expect(getManagedDocumentMimeType("webp")).toBe("image/webp");
    expect(getManagedDocumentMimeType("docx")).toBeUndefined();
  });
});

describe("shared extension helpers", () => {
  it("normalizes case, whitespace, null, and undefined", () => {
    expect(normalizeFileExtension(" PDF ")).toBe("pdf");
    expect(normalizeFileExtension(null)).toBe("");
    expect(normalizeFileExtension(undefined)).toBe("");
  });

  it("keeps the managed transcription extension set centralized", () => {
    expect([...AUDIO_FILE_EXTENSIONS]).toEqual(["mp3", "wav", "m4a", "mp4", "ogg", "webm", "flac"]);
    expect(isAudioFileExtension(" WAV ")).toBe(true);
    expect(isAudioFileExtension("FLAC")).toBe(true);
    expect(isAudioFileExtension("aac")).toBe(false);
    expect(isAudioFileExtension("opus")).toBe(false);
    expect(isAudioFileExtension("pdf")).toBe(false);
  });
});
