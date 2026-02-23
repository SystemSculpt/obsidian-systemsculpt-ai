import { Platform } from "obsidian";
import { spawn } from "node:child_process";
import type SystemSculptPlugin from "../main";
import { parseCanonicalId } from "../utils/modelUtils";

export type StudioLocalTextModelOption = {
  value: string;
  label: string;
  description: string;
  badge: string;
  keywords: string[];
};

type PiListedModel = {
  provider: string;
  model: string;
  context: string;
  maxOut: string;
  thinking: string;
  images: string;
};

export type PiCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type StudioPiCommandRunner = (
  plugin: SystemSculptPlugin,
  args: string[],
  timeoutMs: number
) => Promise<PiCommandResult>;

type PiOutputSnapshot = {
  text: string;
  errorMessage: string | null;
};

const COMMON_CLI_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin"];
const PI_MODEL_LIST_TIMEOUT_MS = 60_000;
const PI_GENERATION_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function mergeCliPath(rawPath: string): string {
  const segments = String(rawPath || "")
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const seen = new Set(segments);
  for (const segment of COMMON_CLI_PATHS) {
    if (!seen.has(segment)) {
      segments.push(segment);
      seen.add(segment);
    }
  }
  return segments.join(":");
}

function resolvePiCommandCwd(plugin: SystemSculptPlugin): string {
  const adapter = plugin.app?.vault?.adapter as {
    getBasePath?: () => string;
    basePath?: string;
  };
  const fromGetter =
    typeof adapter?.getBasePath === "function" ? String(adapter.getBasePath() || "").trim() : "";
  if (fromGetter) {
    return fromGetter;
  }
  const fromBasePath = String(adapter?.basePath || "").trim();
  if (fromBasePath) {
    return fromBasePath;
  }
  if (typeof process?.cwd === "function") {
    try {
      const cwd = String(process.cwd() || "").trim();
      if (cwd) {
        return cwd;
      }
    } catch {
      // Ignore cwd lookup failures and use the fallback.
    }
  }
  return "/";
}

function appendOutput(existing: string, chunk: Buffer | string): string {
  if (existing.length >= MAX_OUTPUT_BYTES) {
    return existing;
  }
  const next = existing + chunk.toString();
  if (next.length <= MAX_OUTPUT_BYTES) {
    return next;
  }
  return next.slice(0, MAX_OUTPUT_BYTES);
}

function summarizePiCommandError(result: PiCommandResult): string {
  const stderr = String(result.stderr || "").trim();
  if (stderr) {
    return stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || stderr;
  }
  const stdoutLines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith("provider"));
  if (stdoutLines.length > 0) {
    return stdoutLines[0];
  }
  return `pi exited with code ${result.exitCode}.`;
}

export function normalizeStudioLocalPiModelId(rawModelId: string): string {
  const trimmed = String(rawModelId || "").trim();
  if (!trimmed) {
    return "";
  }

  const parsed = parseCanonicalId(trimmed);
  if (parsed) {
    const provider = String(parsed.providerId || "").trim().toLowerCase();
    const model = String(parsed.modelId || "").trim();
    if (provider && model) {
      return `${provider}/${model}`;
    }
  }

  const firstSlash = trimmed.indexOf("/");
  if (firstSlash <= 0 || firstSlash >= trimmed.length - 1) {
    throw new Error(
      `Local (Pi) model "${trimmed}" is invalid. Choose a model in "provider/model" format.`
    );
  }
  const provider = trimmed.slice(0, firstSlash).trim().toLowerCase();
  const model = trimmed.slice(firstSlash + 1).trim();
  if (!provider || !model) {
    throw new Error(
      `Local (Pi) model "${trimmed}" is invalid. Choose a model in "provider/model" format.`
    );
  }
  return `${provider}/${model}`;
}

export async function runStudioPiCommand(
  plugin: SystemSculptPlugin,
  args: string[],
  timeoutMs: number
): Promise<PiCommandResult> {
  if (!Platform.isDesktopApp) {
    throw new Error("Local (Pi) execution is only available on desktop.");
  }

  const cwd = resolvePiCommandCwd(plugin);
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  mergedEnv.PATH = mergeCliPath(String(mergedEnv.PATH || ""));

  return await new Promise<PiCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn("pi", args, {
      cwd,
      env: mergedEnv,
      shell: false,
    });
    try {
      child.stdin?.end();
    } catch {
      // No-op: stdin may already be closed by runtime.
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill failures.
      }
    }, Math.max(100, Math.floor(timeoutMs)));

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function parsePiModelList(stdout: string): PiListedModel[] {
  const entries: PiListedModel[] = [];
  const lines = String(stdout || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    const normalized = line.trim().toLowerCase();
    if (normalized.startsWith("provider") && normalized.includes("model")) {
      continue;
    }
    const columns = line
      .trim()
      .split(/\s{2,}/g)
      .map((column) => column.trim())
      .filter(Boolean);
    if (columns.length < 2) {
      continue;
    }
    const provider = String(columns[0] || "").trim().toLowerCase();
    const model = String(columns[1] || "").trim();
    if (!provider || !model) {
      continue;
    }
    entries.push({
      provider,
      model,
      context: String(columns[2] || "").trim(),
      maxOut: String(columns[3] || "").trim(),
      thinking: String(columns[4] || "").trim(),
      images: String(columns[5] || "").trim(),
    });
  }
  return entries;
}

