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
  it.each([undefined, null, {}, { version: "legacy", acceptedAt: "2026-07-11T12:00:00.000Z" }, "legacy"])(
    "removes legacy disclosure data %p from the current in-memory and persisted settings shape",
    async (value) => {
      const raw = value === undefined ? {} : { schemaVersion: 1, managedDisclosureAcceptance: value };
      const { plugin, manager } = await load(raw);
      expect(manager.getSettings()).not.toHaveProperty("managedDisclosureAcceptance");
      expect(plugin.saveData).toHaveBeenLastCalledWith(expect.not.objectContaining({ managedDisclosureAcceptance: expect.anything() }));
    },
  );

  it("does not make the removed setting writable through the current settings interface", async () => {
    const { manager } = await load({});
    expect("managedDisclosureAcceptance" in manager.getSettings()).toBe(false);
  });
});
