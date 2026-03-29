/**
 * @jest-environment node
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mockCreatePiAuthStorage = jest.fn();
const mockCreatePiModelRegistry = jest.fn();
const mockResolvePiAuthPath = jest.fn();
const mockResolvePiModelsPath = jest.fn();
const mockListLocalPiTextModels = jest.fn();
const mockListPiTextCatalogModels = jest.fn();

jest.mock("obsidian", () => ({
  TFile: class {},
  normalizePath: (value: string) => String(value || "").replace(/\\/g, "/"),
}));

jest.mock("../../../core/plugin/viewTypes", () => ({
  CHAT_VIEW_TYPE: "systemsculpt-chat-view",
}));

jest.mock("../../../utils/titleUtils", () => ({
  generateDefaultChatTitle: jest.fn(() => "New Chat"),
}));

jest.mock("../../../views/chatview/modelSelection", () => ({
  loadChatModelPickerOptions: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../../services/pi/PiSdkDesktopSupport", () => ({
  createPiAuthStorage: (...args: any[]) => mockCreatePiAuthStorage(...args),
}));

jest.mock("../../../services/pi/PiSdkRuntime", () => ({
  createPiModelRegistry: (...args: any[]) => mockCreatePiModelRegistry(...args),
}));

jest.mock("../../../services/pi/PiSdkStoragePaths", () => ({
  resolvePiAuthPath: (...args: any[]) => mockResolvePiAuthPath(...args),
  resolvePiModelsPath: (...args: any[]) => mockResolvePiModelsPath(...args),
}));

jest.mock("../../../services/pi/PiTextModels", () => ({
  listLocalPiTextModels: (...args: any[]) => mockListLocalPiTextModels(...args),
}));

jest.mock("../../../services/pi-native/PiTextCatalog", () => ({
  listPiTextCatalogModels: (...args: any[]) => mockListPiTextCatalogModels(...args),
}));

jest.mock("../../../settings/providerStatus", () => ({
  loadProviderStatusInventory: jest.fn(async () => ({
    records: [
      {
        provider: "openai",
        source: "none",
        supportsOAuth: true,
        hasAnyAuth: false,
        hasStoredCredential: false,
        credentialType: "none",
      },
    ],
    localProviderIds: new Set(),
    oauthProvidersById: new Map([["openai", { id: "openai", name: "OpenAI" }]]),
  })),
  loadProviderStatusInventoryWithTimeout: jest.fn(async () => ({
    records: [
      {
        provider: "openai",
        source: "none",
        supportsOAuth: true,
        hasAnyAuth: false,
        hasStoredCredential: false,
        credentialType: "none",
      },
    ],
    localProviderIds: new Set(),
    oauthProvidersById: new Map([["openai", { id: "openai", name: "OpenAI" }]]),
  })),
  getProviderDisplayState: jest.fn((record: any) => ({
    blocked: false,
    connected: Boolean(record?.hasAnyAuth),
    ready: Boolean(record?.hasAnyAuth),
    tone: record?.hasAnyAuth ? "connected" : "disconnected",
    statusLabel: record?.hasAnyAuth ? "Connected" : "Not connected",
    summary: record?.hasAnyAuth ? "Connected via API key" : "Not connected",
    inlineReason: null,
    hoverDetails: null,
  })),
  getProviderLabel: jest.fn(() => "OpenAI"),
}));

jest.mock("../../../studio/piAuth/StudioPiProviderRegistry", () => ({
  getApiKeyEnvVarForProvider: jest.fn(() => "OPENAI_API_KEY"),
  isStudioPiAuthMethodEnabled: jest.fn((_providerId: string, method: string) => method === "oauth" || method === "api_key"),
  isStudioPiLocalProvider: jest.fn(() => false),
}));

jest.mock("../../../utils/vaultPathUtils", () => ({
  resolveAbsoluteVaultPath: jest.fn(() => "/tmp/automation-vault/.obsidian"),
}));

import { DesktopAutomationBridge } from "../DesktopAutomationBridge";

const {
  loadProviderStatusInventoryWithTimeout: loadProviderStatusInventoryWithTimeoutMock,
} = jest.requireMock("../../../settings/providerStatus") as Record<string, jest.Mock>;

describe("DesktopAutomationBridge discovery cleanup", () => {
  let tempDir: string;

  beforeEach(async () => {
    delete (globalThis as any).__systemsculptDesktopAutomationBridgeSingleton;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-automation-bridge-"));
    mockCreatePiAuthStorage.mockReset();
    mockCreatePiModelRegistry.mockReset();
    mockResolvePiAuthPath.mockReset();
    mockResolvePiModelsPath.mockReset();
    mockListLocalPiTextModels.mockReset();
    mockListPiTextCatalogModels.mockReset();

    mockCreatePiAuthStorage.mockReturnValue({
      list: () => [],
      hasAuth: () => false,
    });
    mockCreatePiModelRegistry.mockReturnValue({
      getError: () => null,
      getAll: () => [],
      getAvailable: () => [],
    });
    mockResolvePiAuthPath.mockReturnValue(path.join(tempDir, "auth.json"));
    mockResolvePiModelsPath.mockReturnValue(path.join(tempDir, "models.json"));
    mockListLocalPiTextModels.mockResolvedValue([]);
    mockListPiTextCatalogModels.mockResolvedValue([]);
  });

  afterEach(async () => {
    delete (globalThis as any).__systemsculptDesktopAutomationBridgeSingleton;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function createPluginStub() {
    return {
      settings: {
        desktopAutomationBridgeEnabled: true,
        vaultInstanceId: "vault-instance",
      },
      manifest: {
        id: "systemsculpt-ai",
        version: "5.2.0",
      },
      app: {
        vault: {
          getName: () => "automation-vault",
          configDir: ".obsidian",
          adapter: {
            getBasePath: () => "/tmp/automation-vault",
          },
        },
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([]),
          getLeaf: jest.fn(),
        },
      },
      getLogger: () => ({
        info: jest.fn(),
        error: jest.fn(),
      }),
      isPluginUnloading: () => false,
    } as any;
  }

  async function fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  it("removes the discovery file owned by the stopping bridge instance", async () => {
    const discoveryFilePath = path.join(tempDir, "vault-instance.json");
    const record = {
      token: "token-current",
      port: 60401,
      startedAt: "2026-03-27T14:39:37.000Z",
    };
    await fs.writeFile(
      discoveryFilePath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );

    const bridge = new DesktopAutomationBridge(createPluginStub());
    Object.assign(bridge as any, {
      server: {
        close: (callback: () => void) => callback(),
      },
      discoveryFilePath,
      token: record.token,
      port: record.port,
      startedAt: record.startedAt,
    });

    await bridge.stop();

    expect(await fileExists(discoveryFilePath)).toBe(false);
  });

  it("preserves a discovery file that has already been replaced by a newer bridge instance", async () => {
    const discoveryFilePath = path.join(tempDir, "vault-instance.json");
    const currentRecord = {
      token: "token-old",
      port: 60401,
      startedAt: "2026-03-27T14:39:37.000Z",
    };
    const newerRecord = {
      token: "token-new",
      port: 60455,
      startedAt: "2026-03-27T14:40:12.000Z",
    };
    await fs.writeFile(
      discoveryFilePath,
      `${JSON.stringify(newerRecord, null, 2)}\n`,
      "utf8"
    );

    const bridge = new DesktopAutomationBridge(createPluginStub());
    Object.assign(bridge as any, {
      server: {
        close: (callback: () => void) => callback(),
      },
      discoveryFilePath,
      token: currentRecord.token,
      port: currentRecord.port,
      startedAt: currentRecord.startedAt,
    });

    await bridge.stop();

    expect(await fileExists(discoveryFilePath)).toBe(true);
    expect(JSON.parse(await fs.readFile(discoveryFilePath, "utf8"))).toMatchObject(newerRecord);
  });

  it("restarts an existing bridge when a settings-file touch requests recovery", async () => {
    const bridge = new DesktopAutomationBridge(createPluginStub());
    const stopSpy = jest.spyOn(bridge as any, "stopNow").mockResolvedValue(undefined);
    const startSpy = jest.spyOn(bridge as any, "start").mockResolvedValue(undefined);
    const writeDiscoverySpy = jest.spyOn(bridge as any, "writeDiscoveryFile").mockResolvedValue(undefined);

    Object.assign(bridge as any, {
      server: {},
    });

    await bridge.syncFromSettings({ forceRestart: true });

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(writeDiscoverySpy).not.toHaveBeenCalled();
  });

  it("stops instead of restarting when a late bridge sync arrives during plugin unload", async () => {
    const plugin = createPluginStub();
    plugin.isPluginUnloading = () => true;

    const bridge = new DesktopAutomationBridge(plugin);
    const stopSpy = jest.spyOn(bridge as any, "stopNow").mockResolvedValue(undefined);
    const startSpy = jest.spyOn(bridge as any, "start").mockResolvedValue(undefined);
    const writeDiscoverySpy = jest.spyOn(bridge as any, "writeDiscoveryFile").mockResolvedValue(undefined);

    Object.assign(bridge as any, {
      server: {},
    });

    await bridge.syncFromSettings({ forceRestart: true });

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
    expect(writeDiscoverySpy).not.toHaveBeenCalled();
  });

  it("serializes concurrent bridge restarts so start/stop do not overlap", async () => {
    const bridge = new DesktopAutomationBridge(createPluginStub());
    let activeStops = 0;
    let maxActiveStops = 0;
    let activeStarts = 0;
    let maxActiveStarts = 0;

    jest.spyOn(bridge as any, "stopNow").mockImplementation(async () => {
      activeStops += 1;
      maxActiveStops = Math.max(maxActiveStops, activeStops);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeStops -= 1;
      Object.assign(bridge as any, { server: null });
    });
    jest.spyOn(bridge as any, "start").mockImplementation(async () => {
      activeStarts += 1;
      maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeStarts -= 1;
      Object.assign(bridge as any, { server: {} });
    });

    Object.assign(bridge as any, {
      server: {},
    });

    await Promise.all([
      bridge.syncFromSettings({ forceRestart: true }),
      bridge.syncFromSettings({ forceRestart: true }),
    ]);

    expect(maxActiveStops).toBe(1);
    expect(maxActiveStarts).toBe(1);
  });

  it("stops a previously claimed bridge singleton before starting a replacement", async () => {
    const first = new DesktopAutomationBridge(createPluginStub());
    const second = new DesktopAutomationBridge(createPluginStub());

    jest.spyOn(first as any, "start").mockResolvedValue(undefined);
    const firstStopSpy = jest.spyOn(first, "stop").mockResolvedValue(undefined);
    const secondStartSpy = jest.spyOn(second as any, "start").mockResolvedValue(undefined);

    await first.syncFromSettings();
    await second.syncFromSettings();

    expect(firstStopSpy).toHaveBeenCalledTimes(1);
    expect(secondStartSpy).toHaveBeenCalledTimes(1);
  });

  it("destroys tracked sockets when stopping a running bridge", async () => {
    const bridge = new DesktopAutomationBridge(createPluginStub());
    const destroyFirst = jest.fn();
    const destroySecond = jest.fn();
    const closeIdleConnections = jest.fn();
    const closeAllConnections = jest.fn();

    Object.assign(bridge as any, {
      server: {
        close: (callback: () => void) => callback(),
        closeIdleConnections,
        closeAllConnections,
      },
      serverSockets: new Set([
        { destroy: destroyFirst },
        { destroy: destroySecond },
      ]),
      token: "token-current",
      port: 60401,
      startedAt: "2026-03-27T14:39:37.000Z",
    });

    await bridge.stop();

    expect(closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(destroyFirst).toHaveBeenCalledTimes(1);
    expect(destroySecond).toHaveBeenCalledTimes(1);
    expect((bridge as any).serverSockets.size).toBe(0);
  });

  it("coalesces overlapping self-reload requests into a single reload", async () => {
    const bridge = new DesktopAutomationBridge(createPluginStub());
    const performSpy = jest.spyOn(bridge as any, "performSelfReload").mockResolvedValue(undefined);

    const first = (bridge as any).requestSelfReload();
    const second = (bridge as any).requestSelfReload();

    expect(first.alreadyScheduled).toBe(false);
    expect(second.alreadyScheduled).toBe(true);

    (bridge as any).startScheduledSelfReload();
    await (bridge as any).selfReloadPromise;

    expect(performSpy).toHaveBeenCalledTimes(1);
    expect((bridge as any).selfReloadRequestedAt).toBeNull();
  });

  it("prefers unload/load plugin methods for a live self-reload", async () => {
    const plugin = createPluginStub();
    plugin.app.plugins = {
      unloadPlugin: jest.fn().mockResolvedValue(undefined),
      loadPlugin: jest.fn().mockResolvedValue(undefined),
      disablePlugin: jest.fn().mockResolvedValue(undefined),
      enablePlugin: jest.fn().mockResolvedValue(undefined),
    };

    const bridge = new DesktopAutomationBridge(plugin);
    await (bridge as any).performSelfReload();

    expect(plugin.app.plugins.unloadPlugin).toHaveBeenCalledWith("systemsculpt-ai");
    expect(plugin.app.plugins.loadPlugin).toHaveBeenCalledWith("systemsculpt-ai");
    expect(plugin.app.plugins.disablePlugin).not.toHaveBeenCalled();
    expect(plugin.app.plugins.enablePlugin).not.toHaveBeenCalled();
  });

  it("falls back to disable/enable plugin methods when unload/load are unavailable", async () => {
    const plugin = createPluginStub();
    plugin.app.plugins = {
      disablePlugin: jest.fn().mockResolvedValue(undefined),
      enablePlugin: jest.fn().mockResolvedValue(undefined),
    };

    const bridge = new DesktopAutomationBridge(plugin);
    await (bridge as any).performSelfReload();

    expect(plugin.app.plugins.disablePlugin).toHaveBeenCalledWith("systemsculpt-ai");
    expect(plugin.app.plugins.enablePlugin).toHaveBeenCalledWith("systemsculpt-ai");
  });

  it("preserves the current chat model when no model override is requested", async () => {
    const plugin = createPluginStub();
    const leaf: any = {
      getViewState: jest.fn(() => ({ type: "systemsculpt-chat-view" })),
      view: {
        getViewType: () => "systemsculpt-chat-view",
        inputHandler: {},
        getEffectiveSelectedModelId: () => "local-pi-github-copilot@@claude-haiku-4.5",
        setSelectedModelId: jest.fn(),
      },
    };
    plugin.app.workspace.getLeavesOfType.mockReturnValue([leaf]);

    const bridge = new DesktopAutomationBridge(plugin);
    jest.spyOn(bridge as any, "waitForChatViewReady").mockResolvedValue(leaf.view);

    const view = await (bridge as any).ensureChatView({ createIfMissing: false });

    expect(view).toBe(leaf.view);
    expect(leaf.view.setSelectedModelId).not.toHaveBeenCalled();
  });

  it("applies an explicitly requested chat model when one is provided", async () => {
    const plugin = createPluginStub();
    const leaf: any = {
      getViewState: jest.fn(() => ({ type: "systemsculpt-chat-view" })),
      view: {
        getViewType: () => "systemsculpt-chat-view",
        inputHandler: {},
        getEffectiveSelectedModelId: () => "systemsculpt@@systemsculpt/ai-agent",
        setSelectedModelId: jest.fn().mockResolvedValue(undefined),
      },
    };
    plugin.app.workspace.getLeavesOfType.mockReturnValue([leaf]);

    const bridge = new DesktopAutomationBridge(plugin);
    jest.spyOn(bridge as any, "waitForChatViewReady").mockResolvedValue(leaf.view);

    await (bridge as any).ensureChatView({
      createIfMissing: false,
      selectedModelId: "local-pi-github-copilot@@claude-haiku-4.5",
    });

    expect(leaf.view.setSelectedModelId).toHaveBeenCalledWith(
      "local-pi-github-copilot@@claude-haiku-4.5",
      { focusInput: false }
    );
  });

  it("status snapshot does not wait on an unready chat view", async () => {
    const plugin = createPluginStub();
    const leaf: any = {
      getViewState: jest.fn(() => ({ type: "systemsculpt-chat-view" })),
      view: {
        getViewType: () => "systemsculpt-chat-view",
        inputHandler: null,
        getAutomationSnapshot: jest.fn(),
      },
    };
    plugin.app.workspace.getLeavesOfType.mockReturnValue([leaf]);

    const bridge = new DesktopAutomationBridge(plugin);
    const waitSpy = jest.spyOn(bridge as any, "waitForChatViewReady");

    const snapshot = await (bridge as any).getStatusSnapshot();

    expect(waitSpy).not.toHaveBeenCalled();
    expect(snapshot.chat).toBeNull();
    expect(leaf.view.getAutomationSnapshot).not.toHaveBeenCalled();
  });

  it("includes provider capability metadata in the providers snapshot", async () => {
    const previousHTMLElement = (globalThis as any).HTMLElement;
    (globalThis as any).HTMLElement = class HTMLElementMock {};

    try {
      const bridge = new DesktopAutomationBridge(createPluginStub());
      const snapshot = await (bridge as any).getProvidersSettingsSnapshot({
        ensureOpen: false,
        waitForLoaded: false,
      });

      expect(snapshot.providers.rows).toEqual([
        expect.objectContaining({
          providerId: "openai",
          label: "OpenAI",
          isLocalProvider: false,
          apiKeyEnvVar: "OPENAI_API_KEY",
          oauthEnabled: true,
          apiKeyEnabled: true,
        }),
      ]);
    } finally {
      if (previousHTMLElement === undefined) {
        delete (globalThis as any).HTMLElement;
      } else {
        (globalThis as any).HTMLElement = previousHTMLElement;
      }
    }
  });

  it("returns provider inventory errors instead of hanging the snapshot", async () => {
    const previousHTMLElement = (globalThis as any).HTMLElement;
    (globalThis as any).HTMLElement = class HTMLElementMock {};
    loadProviderStatusInventoryWithTimeoutMock.mockRejectedValueOnce(
      new Error("Timed out while loading provider settings.")
    );

    try {
      const bridge = new DesktopAutomationBridge(createPluginStub());
      const snapshot = await (bridge as any).getProvidersSettingsSnapshot({
        ensureOpen: false,
        waitForLoaded: false,
      });

      expect(snapshot.providers).toEqual(
        expect.objectContaining({
          error: "Timed out while loading provider settings.",
          rowCount: 0,
          localProviderIds: [],
          rows: [],
        })
      );
    } finally {
      if (previousHTMLElement === undefined) {
        delete (globalThis as any).HTMLElement;
      } else {
        (globalThis as any).HTMLElement = previousHTMLElement;
      }
    }
  });

  it("captures live Pi catalog diagnostics even when models.json is absent", async () => {
    const authPath = path.join(tempDir, "auth.json");
    const modelsPath = path.join(tempDir, "models.json");
    await fs.writeFile(
      authPath,
      JSON.stringify(
        {
          openrouter: {
            type: "api_key",
            key: "test-openrouter-key",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    mockResolvePiAuthPath.mockReturnValue(authPath);
    mockResolvePiModelsPath.mockReturnValue(modelsPath);
    mockCreatePiAuthStorage.mockReturnValue({
      list: () => ["openrouter"],
      hasAuth: (provider: string) => provider === "openrouter",
    });
    mockCreatePiModelRegistry.mockReturnValue({
      getError: () => null,
      getAll: () => [
        {
          provider: "openrouter",
          id: "openai/gpt-5.4-mini",
          name: "GPT-5.4 Mini",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
        },
        {
          provider: "openrouter",
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      ],
      getAvailable: () => [
        {
          provider: "openrouter",
          id: "openai/gpt-5.4-mini",
          name: "GPT-5.4 Mini",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      ],
    });
    mockListLocalPiTextModels.mockResolvedValue([
      {
        providerId: "openrouter",
        modelId: "openai/gpt-5.4-mini",
        label: "GPT-5.4 Mini",
      },
    ]);
    mockListPiTextCatalogModels.mockResolvedValue([
      {
        id: "systemsculpt@@systemsculpt/ai-agent",
        provider: "systemsculpt",
        sourceMode: "systemsculpt",
      },
      {
        id: "local-pi-openrouter@@openai/gpt-5.4-mini",
        provider: "openrouter",
        sourceMode: "pi_local",
        piExecutionModelId: "openrouter/openai/gpt-5.4-mini",
      },
    ]);

    const bridge = new DesktopAutomationBridge(createPluginStub());
    const diagnostics = await (bridge as any).getPiCatalogDiagnostics();

    expect(diagnostics).toEqual(
      expect.objectContaining({
        authPath,
        modelsPath,
        authFileExists: true,
        modelsFileExists: false,
        authProviders: ["openrouter"],
        modelsConfigProviders: [],
        registry: expect.objectContaining({
          error: null,
          allCount: 2,
          availableCount: 1,
          authProviders: ["openrouter"],
          hasAuthByProvider: {
            openrouter: true,
          },
          allProviders: {
            openrouter: 2,
          },
          availableProviders: {
            openrouter: 1,
          },
        }),
        localPiModels: expect.objectContaining({
          count: 1,
        }),
        catalog: expect.objectContaining({
          count: 2,
        }),
      }),
    );
  });

  it("keeps only one automation leaf marker when stale duplicates exist", async () => {
    const plugin = createPluginStub();
    const primaryLeaf: any = {};
    const staleLeaf: any = {};
    primaryLeaf.__systemsculptAutomation = true;
    staleLeaf.__systemsculptAutomation = true;
    plugin.app.workspace.getLeavesOfType.mockReturnValue([primaryLeaf, staleLeaf]);

    const bridge = new DesktopAutomationBridge(plugin);
    const resolvedLeaf = await (bridge as any).getAutomationLeaf(false);

    expect(resolvedLeaf).toBe(primaryLeaf);
    expect(Boolean(primaryLeaf.__systemsculptAutomation)).toBe(true);
    expect(Boolean(staleLeaf.__systemsculptAutomation)).toBe(false);
  });
});
