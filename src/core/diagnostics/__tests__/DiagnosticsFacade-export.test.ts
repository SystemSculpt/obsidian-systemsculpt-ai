/** @jest-environment jsdom */

import { DiagnosticsFacade } from "../DiagnosticsFacade";

function makeDiagnostics() {
  const writeFile = jest.fn(async (_type: string, fileName: string, _text: string) => ({
    success: true,
    path: `.systemsculpt/diagnostics/${fileName}`,
  }));
  const diagnostics = new DiagnosticsFacade({
    getStatus: () => ({ safeMode: false, initializationIssueCount: 0, settingsLoaded: true }),
    areDirectoriesReady: () => true,
    getLogger: () => ({ getSupportDiagnostics: () => [] }),
    getResourceMonitor: () => null,
    getStorage: () => ({ writeFile, ensureLocation: async () => undefined, getPath: () => ".systemsculpt/diagnostics" }),
    getPluginVersion: () => "6.3.1",
    getObsidianVersion: () => "1.5.0",
    getAdapter: () => { throw new Error("No folder access needed"); },
  });
  return { diagnostics, writeFile };
}

describe("DiagnosticsFacade diagnostics export", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 7, 10, 14, 0, 0));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("gives same-second exports distinct cryptographically shaped paths", async () => {
    const { diagnostics, writeFile } = makeDiagnostics();
    jest.spyOn(window.crypto, "getRandomValues")
      .mockImplementationOnce((bytes) => { (bytes as Uint8Array).fill(0xaa); return bytes; })
      .mockImplementationOnce((bytes) => { (bytes as Uint8Array).fill(0xbb); return bytes; });

    const first = await diagnostics.exportDiagnosticsSnapshot();
    const second = await diagnostics.exportDiagnosticsSnapshot();

    expect(writeFile.mock.calls.map(([, fileName]) => fileName)).toEqual([
      `diagnostics-20260810-140000-${"a".repeat(32)}.txt`,
      `diagnostics-20260810-140000-${"b".repeat(32)}.txt`,
    ]);
    expect(first.path).not.toBe(second.path);
    expect(JSON.parse(first.text).schema_version).toBe(1);
    expect(second.text).toBe(first.text);
    expect(writeFile.mock.calls.map(([, , text]) => text)).toEqual([first.text, second.text]);
  });

  it("fails before writing when secure randomness is unavailable", async () => {
    const { diagnostics, writeFile } = makeDiagnostics();
    jest.replaceProperty(window, "crypto", {} as Crypto);

    await expect(diagnostics.exportDiagnosticsSnapshot())
      .rejects.toThrow(/identifiers are unavailable/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects a malformed identifier from a corrupted randomness source before writing", async () => {
    const { diagnostics, writeFile } = makeDiagnostics();
    jest.spyOn(window.crypto, "getRandomValues").mockImplementation((bytes) => {
      Object.defineProperty(bytes, Symbol.iterator, { value: () => [0xaa].values() });
      return bytes;
    });

    await expect(diagnostics.exportDiagnosticsSnapshot()).rejects.toThrow(/identifier is invalid/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not fall back to insecure identifiers when the crypto source fails", async () => {
    const { diagnostics, writeFile } = makeDiagnostics();
    jest.spyOn(window.crypto, "getRandomValues").mockImplementation(() => { throw new Error("Randomness unavailable"); });

    await expect(diagnostics.exportDiagnosticsSnapshot()).rejects.toThrow("Randomness unavailable");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("returns the snapshot without a path when persistence fails", async () => {
    const { diagnostics, writeFile } = makeDiagnostics();
    writeFile.mockResolvedValue({ success: false, path: "must-not-be-reported" });

    const exported = await diagnostics.exportDiagnosticsSnapshot();

    expect(JSON.parse(exported.text).schema_version).toBe(1);
    expect(exported.path).toBeUndefined();
  });
});
