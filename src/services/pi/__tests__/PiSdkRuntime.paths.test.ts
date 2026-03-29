const createBundledPiAuthStorageMock = jest.fn();
const modelRegistryCtorMock = jest.fn();
const sessionCoreLoadMock = jest.fn();

jest.mock("../PiSdkCore", () => ({
  ModelRegistry: jest.fn().mockImplementation((...args: unknown[]) => {
    modelRegistryCtorMock(...args);
    return { getAvailable: jest.fn(() => []) };
  }),
  SessionManager: {
    create: jest.fn(),
    open: jest.fn(),
  },
  SettingsManager: {
    inMemory: jest.fn(() => ({})),
  },
}));

jest.mock("../PiSdkSessionCore", () => {
  sessionCoreLoadMock();
  return {
    __esModule: true,
    createAgentSession: jest.fn(),
    createCodingTools: jest.fn(),
    createExtensionRuntime: jest.fn(),
  };
});

jest.mock("../PiSdkAuthStorage", () => ({
  createBundledPiAuthStorage: jest.fn((authPath?: string) => {
    createBundledPiAuthStorageMock(authPath);
    return { authPath };
  }),
}));

import {
  createPiAuthStorage,
  createPiModelRegistry,
} from "../PiSdkRuntime";

describe("PiSdkRuntime explicit storage paths", () => {
  const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterAll(() => {
    if (typeof originalPiAgentDir === "string") {
      process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  function createPlugin() {
    return {
      app: {
        vault: {
          adapter: {
            getBasePath: jest.fn(() => "/vault"),
          },
        },
      },
    } as any;
  }

  it("uses a vault-local auth path when plugin context is available", () => {
    const authStorage = createPiAuthStorage({ plugin: createPlugin() });

    expect(createBundledPiAuthStorageMock).toHaveBeenCalledWith(
      "/vault/.systemsculpt/pi-agent/auth.json",
    );
    expect(authStorage).toEqual({
      authPath: "/vault/.systemsculpt/pi-agent/auth.json",
    });
  });

  it("uses a vault-local models path when creating the registry from plugin context", () => {
    const plugin = createPlugin();
    const authStorage = createPiAuthStorage({ plugin });

    createPiModelRegistry({ plugin, authStorage });

    expect(modelRegistryCtorMock).toHaveBeenCalledWith(
      authStorage,
      "/vault/.systemsculpt/pi-agent/models.json",
    );
  });

  it("prefers an explicit PI_CODING_AGENT_DIR override when present", () => {
    process.env.PI_CODING_AGENT_DIR = "C:\\Users\\Tester\\custom-pi";

    const authStorage = createPiAuthStorage({ plugin: createPlugin() });
    createPiModelRegistry({ plugin: createPlugin(), authStorage });

    expect(createBundledPiAuthStorageMock).toHaveBeenCalledWith(
      "C:\\Users\\Tester\\custom-pi\\auth.json",
    );
    expect(modelRegistryCtorMock).toHaveBeenCalledWith(
      authStorage,
      "C:\\Users\\Tester\\custom-pi\\models.json",
    );
  });

  it("does not load the session core when only creating the model registry", () => {
    expect(sessionCoreLoadMock).not.toHaveBeenCalled();
    expect(() => createPiModelRegistry({ plugin: createPlugin() })).not.toThrow();
    expect(sessionCoreLoadMock).not.toHaveBeenCalled();
  });
});
