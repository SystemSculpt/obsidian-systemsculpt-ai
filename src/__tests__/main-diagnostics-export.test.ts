/** @jest-environment jsdom */

import { App } from "obsidian";

import SystemSculptPlugin from "../main";

function makePlugin(): SystemSculptPlugin {
  return new SystemSculptPlugin(new App(), {
    id: "systemsculpt-ai",
    version: "6.3.1",
  } as any);
}

describe("SystemSculptPlugin diagnostics export", () => {
  afterEach(() => jest.restoreAllMocks());

  it("gives same-second exports distinct cryptographically shaped paths", async () => {
    const plugin = makePlugin();
    const snapshot = JSON.stringify({ schema_version: 1 });
    jest.spyOn(plugin, "buildDiagnosticsSnapshot").mockReturnValue(snapshot);
    jest.spyOn(plugin as any, "formatDiagnosticsFileTimestamp")
      .mockReturnValue("20260810-140000");
    jest.spyOn(plugin as any, "createDiagnosticsFileNonce")
      .mockReturnValueOnce("a".repeat(32))
      .mockReturnValueOnce("b".repeat(32));
    const writeFile = jest.fn(async (_type: string, fileName: string) => ({
      success: true,
      path: `.systemsculpt/diagnostics/${fileName}`,
    }));
    plugin.storage = { writeFile } as any;

    const first = await plugin.exportDiagnosticsSnapshot();
    const second = await plugin.exportDiagnosticsSnapshot();

    expect(writeFile.mock.calls.map(([, fileName]) => fileName)).toEqual([
      `diagnostics-20260810-140000-${"a".repeat(32)}.txt`,
      `diagnostics-20260810-140000-${"b".repeat(32)}.txt`,
    ]);
    expect(first.path).not.toBe(second.path);
    expect(first.text).toBe(snapshot);
    expect(second.text).toBe(snapshot);
  });

  it("fails before writing when the secure filename nonce is malformed", async () => {
    const plugin = makePlugin();
    jest.spyOn(plugin, "buildDiagnosticsSnapshot").mockReturnValue("{}");
    jest.spyOn(plugin as any, "createDiagnosticsFileNonce")
      .mockReturnValue("not-a-secure-nonce");
    const writeFile = jest.fn();
    plugin.storage = { writeFile } as any;

    await expect(plugin.exportDiagnosticsSnapshot())
      .rejects.toThrow(/identifier is invalid/);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
