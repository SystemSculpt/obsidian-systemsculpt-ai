import type { StudioNodeDefinition } from "../types";

export const terminalNode: StudioNodeDefinition = {
  kind: "studio.terminal",
  version: "1.0.0",
  capabilityClass: "local_io",
  cachePolicy: "never",
  inputPorts: [],
  outputPorts: [],
  configDefaults: {
    cwd: "",
    shellProfile: "auto",
    scrollback: 4_000,
    width: 640,
    height: 420,
  },
  configSchema: {
    fields: [
      {
        key: "cwd",
        label: "Working Directory",
        type: "directory_path",
        required: false,
        allowOutsideVault: true,
        placeholder: "Defaults to the project folder when empty.",
      },
      {
        key: "shellProfile",
        label: "Shell",
        type: "select",
        required: true,
        options: [
          { value: "auto", label: "Auto" },
          { value: "pwsh", label: "PowerShell (pwsh)" },
          { value: "powershell", label: "Windows PowerShell" },
          { value: "cmd", label: "Command Prompt (cmd)" },
          { value: "bash", label: "Bash" },
          { value: "zsh", label: "Zsh" },
        ],
      },
      {
        key: "scrollback",
        label: "Scrollback",
        type: "number",
        required: true,
        min: 200,
        max: 50_000,
        integer: true,
      },
      {
        key: "width",
        label: "Width (px)",
        type: "number",
        required: true,
        min: 360,
        max: 2000,
        integer: true,
      },
      {
        key: "height",
        label: "Height (px)",
        type: "number",
        required: true,
        min: 220,
        max: 1600,
        integer: true,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute() {
    return {
      outputs: {},
    };
  },
};
