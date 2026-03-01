import { Platform } from "obsidian";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

export type StudioPiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type StudioPiCommandRunner = (
  plugin: SystemSculptPlugin,
  args: string[],
  timeoutMs: number
) => Promise<PiCommandResult>;

export type StudioPiOAuthProvider = {
  id: string;
  name: string;
  usesCallbackServer: boolean;
};

export type StudioPiAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type StudioPiAuthInfo = {
  url: string;
  instructions?: string;
};

export type StudioPiAuthState = {
  provider: string;
  hasAnyAuth: boolean;
  source: "none" | "oauth" | "api_key" | "environment_or_fallback";
};

export type StudioPiOAuthLoginOptions = {
  providerId: string;
  onAuth: (info: StudioPiAuthInfo) => void;
  onPrompt: (prompt: StudioPiAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
};

type PiOutputSnapshot = {
  text: string;
  errorMessage: string | null;
};

const COMMON_CLI_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin"];
const PI_MODEL_LIST_TIMEOUT_MS = 60_000;
const PI_GENERATION_TIMEOUT_MS = 300_000;
const PI_INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PI_GENERATION_MAX_ATTEMPTS = 2;
const PI_COMMAND_NAME = "pi";
const PI_NPM_PACKAGE = "@mariozechner/pi-coding-agent";
const PI_TERMINAL_LAUNCH_TIMEOUT_MS = 20_000;
const PI_PACKAGE_ROOT_CANDIDATES = [
  "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent",
  "/usr/local/lib/node_modules/@mariozechner/pi-coding-agent",
];
const PI_AUTH_STORAGE_MODULE_RELATIVE = "dist/core/auth-storage.js";

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

function normalizePiProviderHint(rawProvider: unknown): string {
  const normalized = String(rawProvider || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    return "";
  }
  return normalized;
}

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

function isLikelyMissingExecutableError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || "").trim().toUpperCase();
  if (code === "ENOENT") {
    return true;
  }
  const message = String((error as { message?: unknown })?.message || "").trim().toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes("spawn pi enoent") ||
    message.includes("command not found") ||
    message.includes("no such file or directory")
  );
}

function resolvePiAbsoluteCandidates(): string[] {
  const candidates: string[] = [];
  for (const basePath of COMMON_CLI_PATHS) {
    const candidate = `${basePath}/${PI_COMMAND_NAME}`;
    try {
      if (existsSync(candidate)) {
        candidates.push(candidate);
      }
    } catch {
      // Ignore stat/permission issues and continue.
    }
  }
  return candidates;
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
      // No-op: stdin may already be closed by runtime.
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
    if (first) {
      return first;
    }
    return stderr;
  }
  const stdout = String(result.stdout || "").trim();
  if (stdout) {
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first) {
      return first;
    }
    return stdout;
  }
  return `${command} exited with code ${result.exitCode}.`;
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

function quoteShellSingle(value: string): string {
  const normalized = String(value || "");
  if (!normalized) {
    return "''";
  }
  return `'${normalized.replace(/'/g, `'\\''`)}'`;
}

function escapeAppleScriptDoubleQuoted(value: string): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

type StudioPiAuthCredentialRecord = {
  type?: unknown;
};

type StudioPiAuthStorageInstance = {
  getOAuthProviders: () => Array<{
    id: string;
    name: string;
    usesCallbackServer?: boolean;
  }>;
  login: (
    providerId: string,
    callbacks: {
      onAuth: (info: StudioPiAuthInfo) => void;
      onPrompt: (prompt: StudioPiAuthPrompt) => Promise<string>;
      onProgress?: (message: string) => void;
      onManualCodeInput?: () => Promise<string>;
      signal?: AbortSignal;
    }
  ) => Promise<void>;
  set: (provider: string, credential: { type: "api_key"; key: string }) => void;
  remove: (provider: string) => void;
  get: (provider: string) => StudioPiAuthCredentialRecord | undefined;
  hasAuth: (provider: string) => boolean;
};

type StudioPiAuthStorageModule = {
  AuthStorage: {
    create: (authPath?: string) => StudioPiAuthStorageInstance;
  };
};

function resolvePiPackageRoot(): string | null {
  for (const candidate of PI_PACKAGE_ROOT_CANDIDATES) {
    const authStoragePath = `${candidate}/${PI_AUTH_STORAGE_MODULE_RELATIVE}`;
    if (existsSync(authStoragePath)) {
      return candidate;
    }
  }
  return null;
}

async function importPiModule<T>(absolutePath: string): Promise<T> {
  const importFn = new Function("specifier", "return import(specifier);") as (
    specifier: string
  ) => Promise<T>;
  const moduleUrl = `file://${absolutePath}`;
  return await importFn(moduleUrl);
}

