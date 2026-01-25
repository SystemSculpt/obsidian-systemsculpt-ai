import { SettingsManager } from "../SettingsManager";

function createPluginStub(params: { loadDataResult: unknown }) {
  const adapter = {
    exists: jest.fn().mockResolvedValue(false),
    read: jest.fn().mockResolvedValue("{}"),
    list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
    write: jest.fn().mockResolvedValue(undefined),
  };

  const vault = {
    adapter,
    createFolder: jest.fn().mockResolvedValue(undefined),
  };

  const workspace = {
    trigger: jest.fn(),
  };

  return {
    loadData: jest.fn().mockResolvedValue(params.loadDataResult),
    saveData: jest.fn().mockResolvedValue(undefined),
    app: {
      vault,
      workspace,
    },
  } as any;
}

describe("SettingsManager vaultInstanceId migration", () => {
  it("generates vaultInstanceId when plugin data.json is missing", async () => {
    const plugin = createPluginStub({ loadDataResult: null });
    const manager = new SettingsManager(plugin);
    (manager as any).automaticBackupService.start = jest.fn();

    await manager.loadSettings();

    const settings = manager.getSettings();
    expect(typeof settings.vaultInstanceId).toBe("string");
    expect(settings.vaultInstanceId.trim().length).toBeGreaterThan(0);

    const lastSaveArgs = (plugin.saveData as jest.Mock).mock.calls.at(-1);
    expect(lastSaveArgs).toBeTruthy();
    expect(lastSaveArgs?.[0]?.vaultInstanceId?.trim?.().length).toBeGreaterThan(0);
  });

  it("repairs blank vaultInstanceId values loaded from storage", async () => {
    const plugin = createPluginStub({ loadDataResult: { vaultInstanceId: "   " } });
    const manager = new SettingsManager(plugin);
    (manager as any).automaticBackupService.start = jest.fn();

    await manager.loadSettings();

    const settings = manager.getSettings();
    expect(typeof settings.vaultInstanceId).toBe("string");
    expect(settings.vaultInstanceId.trim().length).toBeGreaterThan(0);
  });
});

