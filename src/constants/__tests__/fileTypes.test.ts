/**
 * @jest-environment node
 */
import {
  DOCUMENT_FILE_EXTENSIONS,
  AUDIO_FILE_EXTENSIONS,
  DOCUMENT_MIME_TYPE_MAP,
  normalizeFileExtension,
  isDocumentFileExtension,
  isAudioFileExtension,
  getDocumentMimeType,
} from "../fileTypes";

describe("DOCUMENT_FILE_EXTENSIONS", () => {
  it("contains pdf", () => {
    expect(DOCUMENT_FILE_EXTENSIONS.has("pdf")).toBe(true);
  });

  it("contains doc and docx", () => {
    expect(DOCUMENT_FILE_EXTENSIONS.has("doc")).toBe(true);
    expect(DOCUMENT_FILE_EXTENSIONS.has("docx")).toBe(true);
  });

  it("contains ppt and pptx", () => {
    expect(DOCUMENT_FILE_EXTENSIONS.has("ppt")).toBe(true);
    expect(DOCUMENT_FILE_EXTENSIONS.has("pptx")).toBe(true);
  });

  it("contains xls and xlsx", () => {
    expect(DOCUMENT_FILE_EXTENSIONS.has("xls")).toBe(true);
    expect(DOCUMENT_FILE_EXTENSIONS.has("xlsx")).toBe(true);
  });

  it("does not contain audio extensions", () => {
    expect(DOCUMENT_FILE_EXTENSIONS.has("mp3")).toBe(false);
    expect(DOCUMENT_FILE_EXTENSIONS.has("wav")).toBe(false);
  });

  it("does not contain image extensions", () => {
    expect(DOCUMENT_FILE_EXTENSIONS.has("jpg")).toBe(false);
    expect(DOCUMENT_FILE_EXTENSIONS.has("png")).toBe(false);
  });
});

describe("AUDIO_FILE_EXTENSIONS", () => {
  it("contains mp3", () => {
    expect(AUDIO_FILE_EXTENSIONS.has("mp3")).toBe(true);
  });

  it("contains wav", () => {
    expect(AUDIO_FILE_EXTENSIONS.has("wav")).toBe(true);
  });

  it("contains m4a", () => {
    expect(AUDIO_FILE_EXTENSIONS.has("m4a")).toBe(true);
  });

  it("contains ogg", () => {
    expect(AUDIO_FILE_EXTENSIONS.has("ogg")).toBe(true);
  });

  it("contains webm", () => {
    expect(AUDIO_FILE_EXTENSIONS.has("webm")).toBe(true);
  });

  it("does not contain document extensions", () => {
    expect(AUDIO_FILE_EXTENSIONS.has("pdf")).toBe(false);
    expect(AUDIO_FILE_EXTENSIONS.has("docx")).toBe(false);
  });
});

