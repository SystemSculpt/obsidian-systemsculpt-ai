import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { getText } from "./shared";

export const cliCommandNode: StudioNodeDefinition = {
  kind: "studio.cli_command",
  version: "1.0.0",
  capabilityClass: "local_io",
  cachePolicy: "never",
  inputPorts: [],
  outputPorts: [
    { id: "stdout", type: "text" },
    { id: "stderr", type: "text" },
    { id: "exit_code", type: "number" },
    { id: "timed_out", type: "boolean" },
  ],
  configDefaults: {
    command: "",
    args: [],
    cwd: "",
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
  },
  configSchema: {
    fields: [
      {
        key: "command",
        label: "Command",
        type: "text",
        required: true,
        placeholder: "e.g. ffmpeg",
      },
      {
        key: "args",
        label: "Arguments",
        type: "string_list",
        required: false,
      },
      {
        key: "cwd",
        label: "Working Directory",
        type: "directory_path",
        required: true,
        allowOutsideVault: true,
        placeholder: "Absolute or allowed scoped path.",
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "number",
        required: true,
        min: 100,
        integer: true,
      },
      {
        key: "maxOutputBytes",
        label: "Max Output Bytes",
        type: "number",
        required: true,
        min: 1024,
        integer: true,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const command = getText(context.node.config.command as StudioJsonValue).trim();
    if (!command) {
      throw new Error(`CLI command node "${context.node.id}" requires config.command.`);
    }

    const cwd = getText(context.node.config.cwd as StudioJsonValue).trim();
    if (!cwd) {
      throw new Error(`CLI command node "${context.node.id}" requires config.cwd.`);
    }

    const argsRaw = Array.isArray(context.node.config.args) ? context.node.config.args : [];
    const args = argsRaw.map((value) => getText(value as StudioJsonValue));
    const timeoutMs = Number(context.node.config.timeoutMs as StudioJsonValue);
    const maxOutputBytes = Number(context.node.config.maxOutputBytes as StudioJsonValue);
    const result = await context.services.runCli({
      command,
      args,
      cwd,
      timeoutMs: Number.isFinite(timeoutMs) ? Math.max(100, timeoutMs) : 30_000,
      maxOutputBytes: Number.isFinite(maxOutputBytes) ? Math.max(1024, maxOutputBytes) : 256 * 1024,
    });

    return {
      outputs: {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
      },
    };
  },
};
