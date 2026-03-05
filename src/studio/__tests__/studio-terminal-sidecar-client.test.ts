import {
  buildStudioTerminalSidecarChildEnv,
  isExpectedTerminalSidecarConnectionError,
  resolveStudioTerminalSidecarRuntime,
  resolveStudioTerminalSocketPath,
} from "../terminal/StudioTerminalSidecarClient";

describe("resolveStudioTerminalSocketPath", () => {
  it("uses the provided unix temp directory when the path fits", () => {
    const socketPath = resolveStudioTerminalSocketPath({
      key: "abc123",
      platform: "darwin",
      tempDir: "/tmp",
    });

    expect(socketPath).toBe("/tmp/systemsculpt-studio-terminal-abc123.sock");
  });

  it("falls back to /tmp when the temp directory path is too long for unix sockets", () => {
    const socketPath = resolveStudioTerminalSocketPath({
      key: "db92aba91beecb0e07c26a4f",
      platform: "darwin",
      tempDir: "/var/folders/sh/pbwlfprj2w7cgtp04mn8p8kh0000gn/T",
    });

    expect(socketPath.startsWith("/tmp/")).toBe(true);
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(103);
  });

  it("returns a named pipe path on windows", () => {
    const socketPath = resolveStudioTerminalSocketPath({
      key: "abc123",
      platform: "win32",
    });

    expect(socketPath).toBe("\\\\.\\pipe\\systemsculpt-studio-terminal-abc123");
  });

  it("classifies expected sidecar ENOENT errors", () => {
    expect(
      isExpectedTerminalSidecarConnectionError(
        new Error("Unable to connect to terminal sidecar: connect ENOENT /tmp/systemsculpt.sock.")
      )
    ).toBe(true);
    expect(isExpectedTerminalSidecarConnectionError(new Error("bad payload shape"))).toBe(false);
  });

  it("sets ELECTRON_RUN_AS_NODE when runtime includes electron", () => {
    const env = buildStudioTerminalSidecarChildEnv({
      baseEnv: {
        PATH: "/usr/bin",
      },
      runtimeVersions: {
        electron: "35.2.1",
      },
      runtimeCommand: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
      execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("resolves sidecar runtime to a working node command when execPath is not node", () => {
    const runtime = resolveStudioTerminalSidecarRuntime({
      execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      runtimeVersions: {
        electron: "35.2.1",
      },
      probeCommand: (command) => command === "/opt/homebrew/bin/node",
      fileExists: (path) => path === "/opt/homebrew/bin/node" || path === "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    });

    expect(runtime.command).toBe("/opt/homebrew/bin/node");
    expect(runtime.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
