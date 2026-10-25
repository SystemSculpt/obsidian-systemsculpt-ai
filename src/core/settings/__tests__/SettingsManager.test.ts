/** @jest-environment node */

jest.mock("obsidian", () => ({
  App: jest.fn(),
  Notice: jest.fn(),
  Platform: {
    isDesktopApp: true,
    isMobile: false,
    isMobileApp: false,
  },
  normalizePath: (value: string) => String(value || "").replace(/\\/g, "/"),
  TFolder: class TFolder {},
}));

const backupStart = jest.fn();
jest.mock("../AutomaticBackupService", () => ({
  AutomaticBackupService: jest.fn().mockImplementation(() => ({
    start: backupStart,
    stop: jest.fn(),
  })),
}));

import { SettingsManager } from "../SettingsManager";
import { CURRENT_SCHEMA_VERSION } from "../migrations/schemaVersion";
import {
  getCurrentHostPreferredMicrophoneId,
  setCurrentHostPreferredMicrophoneId,
} from "../../../services/recorder/RecorderPreferenceStore";

function installOwnerWindow(): Window {
  const values = new Map<string, string>();
  const ownerWindow = {
    localStorage: {
      getItem: jest.fn((key: string) => values.get(key) ?? null),
      setItem: jest.fn((key: string, value: string) => values.set(key, value)),
    },
  } as unknown as Window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: ownerWindow,
  });
  return ownerWindow;
}

function createPlugin(loadDataResult: unknown = {}) {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  return {
    manifest: { id: "systemsculpt-ai" },
    loadData: jest.fn().mockResolvedValue(loadDataResult),
    saveData: jest.fn().mockResolvedValue(undefined),
    storage: null,
    register: jest.fn(),
    getLogger: () => logger,
    logger,
    app: {
      vault: {
        configDir: ".obsidian",
        getName: jest.fn(() => "settings-manager-vault"),
        adapter: {
          basePath: "/tmp/systemsculpt-test-vault",
          exists: jest.fn().mockResolvedValue(false),
          read: jest.fn(),
          write: jest.fn().mockResolvedValue(undefined),
          list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
        },
        createFolder: jest.fn().mockResolvedValue(undefined),
      },
      workspace: { trigger: jest.fn() },
    },
    _internal_settings_systemsculpt_plugin: {},
  } as any;
}

