/** @jest-environment jsdom */

import { Component, Notice, TFile } from "obsidian";
import { ManagedJobError } from "../../services/managed/ManagedJobClient";
import { describeDocumentProcessingFailure, launchDocumentProcessingPanel } from "../DocumentProcessingPanel";
import { tryCopyToClipboard } from "../../utils/clipboard";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));
jest.mock("../../utils/clipboard", () => ({ tryCopyToClipboard: jest.fn(async () => true) }));

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
    const plugin = Object.assign(new Component(), { openCreditsBalanceModal: jest.fn(async () => undefined) });
    plugin.load();
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

  it("tells the caller whether it showed the failure, so a hidden panel's failure is still said once", () => {
    const shown = launch();
    expect(shown.panel.markFailure({ error: { code: "document_processing_failed" }, file: shown.file })).toBe(true);
    document.body.empty();

    const hidden = launch();
    document.querySelector<HTMLButtonElement>('[data-testid="document.progress.hide"]')!.click();
    expect(hidden.panel.markFailure({ error: { code: "document_processing_failed" }, file: hidden.file })).toBe(false);
    document.body.empty();

    // The header's own dismiss hides the panel the same way.
    const dismissed = launch();
    document.querySelector<HTMLButtonElement>(".systemsculpt-progress-dismiss")!.click();
    expect(dismissed.panel.markFailure({ error: { code: "document_processing_failed" }, file: dismissed.file })).toBe(false);
  });

  describe("unload registration", () => {
    const registeredRuns = (plugin: Component): number =>
      (plugin as unknown as { children: unknown[] }).children.length;

    it("closes a running conversion's panel when the plugin unloads", () => {
      const { plugin } = launch();
      expect(registeredRuns(plugin)).toBe(1);

      plugin.unload();

      expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
    });

    it.each([
      ["Hide", () => document.querySelector<HTMLButtonElement>('[data-testid="document.progress.hide"]')!.click()],
      ["the header dismiss", () => document.querySelector<HTMLButtonElement>(".systemsculpt-progress-dismiss")!.click()],
    ])("releases a conversion hidden with %s", (_label, hide) => {
      const { plugin } = launch();

      hide();

      expect(registeredRuns(plugin)).toBe(0);
    });

    it("releases a finished conversion when its success panel closes itself", () => {
      jest.useFakeTimers();
      try {
        const { panel, plugin, file } = launch();
        panel.markSuccess({ extractionPath: "Docs/report.md", durationMs: 1200, file, openOutput: jest.fn() });
        expect(registeredRuns(plugin)).toBe(1);

        jest.advanceTimersByTime(6000);

        expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
        expect(registeredRuns(plugin)).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it("releases a failed conversion when the user closes it", () => {
      const { panel, plugin, file } = launch();
      panel.markFailure({ error: { code: "document_processing_failed" }, file });

      document.querySelector<HTMLButtonElement>('[data-testid="document.progress.close"]')!.click();

      expect(registeredRuns(plugin)).toBe(0);
    });
  });

  it.each([
    [true, "Copied"],
    [false, "Couldn't copy"],
  ])("shows a copy result (%s) on the Copy error button and keeps the failure open", async (copied, label) => {
    jest.mocked(tryCopyToClipboard).mockResolvedValueOnce(copied);
    const { panel, file } = launch();
    panel.markFailure({ error: { code: "local_output_conflict" }, file });
    const copy = document.querySelector<HTMLButtonElement>('[data-testid="document.progress.copy-error"]')!;

    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(tryCopyToClipboard).toHaveBeenCalledWith("Existing output conflicts with this conversion.", expect.any(HTMLElement));
    expect(copy.textContent).toContain(label);
    expect(document.body.textContent).toContain("Existing output conflicts with this conversion.");
    expect(Notice).not.toHaveBeenCalled();
  });
});
