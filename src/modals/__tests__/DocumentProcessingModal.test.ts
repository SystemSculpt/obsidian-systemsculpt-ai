import { describeDocumentProcessingFailure } from "../DocumentProcessingModal";

describe("document processing typed outcomes", () => {
  it.each([
    ["license_required", "active SystemSculpt Pro license"],
    ["document_processing_failed", "could not be converted"],
    ["malformed_response", "invalid response"],
    ["blocked_ambiguous", "could not be verified"],
    ["local_staging_corrupt", "could not be verified"],
    ["local_output_conflict", "conflicts"],
    ["ephemeral_download_failed", "could not be downloaded"],
    ["cleanup_pending", "cleaned up later"],
    ["local_abort", "cancelled"],
  ])("maps %s without exposing transport or staging details", (code, expected) => {
    const message = describeDocumentProcessingFailure({
      code,
      message: "https://signed.example/private /absolute/plugin/path provider=s3",
    });
    expect(message).toContain(expected);
    expect(message).not.toMatch(/signed\.example|absolute|provider|storage|s3/i);
  });

  it("maps AbortError as local cancellation", () => {
    expect(describeDocumentProcessingFailure(new DOMException("secret", "AbortError"))).toBe("Conversion cancelled.");
  });
});
