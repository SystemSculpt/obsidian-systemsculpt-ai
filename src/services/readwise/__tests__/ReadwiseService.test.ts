import { App, Notice } from "obsidian";
import { ReadwiseService } from "../ReadwiseService";
import { READWISE_EXPORT_ENDPOINT } from "../../../types/readwise";
import { httpRequest } from "../../../utils/httpClient";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(),
  };
});

jest.mock("../../../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

jest.mock("../../../components/ReadwiseSyncWidget", () => ({
  ReadwiseSyncWidget: class ReadwiseSyncWidget {
    show() {}
    destroy() {}
  },
}));

type PluginStub = {
  app: App;
  settings: any;
  getSettingsManager: () => { updateSettings: (patch: Record<string, unknown>) => Promise<void> };
};

function createPluginStub(settingsOverrides: Record<string, unknown> = {}) {
  const app = new App();
  const settings = {
    readwiseEnabled: true,
    readwiseApiToken: "test-token",
    readwiseDestinationFolder: "SystemSculpt/Readwise",
    readwiseOrganization: "by-category",
    readwiseTweetOrganization: "standalone",
    readwiseSyncMode: "interval",
    readwiseSyncIntervalMinutes: 60,
    readwiseLastSyncTimestamp: 0,
    readwiseLastSyncCursor: "",
    readwiseImportOptions: {
      highlights: true,
      bookNotes: true,
      tags: true,
      includeHighlightNotes: true,
      fullDocument: false,
      includeSavedDate: true,
    },
    ...settingsOverrides,
  };

  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => {
    Object.assign(settings, patch);
  });

  const plugin: PluginStub = {
    app,
    settings,
    getSettingsManager: () => ({ updateSettings }),
  };

  return { plugin, updateSettings };
}

describe("ReadwiseService", () => {
  const httpRequestMock = httpRequest as unknown as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists sync state via vault adapter.write (no vault.create)", async () => {
    const { plugin, updateSettings } = createPluginStub();
    const service = new ReadwiseService(plugin as any);

    httpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      json: { count: 0, nextPageCursor: null, results: [] },
    });

    await service.syncIncremental();

    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      expect.stringContaining(".systemsculpt/readwise/sync-state.json"),
      expect.any(String)
    );
    expect(plugin.app.vault.create).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        readwiseLastSyncTimestamp: expect.any(Number),
        readwiseLastSyncCursor: "",
      })
    );
  });

  it("uses sync start time as the persisted watermark", async () => {
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockImplementationOnce(() => 2000)
      .mockImplementation(() => 3000);

    const { plugin, updateSettings } = createPluginStub();
    const service = new ReadwiseService(plugin as any);

    httpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      json: { count: 0, nextPageCursor: null, results: [] },
    });

    await service.syncIncremental();

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        readwiseLastSyncTimestamp: 2000,
      })
    );

    nowSpy.mockRestore();
  });

  it("forces a full sync when import-affecting settings change", async () => {
    const { plugin } = createPluginStub({ readwiseLastSyncTimestamp: 123456 });
    const service = new ReadwiseService(plugin as any);

    // Simulate a settings hash mismatch from a previous run
    (service as any).syncState.settingsHash = "previous-settings-hash";

    httpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      json: { count: 0, nextPageCursor: null, results: [] },
    });

    await service.syncIncremental();

    expect(httpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: READWISE_EXPORT_ENDPOINT,
      })
    );
  });

  it("does not show popup Notices for scheduled sync failures", async () => {
    const { plugin } = createPluginStub();
    const service = new ReadwiseService(plugin as any);

    httpRequestMock.mockRejectedValue(new Error("network down"));

    await service.syncIncremental({ trigger: "scheduled" });

    expect(Notice).not.toHaveBeenCalled();
  });
});