async function loadPiAuthStorageModule(): Promise<StudioPiAuthStorageModule> {
  const packageRoot = resolvePiPackageRoot();
  if (!packageRoot) {
    throw new Error("Pi auth module is unavailable. Reinstall @mariozechner/pi-coding-agent.");
  }
  const absolutePath = `${packageRoot}/${PI_AUTH_STORAGE_MODULE_RELATIVE}`;

  // Prefer Electron's window.require (CommonJS) — Obsidian's renderer exposes
  // this and it can load local files, unlike dynamic import() of file:// URLs
  // which Obsidian's security policy blocks.
  const windowRequire = typeof window !== "undefined"
    ? (window as unknown as Record<string, unknown>)?.require
    : undefined;
  if (typeof windowRequire === "function") {
    try {
      return (windowRequire as (path: string) => StudioPiAuthStorageModule)(absolutePath);
    } catch {
      // Fall through to dynamic import if require fails
    }
  }

  return await importPiModule<StudioPiAuthStorageModule>(absolutePath);
}

function normalizeAuthSource(credentialType: unknown, hasAnyAuth: boolean): StudioPiAuthState["source"] {
  if (credentialType === "oauth") {
    return "oauth";
  }
  if (credentialType === "api_key") {
    return "api_key";
  }
  if (hasAnyAuth) {
    return "environment_or_fallback";
  }
  return "none";
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
        if (followup) {
          return `${message}\n${followup}`;
        }
        return message;
      }
      return errorLine;
    }
    const usefulLine = lines.find((line) => {
      if (line.startsWith("at ")) {
        return false;
      }
      if (/^file:\/\/.+:\d+/.test(line)) {
        return false;
      }
      if (line.startsWith("^")) {
        return false;
      }
      return true;
    });
    if (usefulLine) {
      return usefulLine;
    }
    return lines[0] || stderr;
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
  const commandCandidates = [PI_COMMAND_NAME, ...resolvePiAbsoluteCandidates()];
  const attempted = new Set<string>();
  let lastMissingBinaryError: unknown = null;
  for (const command of commandCandidates) {
    if (attempted.has(command)) {
      continue;
    }
    attempted.add(command);
    try {
      return await spawnPiCommand({
        command,
        args,
        cwd,
        env: mergedEnv,
        timeoutMs,
      });
    } catch (error) {
      if (isLikelyMissingExecutableError(error)) {
        lastMissingBinaryError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastMissingBinaryError) {
    throw lastMissingBinaryError;
  }
  throw new Error("Unable to execute pi command.");
}

export async function installStudioLocalPiCli(plugin: SystemSculptPlugin): Promise<{ version: string }> {
  if (!Platform.isDesktopApp) {
    throw new Error("Local (Pi) installation is only available on desktop.");
  }
  const cwd = resolvePiCommandCwd(plugin);
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  mergedEnv.PATH = mergeCliPath(String(mergedEnv.PATH || ""));

  const installResult = await spawnPiCommand({
    command: "npm",
    args: ["install", "-g", PI_NPM_PACKAGE],
    cwd,
    env: mergedEnv,
    timeoutMs: PI_INSTALL_TIMEOUT_MS,
  });
  if (installResult.timedOut) {
    throw new Error("Timed out while installing Local (Pi) CLI with npm.");
  }
  if (installResult.exitCode !== 0) {
    const summary = summarizeCommandFailure("npm", installResult);
    throw new Error(`Failed to install Local (Pi) CLI: ${summary}`);
  }

  const versionResult = await runStudioPiCommand(plugin, ["--version"], PI_MODEL_LIST_TIMEOUT_MS);
  if (versionResult.timedOut) {
    throw new Error("Pi CLI installed, but version verification timed out.");
  }
  if (versionResult.exitCode !== 0) {
    const summary = summarizePiCommandError(versionResult);
    throw new Error(`Pi CLI installed, but version verification failed: ${summary}`);
  }
  const version = String(versionResult.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) || "unknown";
  return { version };
}

export function buildStudioPiLoginCommand(providerHint: string): string {
  const provider = normalizePiProviderHint(providerHint);
  return provider ? `pi /login ${provider}` : "pi /login";
}

export async function listStudioPiOAuthProviders(): Promise<StudioPiOAuthProvider[]> {
  const authStorageModule = await loadPiAuthStorageModule();
  const storage = authStorageModule.AuthStorage.create();
  return storage.getOAuthProviders().map((provider) => ({
    id: String(provider.id || "").trim(),
    name: String(provider.name || provider.id || "").trim(),
    usesCallbackServer: Boolean(provider.usesCallbackServer),
  }))
    .filter((provider) => provider.id.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function loginStudioPiProviderOAuth(options: StudioPiOAuthLoginOptions): Promise<void> {
  const providerId = normalizePiProviderHint(options.providerId);
  if (!providerId) {
    throw new Error("Select a valid provider before starting OAuth login.");
  }
  const authStorageModule = await loadPiAuthStorageModule();
  const storage = authStorageModule.AuthStorage.create();
  // Do not pre-check getOAuthProviders() — its list may be incomplete and
  // would incorrectly block known OAuth providers like openai-codex.
  // Let storage.login() throw naturally if the provider truly doesn't support OAuth.
  await storage.login(providerId, {
    onAuth: (info) => options.onAuth({
      url: String(info?.url || "").trim(),
      instructions: String(info?.instructions || "").trim() || undefined,
    }),
    onPrompt: options.onPrompt,
    onProgress: options.onProgress,
    onManualCodeInput: options.onManualCodeInput,
    signal: options.signal,
  });
}

export async function setStudioPiProviderApiKey(providerHint: string, apiKey: string): Promise<void> {
  const provider = normalizePiProviderHint(providerHint);
  const key = String(apiKey || "").trim();
  if (!provider) {
    throw new Error("Select a valid provider before saving an API key.");
  }
  if (!key) {
    throw new Error("API key cannot be empty.");
  }
  const authStorageModule = await loadPiAuthStorageModule();
  const storage = authStorageModule.AuthStorage.create();
  storage.set(provider, {
    type: "api_key",
    key,
  });
}

export async function clearStudioPiProviderAuth(providerHint: string): Promise<void> {
  const provider = normalizePiProviderHint(providerHint);
  if (!provider) {
    throw new Error("Select a valid provider before clearing credentials.");
  }
  const authStorageModule = await loadPiAuthStorageModule();
  const storage = authStorageModule.AuthStorage.create();
  storage.remove(provider);
}

export async function readStudioPiProviderAuthState(providerHint: string): Promise<StudioPiAuthState> {
  const provider = normalizePiProviderHint(providerHint);
  if (!provider) {
    return {
      provider: "",
      hasAnyAuth: false,
      source: "none",
    };
  }
  const authStorageModule = await loadPiAuthStorageModule();
  const storage = authStorageModule.AuthStorage.create();
  const credentialType = storage.get(provider)?.type;
  const hasAnyAuth = storage.hasAuth(provider);
  return {
    provider,
    hasAnyAuth,
    source: normalizeAuthSource(credentialType, hasAnyAuth),
  };
}

export async function launchStudioPiProviderLoginInTerminal(
  plugin: SystemSculptPlugin,
  providerHint: string
): Promise<void> {
  if (!Platform.isDesktopApp) {
    throw new Error("Launching Pi login is only available on desktop.");
  }

  const loginCommand = buildStudioPiLoginCommand(providerHint);
  const cwd = resolvePiCommandCwd(plugin);
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  mergedEnv.PATH = mergeCliPath(String(mergedEnv.PATH || ""));

  if (process.platform === "darwin") {
    const shellCommand = `cd ${quoteShellSingle(cwd)}; ${loginCommand}`;
    const script = escapeAppleScriptDoubleQuoted(shellCommand);
    const result = await spawnPiCommand({
      command: "osascript",
      args: [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${script}"`,
      ],
      cwd,
      env: mergedEnv,
      timeoutMs: PI_TERMINAL_LAUNCH_TIMEOUT_MS,
    });
    if (result.timedOut) {
      throw new Error("Timed out while launching Terminal for Pi login.");
    }
    if (result.exitCode !== 0) {
      const summary = summarizeCommandFailure("osascript", result);
      throw new Error(`Failed to launch Terminal for Pi login: ${summary}`);
    }
    return;
  }

  throw new Error(
    `Automatic Pi login launch is currently only implemented for macOS Terminal. Run this command in your terminal: ${loginCommand}`
  );
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
  if (explicitError) {
    return { errorMessage: explicitError };
  }
  return null;
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
  reasoningEffort?: StudioPiThinkingLevel;
}, runCommand: StudioPiCommandRunner = runStudioPiCommand): Promise<{ text: string; modelId: string }> {
  const modelId = normalizeStudioLocalPiModelId(options.modelId);
  if (!modelId) {
    throw new Error("Local (Pi) text generation requires a model selection.");
  }

  const args = ["--mode", "json", "--print", "--no-session", "--model", modelId];
  const thinkingLevel = normalizePiThinkingLevel(options.reasoningEffort);
  if (thinkingLevel) {
    args.push("--thinking", thinkingLevel);
  }
  const systemPrompt = String(options.systemPrompt || "").trim();
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  args.push(String(options.prompt || ""));

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
      return {
        text,
        modelId,
      };
    }

    const shouldRetry = attempt < PI_GENERATION_MAX_ATTEMPTS;
    if (!shouldRetry) {
      throw new Error(`Local (Pi) generation returned no text for model "${modelId}".`);
    }
  }

  throw new Error(`Local (Pi) generation returned no text for model "${modelId}".`);
}
