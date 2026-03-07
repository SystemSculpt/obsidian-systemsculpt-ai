import {
  buildStudioPiApiKeyEnvCommand,
  buildStudioPiDesktopLoginWindowLaunch,
  buildStudioPiShellInvocationCommand,
  getStudioPiAuthStoragePathHint,
  getStudioPiDesktopShellLabel,
} from "../PiDesktopSetupUtils";

describe("PiDesktopSetupUtils", () => {
  it("uses platform-appropriate shell labels", () => {
    expect(getStudioPiDesktopShellLabel("darwin")).toBe("Terminal");
    expect(getStudioPiDesktopShellLabel("win32")).toBe("PowerShell");
    expect(getStudioPiDesktopShellLabel("linux")).toBe("terminal");
  });

  it("builds API-key env commands for macOS and Windows", () => {
    expect(buildStudioPiApiKeyEnvCommand("OPENAI_API_KEY", "darwin")).toBe(
      'export OPENAI_API_KEY="your-api-key-here"'
    );
    expect(buildStudioPiApiKeyEnvCommand("OPENAI_API_KEY", "win32")).toBe(
      "$env:OPENAI_API_KEY='your-api-key-here'"
    );
  });

  it("returns OS-appropriate auth storage hints", () => {
    expect(getStudioPiAuthStoragePathHint("darwin")).toBe("~/.pi/agent/auth.json");
    expect(getStudioPiAuthStoragePathHint("win32")).toBe("%USERPROFILE%\\.pi\\agent\\auth.json");
  });

  it("builds POSIX shell invocations for bundled Pi commands", () => {
    expect(
      buildStudioPiShellInvocationCommand({
        platform: "darwin",
        command: "/opt/homebrew/bin/node",
        args: ["/tmp/pi cli.js", "/login", "anthropic"],
        envAssignments: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      })
    ).toBe(
      "ELECTRON_RUN_AS_NODE='1' '/opt/homebrew/bin/node' '/tmp/pi cli.js' '/login' 'anthropic'"
    );
  });

  it("builds PowerShell invocations for bundled Pi commands", () => {
    expect(
      buildStudioPiShellInvocationCommand({
        platform: "win32",
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: ["C:\\Users\\mike\\pi\\cli.js", "/login", "anthropic"],
        envAssignments: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      })
    ).toBe(
      "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\mike\\pi\\cli.js' '/login' 'anthropic'"
    );
  });

  it("builds desktop login launchers for macOS Terminal and Windows PowerShell", () => {
    const macLaunch = buildStudioPiDesktopLoginWindowLaunch({
      platform: "darwin",
      cwd: "/Users/systemsculpt/Test Vault",
      shellCommand: "ELECTRON_RUN_AS_NODE='1' '/opt/homebrew/bin/node' '/tmp/pi cli.js' '/login' 'anthropic'",
    });
    expect(macLaunch).toEqual({
      appLabel: "Terminal",
      command: "osascript",
      args: [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        'tell application "Terminal" to do script "cd \'/Users/systemsculpt/Test Vault\'; ELECTRON_RUN_AS_NODE=\'1\' \'/opt/homebrew/bin/node\' \'/tmp/pi cli.js\' \'/login\' \'anthropic\'"',
      ],
    });

    const windowsLaunch = buildStudioPiDesktopLoginWindowLaunch({
      platform: "win32",
      cwd: "C:\\Users\\mike\\Vault",
      shellCommand: "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Users\\mike\\node.exe' 'C:\\Users\\mike\\cli.js' '/login' 'anthropic'",
    });
    expect(windowsLaunch).toEqual({
      appLabel: "PowerShell",
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Start-Process -FilePath 'powershell.exe' -WorkingDirectory 'C:\\Users\\mike\\Vault' -ArgumentList @('-NoExit', '-Command', '$env:ELECTRON_RUN_AS_NODE=''1''; & ''C:\\Users\\mike\\node.exe'' ''C:\\Users\\mike\\cli.js'' ''/login'' ''anthropic''')",
      ],
    });
  });
});
