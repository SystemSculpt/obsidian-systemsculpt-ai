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
  },
  configSchema: {
    fields: [
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
        key: "cwd",
        label: "Working Directory",
        type: "directory_path",
        required: false,
        allowOutsideVault: true,
        placeholder: "Defaults to the project folder when empty.",
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
