import { App, TFile } from "obsidian";
import { isFatalManagedEmbeddingsCode } from "../ManagedEmbeddingsFailurePolicy";
import { ManagedEmbeddingsError, type ManagedEmbeddingsErrorCode } from "../gateway/ManagedEmbeddingsIndexAdapter";
import { EmbeddingsProcessor } from "../processing/EmbeddingsProcessor";

jest.mock("../../../utils/errorLogger", () => ({ errorLogger: { warn: jest.fn() } }));

function processorFailure(code: ManagedEmbeddingsErrorCode) {
  const app = new App();
  app.vault.read = jest.fn(async () => "# Note");
  const index = jest.fn().mockRejectedValue(new ManagedEmbeddingsError(code, "Indexing failed.", 402));
  const storage = { publishPath: jest.fn(), replacePath: jest.fn() };
  const processor = new EmbeddingsProcessor({ index }, storage);
  const files = ["A.md", "B.md"].map(path => new TFile({ path, stat: { mtime: 1, size: 6 } }));
  return { app, index, processor, files };
}

describe("fatal managed embeddings indexing policy", () => {
  it.each([
    "payment_required", "license_required", "license_rejected", "version_unsupported", "capability_unavailable",
  ])("suspends indexing for %s", code => {
    expect(isFatalManagedEmbeddingsCode(code)).toBe(true);
  });

  it.each([
    "payment_required", "license_required", "license_rejected", "version_unsupported", "capability_unavailable",
  ] as const)("stops worker admission after a live %s failure", async code => {
    const { app, index, processor, files } = processorFailure(code);
    const result = await processor.processFiles(files, app, undefined, { concurrency: 1 });
    expect(result).toMatchObject({ failed: 1, failedPaths: ["A.md"], fatalError: { code }, cancelled: false });
    expect(index).toHaveBeenCalledTimes(1);
    expect(app.vault.read).toHaveBeenCalledTimes(1);
  });

  it.each(["rate_limited", "temporarily_unavailable", "local_preparation_failed"] as const)("keeps nonfatal %s failures local to each file", async code => {
    const { app, index, processor, files } = processorFailure(code);
    const result = await processor.processFiles(files, app, undefined, { concurrency: 1 });
    expect(result).toMatchObject({ failed: 2, failedPaths: ["A.md", "B.md"], fatalError: null, cancelled: false });
    expect(index).toHaveBeenCalledTimes(2);
  });

  it("keeps cancellation distinct from fatal suspension and file failure", async () => {
    const { app, index, processor, files } = processorFailure("request_cancelled");
    const result = await processor.processFiles(files, app, undefined, { concurrency: 1 });
    expect(result).toMatchObject({ failed: 0, fatalError: null, cancelled: true });
    expect(index).toHaveBeenCalledTimes(1);
  });

  it.each([
    "invalid_request", "rate_limited", "temporarily_unavailable", "operation_in_progress", "settlement_pending",
    "idempotency_conflict", "invalid_response", "local_preparation_failed", "request_cancelled", "unknown",
    "", null, undefined, 402, {},
  ])("does not suspend indexing for %p", code => {
    expect(isFatalManagedEmbeddingsCode(code)).toBe(false);
  });
});
