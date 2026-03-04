import type { StudioTerminalShellProfile } from "./StudioTerminalSessionTypes";

const ZSH_PROMPT_SPACING_PRELUDE_PATTERN = /(?:\x1b\[[0-9;]*m){0,8}%(?:\x1b\[[0-9;]*m){0,8}[ ]{16,}\r \r/g;

function shellCommandBasename(command: string): string {
  return String(command || "")
    .trim()
    .toLowerCase()
    .split(/[\\/]/)
    .pop() || "";
}

export function isZshShellCommand(command: string): boolean {
  const basename = shellCommandBasename(command);
  return basename === "zsh" || basename === "zsh.exe";
}

export function resolveInteractiveShellArgs(command: string): string[] {
  const basename = shellCommandBasename(command);
  if (!basename) {
    return [];
  }
  if (basename === "zsh" || basename === "zsh.exe") {
    // Disables zsh prompt spacing redraw prelude that can corrupt first-line rendering in xterm.
    return ["-i", "-l", "-o", "no_prompt_sp"];
  }
  if (basename === "bash" || basename === "sh" || basename === "bash.exe") {
    return ["-i", "-l"];
  }
  if (basename === "pwsh" || basename === "pwsh.exe" || basename === "powershell" || basename === "powershell.exe") {
    return ["-NoLogo"];
  }
  return [];
}

export function stripZshPromptSpacingPrelude(data: string): string {
  if (!data) {
    return data;
  }
  return data.replace(ZSH_PROMPT_SPACING_PRELUDE_PATTERN, "");
}

export function shellCandidates(profile: StudioTerminalShellProfile): Array<{ command: string; args: string[] }> {
  if (process.platform === "win32") {
    if (profile === "pwsh") {
      return [{ command: "pwsh.exe", args: resolveInteractiveShellArgs("pwsh.exe") }];
    }
    if (profile === "powershell") {
      return [{ command: "powershell.exe", args: resolveInteractiveShellArgs("powershell.exe") }];
    }
    if (profile === "cmd") {
      return [{ command: process.env.ComSpec || "cmd.exe", args: [] }];
    }
    if (profile === "bash") {
      return [{ command: "bash.exe", args: resolveInteractiveShellArgs("bash.exe") }];
    }
    if (profile === "zsh") {
      return [{ command: "zsh.exe", args: resolveInteractiveShellArgs("zsh.exe") }];
    }
    return [
      { command: "pwsh.exe", args: resolveInteractiveShellArgs("pwsh.exe") },
      { command: "powershell.exe", args: resolveInteractiveShellArgs("powershell.exe") },
      { command: process.env.ComSpec || "cmd.exe", args: [] },
    ];
  }

  if (profile === "pwsh") {
    return [{ command: "pwsh", args: resolveInteractiveShellArgs("pwsh") }];
  }
  if (profile === "powershell") {
    return [{ command: "powershell", args: resolveInteractiveShellArgs("powershell") }];
  }
  if (profile === "cmd") {
    return [{ command: "cmd", args: [] }];
  }
  if (profile === "bash") {
    return [{ command: "bash", args: resolveInteractiveShellArgs("bash") }];
  }
  if (profile === "zsh") {
    return [{ command: "zsh", args: resolveInteractiveShellArgs("zsh") }];
  }

  const envShell = String(process.env.SHELL || "").trim();
  const candidates: Array<{ command: string; args: string[] }> = [];
  if (envShell) {
    candidates.push({
      command: envShell,
      args: resolveInteractiveShellArgs(envShell),
    });
  }
  candidates.push(
    { command: "zsh", args: resolveInteractiveShellArgs("zsh") },
    { command: "bash", args: resolveInteractiveShellArgs("bash") },
    { command: "sh", args: resolveInteractiveShellArgs("sh") }
  );
  return candidates;
}

export function buildStudioTerminalEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  env.SYSTEMSCULPT_STUDIO_TERMINAL = "1";
  env.TERM_PROGRAM = "SystemSculpt Studio";
  env.POWERLEVEL9K_INSTANT_PROMPT = "off";
  env.POWERLEVEL10K_INSTANT_PROMPT = "off";
  if (!String(env.TERM || "").trim()) {
    env.TERM = "xterm-256color";
  }
  if (!String(env.COLORTERM || "").trim()) {
    env.COLORTERM = "truecolor";
  }
  return env;
}