describe("SettingsManager managed settings contract", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    delete (globalThis as typeof globalThis & { window?: Window }).window;
  });

  it("loads current settings, stamps v4, and prunes retired client authority", async () => {
    const plugin = createPlugin({
      schemaVersion: 3,
      licenseKey: "license_test",
      serverUrl: "http://localhost:3002/api/plugin",
      customProviders: [{ id: "retired" }],
      selectedModelId: "retired@@model",
      readwiseApiToken: "secret",
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(manager.settings.licenseKey).toBe("license_test");
    expect(manager.settings).not.toHaveProperty("serverUrl");
    expect(manager.settings).not.toHaveProperty("customProviders");
    expect(manager.settings).not.toHaveProperty("selectedModelId");
    expect(manager.settings).not.toHaveProperty("readwiseApiToken");
    expect(plugin.saveData).toHaveBeenCalledWith(Object.fromEntries(
      Object.entries(manager.settings).filter(([key]) => key !== "lastValidated"),
    ));
    expect(backupStart).toHaveBeenCalledTimes(1);
  });

  it("uses the current defaults for invalid persisted data", async () => {
    const plugin = createPlugin([]);
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(typeof manager.settings.chatsDirectory).toBe("string");
    expect(typeof manager.settings.vaultInstanceId).toBe("string");
    expect(manager.settings.thinAgentClientId).toMatch(/^client_[a-f0-9]{32}$/);
  });

  it.each([undefined, null, "true", 1, false, true])("requires an explicit boolean opt-in for unattended handoffs (case %#)", async value => {
    const manager = new SettingsManager(createPlugin({ phoneHandoffsAutoRun: value }));
    await manager.loadSettings();
    expect(manager.settings.phoneHandoffsAutoRun).toBe(value === true);
  });

  it.each([undefined, null, 42, "Work/Meetings", ""])("loads the meeting capture folder without changing the inbox (case %#)", async (value) => {
    const manager = new SettingsManager(createPlugin({ phoneCapturesFolder: "Phone", phoneCapturesMeetingsFolder: value }));
    await manager.loadSettings();
    expect(manager.settings.phoneCapturesFolder).toBe("Phone");
    expect(manager.settings.phoneCapturesMeetingsFolder).toBe(typeof value === "string" ? value : "SystemSculpt/Meetings");
    await manager.updateSettings({ phoneCapturesMeetingsFolder: "Meetings/Team" });
    expect(manager.settings.phoneCapturesMeetingsFolder).toBe("Meetings/Team");
  });

  it.each([
    ["defaults", {}, false],
    ["legacy true", { respectReducedMotion: true }, false],
    ["legacy false", { respectReducedMotion: false }, false],
    ["explicit opt-in", { reduceChatMotion: true, respectReducedMotion: false }, true],
    ["explicit opt-out", { reduceChatMotion: false, respectReducedMotion: true }, false],
    ["invalid new value", { reduceChatMotion: "true", respectReducedMotion: true }, false],
  ])("loads reduced chat motion as an independent opt-in: %s", async (_label, storedSettings, expected) => {
    const plugin = createPlugin({ schemaVersion: CURRENT_SCHEMA_VERSION, ...storedSettings });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    expect(manager.settings).toHaveProperty("reduceChatMotion", expected);
    expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ reduceChatMotion: expected }));
  });

  it("persists one stable thin-agent installation client id across reloads", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      vaultInstanceId: "12345678-1234-4abc-8def-1234567890ab",
    });
    const first = new SettingsManager(plugin);
    await first.loadSettings();
    expect(first.settings.thinAgentClientId)
      .toBe("client_1234567812344abc8def1234567890ab");

    const reloadedPlugin = createPlugin(first.settings);
    const second = new SettingsManager(reloadedPlugin);
    await second.loadSettings();
    expect(second.settings.thinAgentClientId).toBe(first.settings.thinAgentClientId);
  });

  it.each(['systemsculpt', 'claude', 'codex'] as const)('records an explicit %s choice without marking unrelated saves', async backend => {
    const plugin = createPlugin({ schemaVersion: CURRENT_SCHEMA_VERSION });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    expect(manager.settings.textExecutionBackendExplicit).toBe(false);
    await manager.updateSettings({ chatFontSize: 'large' });
    expect(manager.settings.textExecutionBackendExplicit).toBe(false);
    await manager.updateSettings({ textExecutionBackend: backend });
    expect(manager.settings.textExecutionBackendExplicit).toBe(true);
    expect(plugin.saveData).toHaveBeenLastCalledWith(expect.objectContaining({ textExecutionBackend: backend, textExecutionBackendExplicit: true }));
  });

  it("persists updates and emits the settings-updated event", async () => {
    const plugin = createPlugin({ schemaVersion: CURRENT_SCHEMA_VERSION });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    plugin.saveData.mockClear();
    plugin.app.workspace.trigger.mockClear();

    await manager.updateSettings({ chatFontSize: "large" });

    expect(manager.settings.chatFontSize).toBe("large");
    expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ chatFontSize: "large" }));
    expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
      "systemsculpt:settings-updated",
      expect.objectContaining({ chatFontSize: "medium" }),
      manager.settings,
      ["chatFontSize"],
    );
  });

  it("skips equivalent updates, including normalized and nested values", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    jest.clearAllMocks();

    await manager.updateSettings({});
    await manager.updateSettings({ chatFontSize: "medium" });
    await manager.updateSettings({ knownChatsDirectories: [...manager.settings.knownChatsDirectories] });
    await manager.updateSettings({ workflowEngine: JSON.parse(JSON.stringify(manager.settings.workflowEngine)) });
    await manager.updateSettings({ workflowEngine: Object.fromEntries(Object.entries(manager.settings.workflowEngine).reverse()) as any });
    await manager.saveSettings();

    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
    expect(plugin.app.workspace.trigger).not.toHaveBeenCalled();
  });

  it("keeps validation timestamps in memory without rewriting settings or backups", async () => {
    const plugin = createPlugin({ lastValidated: 123 });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    expect(manager.settings.lastValidated).toBe(0);
    expect(plugin.saveData.mock.calls.at(-1)[0]).not.toHaveProperty("lastValidated");
    expect(JSON.parse(plugin.app.vault.adapter.write.mock.calls.at(-1)[1])).not.toHaveProperty("lastValidated");
    jest.clearAllMocks();

    await manager.updateSettings({ lastValidated: 456 });
    expect(manager.settings.lastValidated).toBe(456);
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
  });

  it("detects nested mutations against a detached snapshot", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    jest.clearAllMocks();
    plugin._internal_settings_systemsculpt_plugin.workflowEngine.enabled = false;
    await manager.saveSettings();
    expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
      "systemsculpt:settings-updated",
      expect.objectContaining({ workflowEngine: expect.objectContaining({ enabled: true }) }),
      expect.objectContaining({ workflowEngine: expect.objectContaining({ enabled: false }) }),
      ["workflowEngine"],
    );
  });

  it("retries an identical update after a failed write", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    jest.clearAllMocks();
    plugin.saveData.mockRejectedValueOnce(new Error("disk full"));
    await manager.updateSettings({ chatFontSize: "large" });
    expect(plugin.app.workspace.trigger).not.toHaveBeenCalled();
    await manager.updateSettings({ chatFontSize: "large" });
    expect(plugin.saveData).toHaveBeenCalledTimes(2);
    expect(plugin.app.workspace.trigger).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite an unchanged current settings file on reload", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    const reloaded = createPlugin(plugin.saveData.mock.calls.at(-1)[0]);
    await new SettingsManager(reloaded).loadSettings();
    expect(reloaded.saveData).not.toHaveBeenCalled();
    expect(reloaded.app.vault.adapter.write).not.toHaveBeenCalled();
  });

  it("keeps the iOS link only for the account that reported it", async () => {
    const plugin = createPlugin({ licenseKey: "linked-account", phoneCapturesLinked: true });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    await manager.updateSettings({ chatFontSize: "large" });
    expect(manager.settings.phoneCapturesLinked).toBe(true);
    await manager.updateSettings({ licenseKey: "never-used-ios" });
    expect(manager.settings.phoneCapturesLinked).toBe(false);
    await manager.updateSettings({ phoneCapturesLinked: true });
    await manager.updateSettings({ licenseKey: "" });
    expect(manager.settings.phoneCapturesLinked).toBe(false);
  });

  it("checks the current account inside the settings persistence queue", async () => {
    const plugin = createPlugin({ licenseKey: "linked-account" });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    await Promise.all([
      manager.updateSettings({ licenseKey: "never-used-ios" }),
      manager.updateSettings(current => current.licenseKey === "linked-account"
        ? { phoneCapturesLinked: true } : {}),
    ]);
    expect(manager.settings.phoneCapturesLinked).toBe(false);
    await manager.updateSettings(current => current.licenseKey === "never-used-ios"
      ? { phoneCapturesLinked: true } : {});
    expect(manager.settings.phoneCapturesLinked).toBe(true);
  });

  it("migrates a restored v3 backup before applying it", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    await manager.restoreFromExternalSettings({
      schemaVersion: 3,
      licenseKey: "backup-license",
      lastValidated: Date.now() + 86_400_000,
      customProviders: [{ id: "retired" }],
      serverUrl: "http://localhost:3002/api/plugin",
    });

    expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(manager.settings.licenseKey).toBe("backup-license");
    expect(manager.settings.lastValidated).toBe(0);
    expect(manager.settings).not.toHaveProperty("customProviders");
    expect(manager.settings).not.toHaveProperty("serverUrl");
  });

  it("seeds the known chats folders from the configured folder and only ever appends to them", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      chatsDirectory: "Archive/Chats",
    });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    // Chats saved before the list existed are in the folder configured now.
    expect(manager.settings.knownChatsDirectories).toEqual(["Archive/Chats"]);

    await Promise.all([
      manager.updateSettings({ knownChatsDirectories: ["Work/Chats"] }),
      manager.updateSettings({ knownChatsDirectories: ["Home/Chats"] }),
      manager.updateSettings({ chatsDirectory: "Home/Chats" }),
    ]);
    expect(manager.settings.knownChatsDirectories)
      .toEqual(["Archive/Chats", "Work/Chats", "Home/Chats"]);

    // A restored backup, which carries its own list, cannot drop a folder
    // that chats may still be in.
    await manager.restoreFromExternalSettings({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      chatsDirectory: "SystemSculpt/Chats",
      knownChatsDirectories: ["SystemSculpt/Chats"],
    });
    expect(manager.settings.knownChatsDirectories)
      .toEqual(["Archive/Chats", "Work/Chats", "Home/Chats", "SystemSculpt/Chats"]);
    expect(plugin.saveData.mock.calls.at(-1)?.[0]).toMatchObject({
      knownChatsDirectories: ["Archive/Chats", "Work/Chats", "Home/Chats", "SystemSculpt/Chats"],
    });
  });

  it("removes retired recorder settings and synced microphone preferences", async () => {
    const plugin = createPlugin({
      schemaVersion: 8,
      preferredMicrophoneId: "default",
      postProcessingPromptType: "preset",
      postProcessingPromptPresetId: "transcript-cleaner",
      postProcessingPromptFilePath: "",
      showTranscriptionFormatChooserInModal: false,
      enableAutoAudioResampling: true,
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneId");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneIdsByHost");
    expect(manager.settings).not.toHaveProperty("postProcessingPromptType");
    expect(manager.settings).not.toHaveProperty("postProcessingPromptPresetId");
    expect(manager.settings).not.toHaveProperty("postProcessingPromptFilePath");
    expect(manager.settings).not.toHaveProperty("showTranscriptionFormatChooserInModal");
    expect(manager.settings).not.toHaveProperty("enableAutoAudioResampling");
  });

  it("prunes retired workflow automations while preserving inbox transcription settings", async () => {
    const plugin = createPlugin({
      schemaVersion: 11,
      workflowEngine: {
        enabled: false,
        inboxRoutingEnabled: false,
        inboxFolder: "Capture/Audio",
        processedNotesFolder: "Capture/Processed",
        autoTranscribeInboxNotes: true,
        futureWorkflowField: { keep: true },
        automations: { meeting: { enabled: true } },
        templates: { legacy: { enabled: true } },
        managedTextOperations: { "automation::meeting::note.md": { phase: "queued" } },
        skippedFiles: {
          "automation::meeting::note.md": {
            path: "note.md",
            type: "automation",
            skippedAt: "2026-07-18T00:00:00.000Z",
          },
          "transcription::default::Capture/Audio/audio.mp3": {
            path: "Capture/Audio/audio.mp3",
            type: "transcription",
            skippedAt: "2026-07-18T00:00:00.000Z",
          },
        },
      },
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.workflowEngine).toMatchObject({
      enabled: false,
      inboxRoutingEnabled: false,
      inboxFolder: "Capture/Audio",
      processedNotesFolder: "Capture/Processed",
      autoTranscribeInboxNotes: true,
      skippedFiles: {
        "transcription::default::Capture/Audio/audio.mp3": {
          path: "Capture/Audio/audio.mp3",
          type: "transcription",
          skippedAt: "2026-07-18T00:00:00.000Z",
        },
      },
      futureWorkflowField: { keep: true },
    });
    expect(manager.settings.workflowEngine).not.toHaveProperty("automations");
    expect(manager.settings.workflowEngine).not.toHaveProperty("templates");
    expect(manager.settings.workflowEngine).not.toHaveProperty("managedTextOperations");
  });

  it("moves the current-host v9 microphone preference to device-local storage", async () => {
    const ownerWindow = installOwnerWindow();
    const plugin = createPlugin({
      schemaVersion: 9,
      vaultInstanceId: "legacy-recorder-vault",
      preferredMicrophoneId: "fallback-mic",
      preferredMicrophoneIdsByHost: {
        desktop: "desktop-mic",
        mobile: "phone-mic",
      },
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(getCurrentHostPreferredMicrophoneId(
      ownerWindow,
      "legacy-recorder-vault",
    )).toBe("desktop-mic");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneId");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneIdsByHost");
    const persisted = plugin.saveData.mock.calls.at(-1)?.[0];
    expect(persisted).not.toHaveProperty("preferredMicrophoneId");
    expect(persisted).not.toHaveProperty("preferredMicrophoneIdsByHost");
  });

  it("falls back to the legacy scalar microphone preference during v10 migration", async () => {
    const ownerWindow = installOwnerWindow();
    const vaultIdentity = "legacy-scalar-recorder-vault";
    const plugin = createPlugin({
      schemaVersion: 9,
      vaultInstanceId: vaultIdentity,
      preferredMicrophoneId: "legacy-scalar-mic",
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(getCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity)).toBe(
      "legacy-scalar-mic",
    );
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneId");
  });

  it("does not overwrite a local microphone when importing an old backup", async () => {
    const ownerWindow = installOwnerWindow();
    const vaultIdentity = "restored-recorder-vault";
    setCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity, "local-mic");
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      vaultInstanceId: vaultIdentity,
    });
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    await manager.restoreFromExternalSettings({
      schemaVersion: 9,
      vaultInstanceId: vaultIdentity,
      preferredMicrophoneId: "backup-mic",
    });

    expect(getCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity)).toBe("local-mic");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneId");
    expect(manager.settings).not.toHaveProperty("preferredMicrophoneIdsByHost");
  });

  it("keeps only valid bounded pending recorder recovery entries", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pendingRecorderCaptures: [
        {
          filePath: "SystemSculpt/Recordings/saved.webm",
          startedAt: 1,
          durationMs: 2_000,
          sizeBytes: 24_000,
          stopReason: "background-hidden",
          destination: "note",
          transcriptionIntent: "manual",
          operationId: "transcription-safe-1",
        },
        {
          filePath: "",
          startedAt: -1,
          durationMs: -1,
          sizeBytes: 0,
          stopReason: "unknown",
          destination: "somewhere",
          operationId: "not valid!",
        },
      ],
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.pendingRecorderCaptures).toEqual([{
      filePath: "SystemSculpt/Recordings/saved.webm",
      startedAt: 1,
      durationMs: 2_000,
      sizeBytes: 24_000,
      stopReason: "background-hidden",
      destination: "note",
      transcriptionIntent: "manual",
      operationId: "transcription-safe-1",
    }]);
  });

  it("deduplicates synced recorder recovery and blocks conflicting operation ids", async () => {
    const base = {
      startedAt: 1,
      durationMs: 2_000,
      sizeBytes: 24_000,
      stopReason: "background-hidden",
      destination: "note",
    };
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pendingRecorderCaptures: [
        { ...base, filePath: "same.webm", transcriptionIntent: "manual" },
        { ...base, filePath: "same.webm", startedAt: 2, operationId: "same-op" },
        { ...base, filePath: "conflict.webm", operationId: "first-op" },
        { ...base, filePath: "conflict.webm", startedAt: 3, operationId: "second-op" },
      ],
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.pendingRecorderCaptures).toEqual([
      expect.objectContaining({
        filePath: "same.webm",
        startedAt: 2,
        transcriptionIntent: "manual",
        operationId: "same-op",
      }),
      expect.objectContaining({
        filePath: "conflict.webm",
        startedAt: 3,
        recoveryBlocked: "conflicting-operation-ids",
      }),
    ]);
    expect(manager.settings.pendingRecorderCaptures[1]).not.toHaveProperty("operationId");
  });

  it("keeps the in-progress marker of a recording that was streaming to disk", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pendingRecorderCaptures: [
        {
          filePath: "SystemSculpt/Recordings/streaming.webm",
          startedAt: 1,
          durationMs: 0,
          sizeBytes: 12_000,
          stopReason: "interrupted",
          destination: "chat",
          captureInProgress: true,
        },
        {
          filePath: "SystemSculpt/Recordings/finished.webm",
          startedAt: 1,
          durationMs: 2_000,
          sizeBytes: 24_000,
          stopReason: "manual",
          destination: "note",
          captureInProgress: "yes",
        },
      ],
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.pendingRecorderCaptures[0]).toMatchObject({ captureInProgress: true });
    expect(manager.settings.pendingRecorderCaptures[1]).not.toHaveProperty("captureInProgress");
  });

  it("keeps a discarded recording fragment even though it has no recorded size", async () => {
    const plugin = createPlugin({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pendingRecorderCaptures: [
        {
          filePath: ".systemsculpt/recordings-in-progress/fragment.webm",
          startedAt: 1,
          durationMs: 0,
          sizeBytes: 0,
          stopReason: "interrupted",
          destination: "note",
          discarded: true,
        },
        {
          filePath: "SystemSculpt/Recordings/empty.webm",
          startedAt: 1,
          durationMs: 0,
          sizeBytes: 0,
          stopReason: "manual",
          destination: "note",
        },
      ],
    });
    const manager = new SettingsManager(plugin);

    await manager.loadSettings();

    expect(manager.settings.pendingRecorderCaptures).toEqual([
      expect.objectContaining({ filePath: ".systemsculpt/recordings-in-progress/fragment.webm", discarded: true }),
    ]);
  });

  it("logs primary save and backup failures without breaking updates", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();

    plugin.saveData.mockRejectedValueOnce(new Error("disk full"));
    await expect(manager.updateSettings({ chatFontSize: "large" })).resolves.toBe(false);
    expect(plugin.logger.error).toHaveBeenCalledWith(
      "Failed to save SystemSculpt settings",
      expect.any(Error),
      expect.objectContaining({ source: "SettingsManager" }),
    );

    plugin.saveData.mockResolvedValue(undefined);
    plugin.app.vault.adapter.write.mockRejectedValueOnce(new Error("backup unavailable"));
    await expect(manager.updateSettings({ chatFontSize: "small" })).resolves.toBe(true);
    expect(plugin.logger.error).toHaveBeenCalledWith(
      "Failed to write SystemSculpt settings backup",
      expect.any(Error),
      expect.objectContaining({ source: "SettingsManager" }),
    );
  });

  it("retries only the backup after its write fails", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    jest.clearAllMocks();
    plugin.app.vault.adapter.write.mockRejectedValueOnce(new Error("backup unavailable"));
    await manager.updateSettings({ chatFontSize: "large" });
    await manager.updateSettings({ chatFontSize: "large" });
    await manager.saveSettings();
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(plugin.app.workspace.trigger).toHaveBeenCalledTimes(1);
    expect(plugin.app.vault.adapter.write).toHaveBeenCalledTimes(2);
  });

  it("backs up the committed revision rather than a mutation during the primary write", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    plugin.saveData.mockImplementationOnce(async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    });
    const update = manager.updateSettings({ defaultChatTag: "committed" });
    await writing;
    plugin._internal_settings_systemsculpt_plugin.workflowEngine.enabled = false;
    release();
    await update;
    expect(plugin.saveData.mock.calls.at(-1)[0].workflowEngine.enabled).toBe(true);
    expect(JSON.parse(plugin.app.vault.adapter.write.mock.calls.at(-1)[1]).workflowEngine.enabled).toBe(true);
    await manager.saveSettings();
    expect(JSON.parse(plugin.app.vault.adapter.write.mock.calls.at(-1)[1]).workflowEngine.enabled).toBe(false);
  });

  it("writes the settings backup when a concurrent save already created its folder", async () => {
    const plugin = createPlugin();
    const manager = new SettingsManager(plugin);
    await manager.loadSettings();
    plugin.app.vault.adapter.write.mockClear();

    const backupDir = ".systemsculpt/settings-backups";
    plugin.app.vault.adapter.exists.mockImplementation(async () => false);
    plugin.app.vault.createFolder.mockImplementationOnce(async () => {
      plugin.app.vault.adapter.exists.mockImplementation(async (path: string) => path === backupDir);
      throw new Error("Folder already exists.");
    });
    plugin.app.vault.getAbstractFileByPath = jest.fn(() => null);
    plugin.app.vault.adapter.stat = jest.fn().mockResolvedValue({ type: "folder" });

    await manager.updateSettings({ chatFontSize: "large" });

    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      `${backupDir}/settings-backup-latest.json`,
      expect.any(String),
    );
    expect(plugin.logger.error).not.toHaveBeenCalledWith(
      "Failed to write SystemSculpt settings backup",
      expect.anything(),
      expect.anything(),
    );
  });

  describe("empty or unreadable data.json", () => {
    const LATEST_BACKUP = ".systemsculpt/settings-backups/settings-backup-latest.json";
    const restoredBackup = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      chatFontSize: "large",
      defaultChatTag: "restored-from-backup",
    };

    function installLatestBackup(plugin: ReturnType<typeof createPlugin>) {
      plugin.app.vault.adapter.exists.mockImplementation(async (path: string) => path === LATEST_BACKUP);
      plugin.app.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path !== LATEST_BACKUP) throw new Error(`ENOENT: ${path}`);
        return JSON.stringify(restoredBackup);
      });
    }

    it("restores the latest backup when loadData resolves null instead of saving defaults over it", async () => {
      const plugin = createPlugin(null);
      installLatestBackup(plugin);
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.chatFontSize).toBe("large");
      expect(manager.settings.defaultChatTag).toBe("restored-from-backup");
      expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({
        chatFontSize: "large",
        defaultChatTag: "restored-from-backup",
      }));
      expect(plugin.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Restored SystemSculpt settings from backup"),
        expect.objectContaining({ source: "SettingsManager" }),
      );
    });

    it("consults the backup for an empty data.json object as well", async () => {
      const plugin = createPlugin({});
      installLatestBackup(plugin);
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.defaultChatTag).toBe("restored-from-backup");
    });

    it("skips corrupt or empty backups until it finds a valid dated backup", async () => {
      const plugin = createPlugin(null);
      const paths = [
        LATEST_BACKUP,
        ".systemsculpt/settings-backups/settings-backup-2026-09-16.json",
        ".systemsculpt/settings-backups/settings-backup-2026-09-15.json",
      ];
      plugin.app.vault.adapter.exists.mockImplementation(async (path: string) => paths.includes(path));
      plugin.app.vault.adapter.list.mockResolvedValue({ files: paths.slice(1), folders: [] });
      plugin.app.vault.adapter.read.mockImplementation(async (path: string) => {
        if (path === LATEST_BACKUP) return "{truncated";
        if (path === paths[1]) return "{}";
        return JSON.stringify(restoredBackup);
      });
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.defaultChatTag).toBe("restored-from-backup");
    });

    function installHiddenBackups(plugin: ReturnType<typeof createPlugin>, backups: Record<string, unknown>) {
      // The hidden .systemsculpt/settings/backups copies older versions wrote.
      plugin.storage = {
        listFiles: jest.fn(async (type: string, subPath: string) =>
          type === "settings" && subPath === "backups" ? Object.keys(backups) : []),
        readFile: jest.fn(async (_type: string, fileName: string) => backups[fileName.replace(/^backups\//, "")] ?? null),
        writeFile: jest.fn(),
      };
    }

    it("restores from an old hidden backup copy when it is the only backup left", async () => {
      const plugin = createPlugin(null);
      installHiddenBackups(plugin, { "settings-backup-2026-09-01.json": restoredBackup });
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.defaultChatTag).toBe("restored-from-backup");
      expect(plugin.storage.readFile).toHaveBeenCalledWith("settings", "backups/settings-backup-2026-09-01.json", true);
    });

    it("restores the newest dated backup from either folder, the visible copy first on the same day", async () => {
      const visible = (day: string) => `.systemsculpt/settings-backups/settings-backup-2026-09-${day}.json`;
      const visibleBackups: Record<string, unknown> = {
        [visible("10")]: { ...restoredBackup, defaultChatTag: "visible-10" },
        [visible("12")]: { ...restoredBackup, defaultChatTag: "visible-12" },
      };
      const restore = async (hidden: Record<string, unknown>) => {
        const plugin = createPlugin(null);
        plugin.app.vault.adapter.exists.mockImplementation(async (path: string) => path in visibleBackups);
        plugin.app.vault.adapter.list.mockResolvedValue({ files: Object.keys(visibleBackups), folders: [] });
        plugin.app.vault.adapter.read.mockImplementation(async (path: string) => JSON.stringify(visibleBackups[path]));
        installHiddenBackups(plugin, hidden);
        const manager = new SettingsManager(plugin);
        await manager.loadSettings();
        return manager.settings.defaultChatTag;
      };

      await expect(restore({
        "settings-backup-2026-09-11.json": { ...restoredBackup, defaultChatTag: "hidden-11" },
        "settings-backup-2026-09-12.json": { ...restoredBackup, defaultChatTag: "hidden-12" },
      })).resolves.toBe("visible-12");
      await expect(restore({
        "settings-backup-2026-09-13.json": { ...restoredBackup, defaultChatTag: "hidden-13" },
      })).resolves.toBe("hidden-13");
    });

    it("writes the pre-migration backup once, to settings-backups only", async () => {
      const plugin = createPlugin({ schemaVersion: 3, licenseKey: "license_test" });
      installHiddenBackups(plugin, {});
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(plugin.app.vault.adapter.write.mock.calls.map(([path]: [string]) => path)
        .filter((path: string) => path.includes("premigration")))
        .toEqual([".systemsculpt/settings-backups/settings-backup-premigration-v3.json"]);
      expect(plugin.storage.writeFile).not.toHaveBeenCalled();
    });

    it("still ends up with defaults on a fresh install with no data and no backup", async () => {
      const plugin = createPlugin(null);
      plugin.app.vault.adapter.list.mockRejectedValue(new Error("ENOENT: .systemsculpt/settings-backups"));
      const manager = new SettingsManager(plugin);

      await manager.loadSettings();

      expect(manager.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(manager.settings.chatFontSize).toBe("medium");
      expect(manager.settings.defaultChatTag).toBe("");
      expect(plugin.saveData).toHaveBeenCalledWith(Object.fromEntries(
      Object.entries(manager.settings).filter(([key]) => key !== "lastValidated"),
    ));
      expect(plugin.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("serialized persistence", () => {
    it("applies concurrent updates in order so no key is dropped", async () => {
      const plugin = createPlugin({ schemaVersion: CURRENT_SCHEMA_VERSION });
      const manager = new SettingsManager(plugin);
      await manager.loadSettings();
      plugin.saveData.mockClear();

      await Promise.all([
        manager.updateSettings({ chatFontSize: "large" }),
        manager.updateSettings({ defaultChatTag: "queued" }),
        manager.saveSettings(),
      ]);

      expect(manager.settings).toMatchObject({ chatFontSize: "large", defaultChatTag: "queued" });
      expect(plugin._internal_settings_systemsculpt_plugin).toMatchObject({
        chatFontSize: "large",
        defaultChatTag: "queued",
      });
      expect(plugin.saveData).toHaveBeenCalledTimes(2);
      expect(plugin.saveData.mock.calls.map(([data]: [any]) => data.chatFontSize)).toEqual(["large", "large"]);
      expect(plugin.saveData.mock.calls.at(-1)?.[0]).toMatchObject({ chatFontSize: "large", defaultChatTag: "queued" });
    });

    it("keeps the queue usable after a failed save", async () => {
      const plugin = createPlugin({ schemaVersion: CURRENT_SCHEMA_VERSION });
      const manager = new SettingsManager(plugin);
      await manager.loadSettings();
      plugin.saveData.mockRejectedValueOnce(new Error("disk full"));

      const failing = manager.updateSettings({ chatFontSize: "large" });
      const following = manager.updateSettings({ defaultChatTag: "after-failure" });

      await expect(failing).resolves.toBe(false);
      await expect(following).resolves.toBe(true);
      expect(manager.settings).toMatchObject({ chatFontSize: "large", defaultChatTag: "after-failure" });
      expect(plugin.saveData.mock.calls.at(-1)?.[0]).toMatchObject({ defaultChatTag: "after-failure" });
    });
  });
});
