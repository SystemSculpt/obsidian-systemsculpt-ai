import { Platform } from "obsidian";
import { spawn } from "node:child_process";
import type { StreamEvent } from "../../streaming/types";
import type SystemSculptPlugin from "../../main";
import {
  appendStudioPiOutput as appendOutput,
  isLikelyMissingStudioPiExecutableError,
  mergeStudioPiCliPath as mergeCliPath,
} from "../../studio/piAuth/StudioPiProcessUtils";
import { buildStudioPiLoginCommand } from "../../studio/piAuth/StudioPiAuthStorage";
import { parseCanonicalId } from "../../utils/modelUtils";
import {
  runPiCommandWithResolvedRuntime,
  resolvePiRuntimes,
  startPiProcess as startResolvedPiProcess,
} from "./PiProcessRuntime";
import {
  buildStudioPiApiKeyEnvCommand,
  buildStudioPiDesktopLoginWindowLaunch,
  buildStudioPiShellInvocationCommand,
  getStudioPiAuthStoragePathHint,
  getStudioPiDesktopShellLabel,
} from "./PiDesktopSetupUtils";
import { ensureBundledPiRuntime } from "./PiRuntimeBootstrap";

export {
  buildStudioPiLoginCommand,
  clearStudioPiProviderAuth,
  listStudioPiOAuthProviders,
  listStudioPiProviderAuthRecords,
  loginStudioPiProviderOAuth,
  migrateStudioPiProviderApiKeys,
  readStudioPiProviderAuthState,
  setStudioPiProviderApiKey,
} from "../../studio/piAuth/StudioPiAuthStorage";

export type {
  StudioPiApiKeyMigrationCandidate,
  StudioPiApiKeyMigrationEntry,
  StudioPiApiKeyMigrationReason,
  StudioPiApiKeyMigrationReport,
  StudioPiAuthCredentialType,
  StudioPiAuthInfo,
  StudioPiAuthPrompt,
  StudioPiAuthState,
  StudioPiOAuthLoginOptions,
  StudioPiOAuthProvider,
  StudioPiProviderAuthRecord,
} from "../../studio/piAuth/StudioPiAuthStorage";

export type PiCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type StudioPiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiCommandRunner = (
  plugin: SystemSculptPlugin,
  args: string[],
  timeoutMs: number
) => Promise<PiCommandResult>;
export type StudioPiCommandRunner = PiCommandRunner;

type PiOutputSnapshot = {
  text: string;
  errorMessage: string | null;
};

type StreamQueueItem =
  | { kind: "event"; event: StreamEvent }
  | { kind: "done" }
  | { kind: "error"; error: Error };

const PI_MODEL_LIST_TIMEOUT_MS = 60_000;
const PI_GENERATION_TIMEOUT_MS = 300_000;
const PI_GENERATION_MAX_ATTEMPTS = 2;
const PI_TERMINAL_LAUNCH_TIMEOUT_MS = 20_000;
const LOCAL_PI_PROVIDER_PREFIX = "local-pi-";

function normalizePiThinkingLevel(rawValue: unknown): StudioPiThinkingLevel | undefined {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return undefined;
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
      // Ignore cwd lookup failures and fall through to root.
    }
  }
  return "/";
}

async function spawnPiCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<PiCommandResult> {
  return await new Promise<PiCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });

    try {
      child.stdin?.end();
    } catch {
      // No-op: stdin may already be closed.
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill failures.
      }
    }, Math.max(100, Math.floor(options.timeoutMs)));

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

function summarizeCommandFailure(command: string, result: PiCommandResult): string {
  const stderr = String(result.stderr || "").trim();
  if (stderr) {
    const first = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    return first || stderr;
  }
  const stdout = String(result.stdout || "").trim();
  if (stdout) {
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    return first || stdout;
  }
  return `${command} exited with code ${result.exitCode}.`;
}

