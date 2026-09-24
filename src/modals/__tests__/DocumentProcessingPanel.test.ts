/** @jest-environment jsdom */

import { TFile } from "obsidian";
import { ManagedJobError } from "../../services/managed/ManagedJobClient";
import { describeDocumentProcessingFailure, launchDocumentProcessingPanel } from "../DocumentProcessingPanel";

describe("document processing typed outcomes", () => {
  it.each([
    ["license_required", "active SystemSculpt Pro license"],
    ["payment_required", "Not enough credits"],
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

  it("maps an HTTP 402 or insufficient-credits payload to the credits wording (#300)", () => {
    for (const error of [
      new ManagedJobError("payment_required", "Managed job request failed (402).", 402),
      { code: "insufficient_credits", message: "Insufficient available credits to run this request." },
      { status: 402, message: "Managed job request failed (402)." },
    ]) {
      expect(describeDocumentProcessingFailure(error)).toBe(
        "Not enough credits are available. Add credits to convert documents.",
      );
    }
  });
});

describe("document processing panel failure actions", () => {
  afterEach(() => {
    document.body.empty();
  });

  function launch() {
    const plugin = { register: jest.fn(), openCreditsBalanceModal: jest.fn(async () => undefined) };
    const file = new TFile({ path: "Docs/report.pdf", name: "report.pdf", stat: { size: 2048 } });
    const panel = launchDocumentProcessingPanel({ plugin: plugin as never, file });
    return { panel, plugin, file };
  }

  it("offers Add credits for a 402 conversion failure and opens the credits modal (#300)", () => {
    const { panel, plugin, file } = launch();

    panel.markFailure({ error: new ManagedJobError("payment_required", "Managed job request failed (402).", 402), file });

    expect(document.body.textContent).toContain("Not enough credits are available.");
    expect(document.body.textContent).not.toContain("(402)");
    document.querySelector<HTMLButtonElement>('[data-testid="document.progress.add-credits"]')!.click();
    expect(plugin.openCreditsBalanceModal).toHaveBeenCalledTimes(1);
  });

  it("keeps the ordinary failure actions for non-credit errors", () => {
    const { panel, file } = launch();

    panel.markFailure({ error: { code: "document_processing_failed" }, file });

    expect(document.querySelector('[data-testid="document.progress.add-credits"]')).toBeNull();
    expect(document.querySelector('[data-testid="document.progress.copy-error"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="document.progress.close"]')).not.toBeNull();
  });
});
