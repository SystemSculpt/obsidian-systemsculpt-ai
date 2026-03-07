import type SystemSculptPlugin from "../../../main";
import { buildStudioPiTerminalLoginCommand } from "../PiCli";
import { ensureBundledPiRuntime } from "../PiRuntimeBootstrap";
import { resolvePiRuntimes } from "../PiProcessRuntime";

jest.mock("../PiRuntimeBootstrap", () => ({
  ensureBundledPiRuntime: jest.fn().mockResolvedValue({
    pluginInstallDir: "/tmp/test-vault/.obsidian/plugins/systemsculpt-ai",
    result: {
      installedRuntime: false,
      packageCount: 2,
    },
  }),
}));

jest.mock("../PiProcessRuntime", () => ({
  resolvePiRuntimes: jest.fn(),
  runPiCommandWithResolvedRuntime: jest.fn(),
  startPiProcess: jest.fn(),
}));

describe("buildStudioPiTerminalLoginCommand", () => {
  const ensureBundledPiRuntimeMock = ensureBundledPiRuntime as jest.MockedFunction<typeof ensureBundledPiRuntime>;
  const resolvePiRuntimesMock = resolvePiRuntimes as jest.MockedFunction<typeof resolvePiRuntimes>;
  let plugin: SystemSculptPlugin;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    plugin = {
      app: {},
      manifest: {
        id: "systemsculpt-ai",
        version: "4.15.0",
      },
    } as unknown as SystemSculptPlugin;
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("formats bundled macOS login commands for a POSIX shell", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    resolvePiRuntimesMock.mockReturnValue([
      {
        command: "/opt/homebrew/bin/node",
        argsPrefix: ["/tmp/pi cli.js"],
        source: "local-package",
        label: "bundled",
        env: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ]);

    const command = await buildStudioPiTerminalLoginCommand(plugin, "anthropic");

    expect(ensureBundledPiRuntimeMock).toHaveBeenCalledWith({ plugin });
    expect(command).toBe(
      "ELECTRON_RUN_AS_NODE='1' '/opt/homebrew/bin/node' '/tmp/pi cli.js' '/login' 'anthropic'"
    );
  });

  it("formats bundled Windows login commands for PowerShell", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    resolvePiRuntimesMock.mockReturnValue([
      {
        command: "C:\\Program Files\\nodejs\\node.exe",
        argsPrefix: ["C:\\Users\\mike\\pi\\cli.js"],
        source: "local-package",
        label: "bundled",
        env: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ]);

    const command = await buildStudioPiTerminalLoginCommand(plugin, "anthropic");

    expect(command).toBe(
      "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\mike\\pi\\cli.js' '/login' 'anthropic'"
    );
  });
});