function summarizePiCommandError(result: PiCommandResult): string {
  const stderr = String(result.stderr || "").trim();
  if (stderr) {
    const lines = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const errorLine = lines.find((line) => /^error:\s*/i.test(line));
    if (errorLine) {
      const message = errorLine.replace(/^error:\s*/i, "").trim();
      if (message) {
        const followup = lines.find((line) => /^use\s+\/login/i.test(line));
        return followup ? `${message}\n${followup}` : message;
      }
      return errorLine;
    }
    const usefulLine = lines.find((line) => {
      if (line.startsWith("at ")) return false;
      if (/^file:\/\/.+:\d+/.test(line)) return false;
      if (line.startsWith("^")) return false;
      return true;
    });
    return usefulLine || lines[0] || stderr;
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

function extractAssistantMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  const type = String(payload.type || "").trim().toLowerCase();
  if (type === "message_update" || type === "message_end" || type === "turn_end") {
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
    return typeof rawContent === "string" ? rawContent.trim() : "";
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
  return stopReason === "error" ? "Local (Pi) returned an error." : null;
}

function extractAssistantUpdate(payload: Record<string, unknown>): {
  appendText?: string;
  replaceText?: string;
  errorMessage?: string;
} | null {
  const type = String(payload.type || "").trim().toLowerCase();
  if (type !== "message_update") {
    return null;
  }
  const event =
    payload.assistantMessageEvent && typeof payload.assistantMessageEvent === "object"
      ? (payload.assistantMessageEvent as Record<string, unknown>)
      : null;
  if (!event) {
    return null;
  }

  const updateType = String(event.type || "").trim().toLowerCase();
  if (updateType === "text_delta") {
    const delta = String(event.delta || "");
    return delta ? { appendText: delta } : null;
  }
  if (updateType === "text_end") {
    const content = String(event.content || "");
    return content ? { replaceText: content } : null;
  }
  const explicitError = String(event.errorMessage || event.message || "").trim();
  return explicitError ? { errorMessage: explicitError } : null;
}

function parsePiOutput(stdout: string): PiOutputSnapshot {
  let lastText = "";
  let lastError: string | null = null;
  let streamedText = "";

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

    const update = extractAssistantUpdate(payload);
    if (update?.replaceText) {
      streamedText = update.replaceText;
    } else if (update?.appendText) {
      streamedText += update.appendText;
    }
    if (update?.errorMessage) {
      lastError = update.errorMessage;
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
    text: lastText || streamedText.trim(),
    errorMessage: lastError,
  };
}

function buildPiTextCommandArgs(options: {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  reasoningEffort?: StudioPiThinkingLevel;
}): string[] {
  const args = ["--mode", "json", "--print", "--no-session", "--model", options.modelId];
  const thinkingLevel = normalizePiThinkingLevel(options.reasoningEffort);
  if (thinkingLevel) {
    args.push("--thinking", thinkingLevel);
  }
  const systemPrompt = String(options.systemPrompt || "").trim();
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  args.push(String(options.prompt || ""));
  return args;
}

function createPiCommandEnv(): Record<string, string> {
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  mergedEnv.PATH = mergeCliPath(String(mergedEnv.PATH || ""));
  return mergedEnv;
}

export function normalizeLocalPiExecutionModelId(rawModelId: string): string {
  const trimmed = String(rawModelId || "").trim();
  if (!trimmed) {
    return "";
  }

  const parsed = parseCanonicalId(trimmed);
  if (parsed) {
    const provider = String(parsed.providerId || "")
      .trim()
      .toLowerCase()
      .replace(new RegExp(`^${LOCAL_PI_PROVIDER_PREFIX}`), "");
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

export async function runPiCommand(
  plugin: SystemSculptPlugin,
  args: string[],
  timeoutMs: number
): Promise<PiCommandResult> {
  const result = await runPiCommandWithResolvedRuntime({
    plugin,
    args,
    timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

export async function buildStudioPiTerminalLoginCommand(
  plugin: SystemSculptPlugin,
  providerHint: string
): Promise<string> {
  await ensureBundledPiRuntime({ plugin });
  const fallbackCommand = buildStudioPiLoginCommand(providerHint);
  const loginArgs = fallbackCommand
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(1);
  const env = createPiCommandEnv();
  const runtimes = resolvePiRuntimes(env);
  const runtime = runtimes.find((entry) => entry.source === "local-package") || runtimes[0];
  if (!runtime) {
    return fallbackCommand;
  }

  return buildStudioPiShellInvocationCommand({
    platform: process.platform,
    command: runtime.command,
    args: [...runtime.argsPrefix, ...loginArgs],
    envAssignments: runtime.env?.ELECTRON_RUN_AS_NODE === "1"
      ? { ELECTRON_RUN_AS_NODE: "1" }
      : {},
  });
}

export async function installLocalPiCli(plugin: SystemSculptPlugin): Promise<{ version: string }> {
  if (!Platform.isDesktopApp) {
    throw new Error("Local (Pi) installation is only available on desktop.");
  }

  await ensureBundledPiRuntime({ plugin });

  const versionResult = await runPiCommand(plugin, ["--version"], PI_MODEL_LIST_TIMEOUT_MS);
  if (versionResult.timedOut) {
    throw new Error("Bundled Pi runtime is present, but version verification timed out.");
  }
  if (versionResult.exitCode !== 0) {
    throw new Error(`Bundled Pi runtime verification failed: ${summarizePiCommandError(versionResult)}`);
  }

  const version =
    String(versionResult.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || "unknown";

  return { version };
}

export async function launchPiProviderLoginInTerminal(
  plugin: SystemSculptPlugin,
  providerHint: string
): Promise<void> {
  if (!Platform.isDesktopApp) {
    throw new Error("Launching Pi login is only available on desktop.");
  }

  const loginCommand = await buildStudioPiTerminalLoginCommand(plugin, providerHint);
  const cwd = resolvePiCommandCwd(plugin);
  const mergedEnv = createPiCommandEnv();
  const launch = buildStudioPiDesktopLoginWindowLaunch({
    platform: process.platform,
    cwd,
    shellCommand: loginCommand,
  });

  if (!launch) {
    throw new Error(
      `Automatic Pi login launch is currently only implemented for macOS and Windows desktop shells. Run this command in your terminal: ${loginCommand}`
    );
  }

  const result = await spawnPiCommand({
    command: launch.command,
    args: launch.args,
    cwd,
    env: mergedEnv,
    timeoutMs: PI_TERMINAL_LAUNCH_TIMEOUT_MS,
  });
  if (result.timedOut) {
    throw new Error(`Timed out while launching ${launch.appLabel} for Pi login.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Failed to launch ${launch.appLabel} for Pi login: ${summarizeCommandFailure(launch.command, result)}`);
  }
}

export async function runLocalPiTextGeneration(options: {
  plugin: SystemSculptPlugin;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  reasoningEffort?: StudioPiThinkingLevel;
}, runCommand: PiCommandRunner = runPiCommand): Promise<{ text: string; modelId: string }> {
  const modelId = normalizeLocalPiExecutionModelId(options.modelId);
  if (!modelId) {
    throw new Error("Local (Pi) text generation requires a model selection.");
  }

  const args = buildPiTextCommandArgs({
    modelId,
    prompt: options.prompt,
    systemPrompt: options.systemPrompt,
    reasoningEffort: options.reasoningEffort,
  });

  for (let attempt = 1; attempt <= PI_GENERATION_MAX_ATTEMPTS; attempt += 1) {
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
    if (text) {
      return { text, modelId };
    }

    if (attempt >= PI_GENERATION_MAX_ATTEMPTS) {
      throw new Error(`Local (Pi) generation returned no text for model "${modelId}".`);
    }
  }

  throw new Error(`Local (Pi) generation returned no text for model "${modelId}".`);
}

export async function* streamLocalPiTextGeneration(options: {
  plugin: SystemSculptPlugin;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  reasoningEffort?: StudioPiThinkingLevel;
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent, void, unknown> {
  const modelId = normalizeLocalPiExecutionModelId(options.modelId);
  if (!modelId) {
    throw new Error("Local (Pi) text generation requires a model selection.");
  }
  if (!Platform.isDesktopApp) {
    throw new Error("Local (Pi) execution is only available on desktop.");
  }

  const cwd = resolvePiCommandCwd(options.plugin);
  const env = createPiCommandEnv();
  const args = buildPiTextCommandArgs({
    modelId,
    prompt: options.prompt,
    systemPrompt: options.systemPrompt,
    reasoningEffort: options.reasoningEffort,
  });

  const { child } = await startResolvedPiProcess({
    plugin: options.plugin,
    args,
    cwd,
    env,
  });

  const queue: StreamQueueItem[] = [];
  let waitingResolver: ((item: StreamQueueItem) => void) | null = null;
  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let streamedText = "";
  let aborted = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const push = (item: StreamQueueItem) => {
    if (waitingResolver) {
      const resolve = waitingResolver;
      waitingResolver = null;
      resolve(item);
      return;
    }
    queue.push(item);
  };

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  };

  const emitDelta = (nextText: string): void => {
    if (!nextText) {
      return;
    }
    push({ kind: "event", event: { type: "content", text: nextText } });
  };

  const handlePiJsonLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const update = extractAssistantUpdate(payload);
    if (update?.errorMessage) {
      push({ kind: "error", error: new Error(update.errorMessage) });
      return;
    }
    if (update?.appendText) {
      streamedText += update.appendText;
      emitDelta(update.appendText);
      return;
    }
    if (update?.replaceText) {
      const replacement = update.replaceText;
      if (replacement.startsWith(streamedText)) {
        emitDelta(replacement.slice(streamedText.length));
      } else if (!streamedText) {
        emitDelta(replacement);
      }
      streamedText = replacement;
      return;
    }

    const message = extractAssistantMessage(payload);
    if (!message) {
      const type = String(payload.type || "").trim().toLowerCase();
      if (type === "error") {
        const messageText = String(payload.message || "").trim();
        if (messageText) {
          push({ kind: "error", error: new Error(messageText) });
        }
      }
      return;
    }

    const text = extractAssistantText(message);
    if (text && text.startsWith(streamedText)) {
      const remaining = text.slice(streamedText.length);
      if (remaining) {
        streamedText = text;
        emitDelta(remaining);
      }
    }
    const errorMessage = extractAssistantError(message);
    if (errorMessage) {
      push({ kind: "error", error: new Error(errorMessage) });
    }
  };

  const onAbort = () => {
    aborted = true;
    try {
      child?.kill("SIGKILL");
    } catch {
      // Ignore child shutdown failures.
    }
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });

  timeoutId = setTimeout(() => {
    try {
      child?.kill("SIGKILL");
    } catch {
      // Ignore kill failures.
    }
    push({ kind: "error", error: new Error(`Local (Pi) generation timed out for model "${modelId}".`) });
  }, PI_GENERATION_TIMEOUT_MS);

  child.stdout.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stdout = appendOutput(stdout, text);
    stdoutBuffer += text;

    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handlePiJsonLine(line);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = appendOutput(stderr, chunk);
  });

  child.on("error", (error) => {
    push({ kind: "error", error });
  });

  child.on("close", (code) => {
    if (stdoutBuffer.trim().length > 0) {
      handlePiJsonLine(stdoutBuffer);
      stdoutBuffer = "";
    }
    cleanup();

    if (aborted || options.signal?.aborted) {
      push({ kind: "done" });
      return;
    }

    const result: PiCommandResult = {
      exitCode: typeof code === "number" ? code : 1,
      stdout,
      stderr,
      timedOut: false,
    };
    const parsed = parsePiOutput(stdout);
    if (parsed.errorMessage) {
      push({ kind: "error", error: new Error(parsed.errorMessage) });
      return;
    }

    if (result.exitCode !== 0) {
      push({ kind: "error", error: new Error(summarizePiCommandError(result)) });
      return;
    }

    const finalText = String(parsed.text || "").trim();
    if (finalText && finalText.startsWith(streamedText)) {
      const trailing = finalText.slice(streamedText.length);
      if (trailing) {
        push({ kind: "event", event: { type: "content", text: trailing } });
      }
    } else if (finalText && !streamedText) {
      push({ kind: "event", event: { type: "content", text: finalText } });
    } else if (!finalText && !streamedText) {
      push({
        kind: "error",
        error: new Error(`Local (Pi) generation returned no text for model "${modelId}".`),
      });
      return;
    }

    push({ kind: "done" });
  });

  while (true) {
    const nextItem =
      queue.length > 0
        ? queue.shift()!
        : await new Promise<StreamQueueItem>((resolve) => {
            waitingResolver = resolve;
          });

    if (nextItem.kind === "event") {
      yield nextItem.event;
      continue;
    }
    if (nextItem.kind === "error") {
      throw nextItem.error;
    }
    return;
  }
}

export const normalizeStudioLocalPiModelId = normalizeLocalPiExecutionModelId;
export const runStudioPiCommand = runPiCommand;
export const installStudioLocalPiCli = installLocalPiCli;
export const buildStudioPiResolvedLoginCommand = buildStudioPiTerminalLoginCommand;
export const launchStudioPiProviderLoginInTerminal = launchPiProviderLoginInTerminal;
export const buildStudioPiApiKeyEnvCommandHint = buildStudioPiApiKeyEnvCommand;
export const getStudioPiAuthStoragePathHintForPlatform = getStudioPiAuthStoragePathHint;
export const getStudioPiLoginSurfaceLabel = getStudioPiDesktopShellLabel;
export const runStudioLocalPiTextGeneration = runLocalPiTextGeneration;
