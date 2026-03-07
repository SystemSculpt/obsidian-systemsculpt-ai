type PiDesktopPlatform = NodeJS.Platform | string | undefined;

export type PiDesktopLoginWindowLaunch = {
  appLabel: string;
  command: string;
  args: string[];
};

function quotePosixSingle(value: string): string {
  const normalized = String(value || "");
  if (!normalized) {
    return "''";
  }
  return `'${normalized.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function escapeAppleScriptDoubleQuoted(value: string): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function normalizeDesktopPlatform(platform?: PiDesktopPlatform): string {
  return String(platform || process.platform || "").trim().toLowerCase();
}

export function getStudioPiDesktopShellLabel(platform?: PiDesktopPlatform): string {
  const normalized = normalizeDesktopPlatform(platform);
  if (normalized === "win32") {
    return "PowerShell";
  }
  if (normalized === "darwin") {
    return "Terminal";
  }
  return "terminal";
}

export function buildStudioPiApiKeyEnvCommand(envVar: string, platform?: PiDesktopPlatform): string {
  const normalizedEnvVar = String(envVar || "").trim();
  if (!normalizedEnvVar) {
    return "";
  }
  if (normalizeDesktopPlatform(platform) === "win32") {
    return `$env:${normalizedEnvVar}='your-api-key-here'`;
  }
  return `export ${normalizedEnvVar}="your-api-key-here"`;
}

export function getStudioPiAuthStoragePathHint(platform?: PiDesktopPlatform): string {
  if (normalizeDesktopPlatform(platform) === "win32") {
    return `%USERPROFILE%\\.pi\\agent\\auth.json`;
  }
  return "~/.pi/agent/auth.json";
}

export function buildStudioPiShellInvocationCommand(options: {
  command: string;
  args?: string[];
  envAssignments?: Record<string, string | undefined>;
  platform?: PiDesktopPlatform;
}): string {
  const platform = normalizeDesktopPlatform(options.platform);
  const command = String(options.command || "").trim();
  const args = Array.isArray(options.args) ? options.args : [];
  const envAssignments = Object.entries(options.envAssignments || {}).filter(([, value]) => {
    return typeof value === "string" && value.length > 0;
  });

  if (platform === "win32") {
    const envPrefix = envAssignments.map(([key, value]) => {
      return `$env:${key}=${quotePowerShellSingle(String(value || ""))}`;
    });
    const invocation = ["&", quotePowerShellSingle(command), ...args.map(quotePowerShellSingle)].join(" ");
    return envPrefix.length > 0 ? `${envPrefix.join("; ")}; ${invocation}` : invocation;
  }

  const envPrefix = envAssignments.map(([key, value]) => {
    return `${key}=${quotePosixSingle(String(value || ""))}`;
  });
  const invocation = [quotePosixSingle(command), ...args.map(quotePosixSingle)].join(" ");
  return envPrefix.length > 0 ? `${envPrefix.join(" ")} ${invocation}` : invocation;
}

export function buildStudioPiDesktopLoginWindowLaunch(options: {
  cwd: string;
  shellCommand: string;
  platform?: PiDesktopPlatform;
}): PiDesktopLoginWindowLaunch | null {
  const cwd = String(options.cwd || "").trim();
  const shellCommand = String(options.shellCommand || "").trim();
  const platform = normalizeDesktopPlatform(options.platform);

  if (!cwd || !shellCommand) {
    return null;
  }

  if (platform === "darwin") {
    const terminalCommand = `cd ${quotePosixSingle(cwd)}; ${shellCommand}`;
    return {
      appLabel: "Terminal",
      command: "osascript",
      args: [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${escapeAppleScriptDoubleQuoted(terminalCommand)}"`,
      ],
    };
  }

  if (platform === "win32") {
    const startProcessCommand = [
      "Start-Process",
      "-FilePath",
      quotePowerShellSingle("powershell.exe"),
      "-WorkingDirectory",
      quotePowerShellSingle(cwd),
      "-ArgumentList",
      `@(${["-NoExit", "-Command", shellCommand].map(quotePowerShellSingle).join(", ")})`,
    ].join(" ");
    return {
      appLabel: "PowerShell",
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", startProcessCommand],
    };
  }

  return null;
}