describe("DOCUMENT_MIME_TYPE_MAP", () => {
  it("maps pdf correctly", () => {
    expect(DOCUMENT_MIME_TYPE_MAP.pdf).toBe("application/pdf");
  });

  it("maps doc correctly", () => {
    expect(DOCUMENT_MIME_TYPE_MAP.doc).toBe("application/msword");
  });

  it("maps docx correctly", () => {
    expect(DOCUMENT_MIME_TYPE_MAP.docx).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  it("maps ppt correctly", () => {
    expect(DOCUMENT_MIME_TYPE_MAP.ppt).toBe("application/vnd.ms-powerpoint");
  });

  it("maps pptx correctly", () => {
    expect(DOCUMENT_MIME_TYPE_MAP.pptx).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
  });

  it("maps xls correctly", () => {
    expect(DOCUMENT_MIME_TYPE_MAP.xls).toBe("application/vnd.ms-excel");
  });

  it("maps xlsx correctly", () => {
    expect(DOCUMENT_MIME_TYPE_MAP.xlsx).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });
});

describe("normalizeFileExtension", () => {
  it("converts to lowercase", () => {
    expect(normalizeFileExtension("PDF")).toBe("pdf");
    expect(normalizeFileExtension("DoC")).toBe("doc");
  });

  it("trims whitespace", () => {
    expect(normalizeFileExtension("  pdf  ")).toBe("pdf");
    expect(normalizeFileExtension("\tpdf\n")).toBe("pdf");
  });

  it("handles empty string", () => {
    expect(normalizeFileExtension("")).toBe("");
  });

  it("handles null", () => {
    expect(normalizeFileExtension(null)).toBe("");
  });

  it("handles undefined", () => {
    expect(normalizeFileExtension(undefined)).toBe("");
  });

  it("preserves valid extension", () => {
    expect(normalizeFileExtension("pdf")).toBe("pdf");
    expect(normalizeFileExtension("docx")).toBe("docx");
  });
});

describe("isDocumentFileExtension", () => {
  it("returns true for valid document extensions", () => {
    expect(isDocumentFileExtension("pdf")).toBe(true);
    expect(isDocumentFileExtension("doc")).toBe(true);
    expect(isDocumentFileExtension("docx")).toBe(true);
    expect(isDocumentFileExtension("ppt")).toBe(true);
    expect(isDocumentFileExtension("pptx")).toBe(true);
    expect(isDocumentFileExtension("xls")).toBe(true);
    expect(isDocumentFileExtension("xlsx")).toBe(true);
  });

  it("returns true for uppercase extensions", () => {
    expect(isDocumentFileExtension("PDF")).toBe(true);
    expect(isDocumentFileExtension("DOCX")).toBe(true);
  });

  it("returns true for extensions with whitespace", () => {
    expect(isDocumentFileExtension("  pdf  ")).toBe(true);
  });

  it("returns false for audio extensions", () => {
    expect(isDocumentFileExtension("mp3")).toBe(false);
    expect(isDocumentFileExtension("wav")).toBe(false);
  });

  it("returns false for image extensions", () => {
    expect(isDocumentFileExtension("jpg")).toBe(false);
    expect(isDocumentFileExtension("png")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isDocumentFileExtension("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isDocumentFileExtension(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isDocumentFileExtension(undefined)).toBe(false);
  });

  it("returns false for unknown extension", () => {
    expect(isDocumentFileExtension("xyz")).toBe(false);
  });
});

describe("isAudioFileExtension", () => {
  it("returns true for valid audio extensions", () => {
    expect(isAudioFileExtension("mp3")).toBe(true);
    expect(isAudioFileExtension("wav")).toBe(true);
    expect(isAudioFileExtension("m4a")).toBe(true);
    expect(isAudioFileExtension("ogg")).toBe(true);
    expect(isAudioFileExtension("webm")).toBe(true);
  });

  it("returns true for uppercase extensions", () => {
    expect(isAudioFileExtension("MP3")).toBe(true);
    expect(isAudioFileExtension("WAV")).toBe(true);
  });

  it("returns true for extensions with whitespace", () => {
    expect(isAudioFileExtension("  mp3  ")).toBe(true);
  });

  it("returns false for document extensions", () => {
    expect(isAudioFileExtension("pdf")).toBe(false);
    expect(isAudioFileExtension("docx")).toBe(false);
  });

  it("returns false for image extensions", () => {
    expect(isAudioFileExtension("jpg")).toBe(false);
    expect(isAudioFileExtension("png")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAudioFileExtension("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAudioFileExtension(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAudioFileExtension(undefined)).toBe(false);
  });

  it("returns false for unknown extension", () => {
    expect(isAudioFileExtension("xyz")).toBe(false);
  });
});

describe("getDocumentMimeType", () => {
  it("returns correct MIME type for pdf", () => {
    expect(getDocumentMimeType("pdf")).toBe("application/pdf");
  });

  it("returns correct MIME type for docx", () => {
    expect(getDocumentMimeType("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  it("handles uppercase extension", () => {
    expect(getDocumentMimeType("PDF")).toBe("application/pdf");
  });

  it("handles extension with whitespace", () => {
    expect(getDocumentMimeType("  pdf  ")).toBe("application/pdf");
  });

  it("returns undefined for unknown extension", () => {
    expect(getDocumentMimeType("xyz")).toBeUndefined();
  });

  it("returns undefined for audio extension", () => {
    expect(getDocumentMimeType("mp3")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(getDocumentMimeType("")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(getDocumentMimeType(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(getDocumentMimeType(undefined)).toBeUndefined();
  });
});
