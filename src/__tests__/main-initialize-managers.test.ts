/** @jest-environment jsdom */

import { App } from "obsidian";

const mockLicenseManagerCtor = jest.fn();
const mockResumeChatServiceCtor = jest.fn();
const mockViewManagerCtor = jest.fn();
const mockViewManagerInitialize = jest.fn();
const mockCommandManagerCtor = jest.fn();
const mockRegisterCommands = jest.fn();
const mockTranscriptionService = {};
const mockGetTranscriptionService = jest.fn((..._args: unknown[]) => mockTranscriptionService);

jest.mock("../core/license/LicenseManager", () => ({
  LicenseManager: jest.fn().mockImplementation(() => { mockLicenseManagerCtor(); return {}; }),
}));
jest.mock("../views/chatview/ResumeChatService", () => ({
  ResumeChatService: jest.fn().mockImplementation(() => { mockResumeChatServiceCtor(); return {}; }),
}));
jest.mock("../core/plugin/views", () => ({
  ViewManager: jest.fn().mockImplementation(() => {
    mockViewManagerCtor();
    return { initialize: mockViewManagerInitialize };
  }),
}));
jest.mock("../core/plugin/commands", () => ({
  CommandManager: jest.fn().mockImplementation(() => {
    mockCommandManagerCtor();
    return { registerCommands: mockRegisterCommands };
  }),
}));
jest.mock("../services/TranscriptionService", () => ({
  TranscriptionService: { getInstance: (...args: unknown[]) => mockGetTranscriptionService(...args) },
}));

import SystemSculptPlugin from "../main";

function makePlugin() {
  return new SystemSculptPlugin(new App(), { id: "systemsculpt-ai", version: "1.0.0" } as any);
}

describe("SystemSculptPlugin manager ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockViewManagerInitialize.mockReset();
  });

  it("reports unavailable managers but creates transcription only on first use", () => {
    const plugin = makePlugin();
    expect(plugin.settings).toBeDefined();
    expect(plugin.storage).toBeUndefined();
    expect(plugin.directoryManager).toBeUndefined();
    expect(() => plugin.getSettingsManager()).toThrow("Settings manager has not been initialized");
    expect(() => plugin.getLicenseManager()).toThrow("License manager has not been initialized");
    expect(mockGetTranscriptionService).not.toHaveBeenCalled();
    expect(plugin.getTranscriptionService()).toBe(mockTranscriptionService);
    expect(plugin.getTranscriptionService()).toBe(mockTranscriptionService);
    expect(mockGetTranscriptionService).toHaveBeenCalledTimes(1);
    expect(mockLicenseManagerCtor).not.toHaveBeenCalled();
  });

  it("lazily initializes and reuses the view manager before deferred managers run", () => {
    const plugin = makePlugin();
    expect(plugin.getViewManager()).toBe(plugin.getViewManager());
    expect(mockViewManagerCtor).toHaveBeenCalledTimes(1);
    expect(mockViewManagerInitialize).toHaveBeenCalled();
  });

  it("coalesces manager initialization without registering commands a second time", async () => {
    const plugin = makePlugin();
    const extensions = jest.spyOn(plugin, "registerExtensions");
    await Promise.all([
      (plugin as any).initializeManagers(),
      (plugin as any).initializeManagers(),
    ]);
    await (plugin as any).initializeManagers();
    expect(mockLicenseManagerCtor).toHaveBeenCalledTimes(1);
    expect(mockResumeChatServiceCtor).toHaveBeenCalledTimes(1);
    expect(mockViewManagerCtor).toHaveBeenCalledTimes(1);
    expect(extensions).toHaveBeenCalledTimes(1);
    expect(mockRegisterCommands).not.toHaveBeenCalled();
  });

  it("allows a failed view initialization to retry without replacing its managers", async () => {
    const plugin = makePlugin();
    mockViewManagerInitialize.mockImplementationOnce(() => { throw new Error("View registration failed"); });
    await expect((plugin as any).initializeManagers()).rejects.toThrow("View registration failed");
    await (plugin as any).initializeManagers();
    expect(mockViewManagerCtor).toHaveBeenCalledTimes(1);
    expect(mockLicenseManagerCtor).toHaveBeenCalledTimes(1);
    expect(mockResumeChatServiceCtor).toHaveBeenCalledTimes(1);
    expect(mockViewManagerInitialize).toHaveBeenCalledTimes(2);
    expect(mockRegisterCommands).not.toHaveBeenCalled();
  });
});
