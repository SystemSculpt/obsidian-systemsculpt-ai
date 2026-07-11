import { DEFAULT_SETTINGS } from "../../../types";
import { SettingsManager } from "../SettingsManager";

function pluginWith(loadDataResult: unknown) {
  return {
    loadData: jest.fn().mockResolvedValue(loadDataResult), saveData: jest.fn().mockResolvedValue(undefined),
    app: { vault: { adapter: { exists: jest.fn().mockResolvedValue(false), read: jest.fn(), list: jest.fn().mockResolvedValue({ files: [], folders: [] }), write: jest.fn() }, createFolder: jest.fn() }, workspace: { trigger: jest.fn() } },
  } as any;
}

async function load(value: unknown) {
  const plugin = pluginWith(value);
  const manager = new SettingsManager(plugin);
  (manager as any).automaticBackupService.start = jest.fn();
  await manager.loadSettings();
  return { plugin, manager };
}

describe("managed disclosure settings", () => {
  it("defaults to null and normalizes legacy missing/malformed values", async () => {
    expect(DEFAULT_SETTINGS.managedDisclosureAcceptance).toBeNull();
    for (const value of [undefined, {}, { version: "", acceptedAt: "x" }, { version: "v", acceptedAt: " " }, "v"]) {
      const raw = value === undefined ? {} : { managedDisclosureAcceptance: value };
      expect((await load(raw)).manager.getSettings().managedDisclosureAcceptance).toBeNull();
    }
  });

  it("round-trips exact valid values and persists updates through saveData", async () => {
    const acceptance = { version: "disclosure-v2", acceptedAt: "2026-07-11T12:00:00.000Z" };
    const { plugin, manager } = await load({ managedDisclosureAcceptance: acceptance });
    expect(manager.getSettings().managedDisclosureAcceptance).toEqual(acceptance);
    const next = { version: "disclosure-v3", acceptedAt: "later" };
    await manager.updateSettings({ managedDisclosureAcceptance: next });
    expect(plugin.saveData).toHaveBeenLastCalledWith(expect.objectContaining({ managedDisclosureAcceptance: next }));
  });
});