function toModelDescription(model: PiListedModel): string {
  const parts: string[] = [];
  if (model.context) parts.push(`context ${model.context}`);
  if (model.maxOut) parts.push(`max out ${model.maxOut}`);
  if (model.thinking) parts.push(`thinking ${model.thinking}`);
  if (model.images) parts.push(`images ${model.images}`);
  return parts.join(" • ");
}

function extractAssistantMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  const type = String(payload.type || "").trim().toLowerCase();
  if (type === "message_end" || type === "turn_end") {
    const message = payload.message as Record<string, unknown> | undefined;
    if (String(message?.role || "").trim().toLowerCase() === "assistant") {
      return message || null;
    }
    return null;
  }
  if (type === "agent_end") {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index] as Record<string, unknown>;
      if (String(candidate?.role || "").trim().toLowerCase() === "assistant") {
        return candidate;
      }
    }
  }
  return null;
}

function extractAssistantText(message: Record<string, unknown>): string {
  const rawContent = message.content;
  if (!Array.isArray(rawContent)) {
    if (typeof rawContent === "string") {
      return rawContent.trim();
    }
    return "";
  }
  const textParts: string[] = [];
  for (const block of rawContent) {
    if (typeof block === "string") {
      const trimmed = block.trim();
      if (trimmed) {
        textParts.push(trimmed);
      }
      continue;
    }
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    const type = String(record.type || "").trim().toLowerCase();
    const text = String(record.text || "").trim();
    if (text && (!type || type === "text")) {
      textParts.push(text);
    }
  }
  return textParts.join("\n\n").trim();
}

function extractAssistantError(message: Record<string, unknown>): string | null {
  const explicit = String(message.errorMessage || "").trim();
  if (explicit) {
    return explicit;
  }
  const stopReason = String(message.stopReason || "").trim().toLowerCase();
  if (stopReason === "error") {
    return "Local (Pi) returned an error.";
  }
  return null;
}

function parsePiOutput(stdout: string): PiOutputSnapshot {
  let lastText = "";
  let lastError: string | null = null;
  const lines = String(stdout || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) {
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = extractAssistantMessage(payload);
    if (!message) {
      const type = String(payload.type || "").trim().toLowerCase();
      if (type === "error") {
        const errorMessage = String(payload.message || "").trim();
        if (errorMessage) {
          lastError = errorMessage;
        }
      }
      continue;
    }
    const text = extractAssistantText(message);
    if (text) {
      lastText = text;
    }
    const errorMessage = extractAssistantError(message);
    if (errorMessage) {
      lastError = errorMessage;
    }
  }
  return {
    text: lastText,
    errorMessage: lastError,
  };
}

export async function listStudioLocalTextModelOptions(
  plugin: SystemSculptPlugin,
  runCommand: StudioPiCommandRunner = runStudioPiCommand
): Promise<StudioLocalTextModelOption[]> {
  const result = await runCommand(plugin, ["--list-models"], PI_MODEL_LIST_TIMEOUT_MS);
  if (result.timedOut) {
    throw new Error("Timed out while loading Local (Pi) models.");
  }
  if (result.exitCode !== 0) {
    throw new Error(summarizePiCommandError(result));
  }
  const models = parsePiModelList(result.stdout);
  const byValue = new Map<string, StudioLocalTextModelOption>();
  for (const model of models) {
    const value = `${model.provider}/${model.model}`;
    if (byValue.has(value)) {
      continue;
    }
    byValue.set(value, {
      value,
      label: model.model,
      description: toModelDescription(model),
      badge: model.provider,
      keywords: [
        value,
        model.provider,
        model.model,
        model.context,
        model.maxOut,
        model.thinking,
        model.images,
      ].filter((entry) => String(entry || "").trim().length > 0),
    });
  }
  return Array.from(byValue.values()).sort((left, right) => {
    const badgeCompare = left.badge.localeCompare(right.badge);
    if (badgeCompare !== 0) {
      return badgeCompare;
    }
    return left.label.localeCompare(right.label);
  });
}

export async function runStudioLocalPiTextGeneration(options: {
  plugin: SystemSculptPlugin;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
}, runCommand: StudioPiCommandRunner = runStudioPiCommand): Promise<{ text: string; modelId: string }> {
  const modelId = normalizeStudioLocalPiModelId(options.modelId);
  if (!modelId) {
    throw new Error("Local (Pi) text generation requires a model selection.");
  }

  const args = ["--mode", "json", "--print", "--no-session", "--model", modelId];
  const systemPrompt = String(options.systemPrompt || "").trim();
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  args.push(String(options.prompt || ""));

  const result = await runCommand(options.plugin, args, PI_GENERATION_TIMEOUT_MS);
  if (result.timedOut) {
    throw new Error(`Local (Pi) generation timed out for model "${modelId}".`);
  }

  const parsed = parsePiOutput(result.stdout);
  if (result.exitCode !== 0) {
    throw new Error(parsed.errorMessage || summarizePiCommandError(result));
  }
  if (parsed.errorMessage) {
    throw new Error(parsed.errorMessage);
  }
  const text = String(parsed.text || "").trim();
  if (!text) {
    throw new Error(`Local (Pi) generation returned no text for model "${modelId}".`);
  }

  return {
    text,
    modelId,
  };
}
