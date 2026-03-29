/** @jest-environment jsdom */

import { App } from "obsidian";

const mockLicenseManagerCtor = jest.fn();
const mockResumeChatServiceCtor = jest.fn();
const mockViewManagerCtor = jest.fn();
const mockViewManagerInitialize = jest.fn();
const mockCommandManagerCtor = jest.fn();
const mockRegisterCommands = jest.fn();

jest.mock("../services/PlatformContext", () => ({
  PlatformContext: {
    get: () => ({
      supportsDesktopOnlyFeatures: () => true,
    }),
  },
}));

jest.mock("../core/license/LicenseManager", () => ({
  LicenseManager: jest.fn().mockImplementation(() => {
    mockLicenseManagerCtor();
    return {};
  }),
}));

jest.mock("../views/chatview/ResumeChatService", () => ({
  ResumeChatService: jest.fn().mockImplementation(() => {
    mockResumeChatServiceCtor();
    return {};
  }),
}));

jest.mock("../core/plugin/views", () => ({
  ViewManager: jest.fn().mockImplementation(() => {
    mockViewManagerCtor();
    return {
      initialize: mockViewManagerInitialize,
    };
  }),
}));

jest.mock("../core/plugin/commands", () => ({
  CommandManager: jest.fn().mockImplementation(() => {
    mockCommandManagerCtor();
    return {
      registerCommands: mockRegisterCommands,
    };
  }),
}));

import SystemSculptPlugin from "../main";

const createLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setLogFileName: jest.fn(),
});

const createTracer = () => ({
  startPhase: jest.fn(() => ({
    complete: jest.fn(),
    fail: jest.fn(),
  })),
});

describe("SystemSculptPlugin.initializeManagers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterCommands.mockReset();
    mockRegisterCommands.mockImplementation(() => undefined);
    mockViewManagerInitialize.mockReset();
    mockViewManagerInitialize.mockImplementation(() => undefined);
  });

  it("retries command registration when the first registration attempt fails", async () => {
    const app = new App();
    const plugin = new SystemSculptPlugin(app, {
      id: "systemsculpt-ai",
      version: "1.0.0",
    } as any);

    jest
      .spyOn(plugin as any, "getInitializationTracer")
      .mockReturnValue(createTracer() as any);
    jest.spyOn(plugin, "getLogger").mockReturnValue(createLogger() as any);
    jest
      .spyOn(plugin as any, "syncDesktopAutomationBridge")
      .mockResolvedValue(undefined);

    const registerExtensionsSpy = jest.spyOn(plugin, "registerExtensions");

    mockRegisterCommands
      .mockImplementationOnce(() => {
        throw new Error("registerCommands failed");
      })
      .mockImplementation(() => undefined);

    await (plugin as any).initializeManagers();

    expect(mockRegisterCommands).toHaveBeenCalledTimes(1);
    expect((plugin as any).commandManager).toBeUndefined();
    expect((plugin as any).managersInitialized).toBe(false);
    expect((plugin as any).managersInitializationPromise).toBeNull();

    await (plugin as any).initializeManagers();

    expect(mockLicenseManagerCtor).toHaveBeenCalledTimes(1);
    expect(mockResumeChatServiceCtor).toHaveBeenCalledTimes(1);
    expect(mockViewManagerCtor).toHaveBeenCalledTimes(1);
    expect(mockRegisterCommands).toHaveBeenCalledTimes(2);
    expect((plugin as any).commandManager).toBeTruthy();
    expect((plugin as any).managersInitialized).toBe(true);
    expect(registerExtensionsSpy).toHaveBeenCalledTimes(1);
  });
});
