import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { WebSocketServer } from "ws";
import { extractPluginArtifactId } from "../plugin-artifact-identity.mjs";

/**
 * CLI side of SystemSculptTestDriver/v1.
 *
 * The CLI hosts a localhost WebSocket server and writes a token handshake
 * file into the target plugin folder. The driver inside a development or
 * staging build of the plugin polls for that file and dials out; the plugin
 * never listens on a socket. One session drives one vault.
 */

export const HANDSHAKE_FILE = "e2e-driver.json";
export const PROTOCOL_VERSION = 1;
export const DRIVER_MARKER = "SystemSculptTestDriver/v1";
const WINDOWS_REPLACE_ERROR_CODES = new Set(["EACCES", "EEXIST", "EPERM"]);
const PLUGIN_API_BASE_PATTERN =
  /https?:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d+)?\/api\/plugin\b/gi;
const HANDSHAKE_LOCK_TIMEOUT_MS = 5000;
const HANDSHAKE_LOCK_STALE_MS = 30000;
const HANDSHAKE_LOCK_RETRY_MS = 10;
const handshakeLockWait = new Int32Array(new SharedArrayBuffer(4));
const INCIDENT_SCHEMA_VERSION = "systemsculpt.incident/2";
const INCIDENT_MAX_BYTES = 256 * 1024;
const INCIDENT_REPORT_ID_PATTERN = /^report_(?!0{32}$)[a-f0-9]{32}$/u;
const INCIDENT_TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "report_id",
  "created_at",
  "incident",
  "correlation",
  "grouping",
  "environment",
  "run_summary",
  "run_state",
  "tools",
  "timeline",
  "transport_segments",
  "rendering",
  "resource_samples",
  "capture_quality",
  "privacy",
]);
const INCIDENT_REQUIRED_TOP_LEVEL_KEYS = [
  "schema_version",
  "report_id",
  "created_at",
  "incident",
  "correlation",
  "grouping",
  "environment",
  "run_summary",
  "tools",
  "timeline",
  "transport_segments",
  "resource_samples",
  "capture_quality",
  "privacy",
];
const INCIDENT_REQUIRED_KEYS = [
  "classification",
  "impact",
  "outcome",
  "severity_text",
  "severity_number",
  "failure_authority",
  "origin",
  "terminal_evidence",
  "artifact_integrity",
  "evidence_scope",
  "causal_assessment",
  "observation_source",
  "failure_stage",
  "failure_mechanism",
];
const INCIDENT_OPTIONAL_KEYS = [
  "incident_id",
  "failure_code",
  "retryable",
  "http_status",
];
const INCIDENT_EXCLUDED_DATA_CATEGORIES = [
  "prompt_text",
  "assistant_text",
  "reasoning_text",
  "vault_names",
  "paths_and_filenames",
  "file_contents",
  "tool_arguments_and_results",
  "tool_call_ids",
  "search_queries",
  "urls",
  "provider_and_model_names",
  "license_and_account_data",
  "tokens_and_headers",
  "raw_errors_and_stacks",
  "hostnames_usernames_and_device_ids",
  "conversation_and_request_ids",
];
const INCIDENT_FORBIDDEN_KEYS = new Set([
  "conversation_id",
  "request_id",
  "prompt",
  "prompt_text",
  "assistant_text",
  "reasoning_text",
  "vault_name",
  "path",
  "filename",
  "file_content",
  "tool_arguments",
  "tool_input",
  "tool_output",
  "tool_results",
  "search_query",
  "url",
  "provider",
  "model",
  "license",
  "account",
  "token",
  "headers",
  "raw_error",
  "stack",
  "hostname",
  "username",
  "device_id",
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonStringify(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Incident report validation failed.");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Incident report validation failed.");
  }
  return `{${Object.keys(value).sort(compareText).map((key) =>
    `${JSON.stringify(key)}:${canonicalJsonStringify(value[key])}`).join(",")}}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => allowed.has(key));
}

function incidentStatusClass(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : "not_recorded";
}

function expectedGroupingFingerprint(report) {
  const incident = report.incident;
  const terminalSource = isRecord(report.run_state)
    && typeof report.run_state.terminal_source === "string"
    ? report.run_state.terminal_source
    : "not_recorded";
  return [
    "systemsculpt.failure-contract/1",
    `authority=${incident.failure_authority}`,
    `stage=${incident.failure_stage}`,
    `mechanism=${incident.failure_mechanism}`,
    `failure=${typeof incident.failure_code === "string" ? incident.failure_code : "not_recorded"}`,
    `status=${incidentStatusClass(incident.http_status)}`,
    `terminal=${terminalSource}`,
  ].join("|");
}

function assertIncidentPrivacyShape(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertIncidentPrivacyShape(item);
    return;
  }
  if (typeof value === "string") {
    if (/https?:\/\//iu.test(value) || /^(?:\/|[A-Za-z]:[\\/])/u.test(value)) {
      throw new Error("Incident report privacy validation failed.");
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (INCIDENT_FORBIDDEN_KEYS.has(key)) {
      throw new Error("Incident report privacy validation failed.");
    }
    assertIncidentPrivacyShape(item);
  }
}

function sha256OfText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function boundedForbiddenStrings(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > 32
    || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 1024)
  ) {
    throw new Error("Incident report canaries are invalid.");
  }
  return value;
}

/** Validates canonical, persisted-copy bytes without returning report content. */
export function validateIncidentReportCopy(serialized, { forbiddenStrings = [] } = {}) {
  if (typeof serialized !== "string") throw new Error("Incident report validation failed.");
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes === 0 || bytes > INCIDENT_MAX_BYTES) {
    throw new Error("Incident report validation failed.");
  }
  let report;
  try {
    report = JSON.parse(serialized);
  } catch {
    throw new Error("Incident report validation failed.");
  }
  if (!isRecord(report) || canonicalJsonStringify(report) !== serialized) {
    throw new Error("Incident report is not canonical JSON.");
  }
  if (
    report.schema_version !== INCIDENT_SCHEMA_VERSION
    || typeof report.report_id !== "string"
    || !INCIDENT_REPORT_ID_PATTERN.test(report.report_id)
    || !INCIDENT_REQUIRED_TOP_LEVEL_KEYS.every((key) => Object.hasOwn(report, key))
    || Object.keys(report).some((key) => !INCIDENT_TOP_LEVEL_KEYS.has(key))
  ) {
    throw new Error("Incident report schema validation failed.");
  }
  const incident = report.incident;
  if (
    !hasExactKeys(incident, INCIDENT_REQUIRED_KEYS, INCIDENT_OPTIONAL_KEYS)
    || incident.classification !== "operation_failure"
    || incident.impact !== "run_failed"
    || incident.outcome !== "failed"
    || incident.severity_text !== "ERROR"
    || incident.severity_number !== 17
    || incident.failure_authority !== "server"
    || incident.origin !== "agent_terminal"
    || incident.terminal_evidence !== "server_protocol_validated"
    || incident.artifact_integrity !== "unauthenticated_client_record"
    || incident.evidence_scope !== "client_observation_only"
    || incident.causal_assessment !== "not_established"
    || incident.observation_source !== "server_protocol_terminal"
    || incident.failure_stage !== "response_terminal"
    || incident.failure_mechanism !== "service_terminal"
    || typeof incident.failure_code !== "string"
    || !/^[a-z0-9_]{1,128}$/u.test(incident.failure_code)
    || incident.retryable !== true
  ) {
    throw new Error("Incident report terminal evidence is invalid.");
  }
  const grouping = report.grouping;
  if (
    !hasExactKeys(grouping, ["strategy", "fingerprint"])
    || grouping.strategy !== "systemsculpt.failure-contract/1"
    || grouping.fingerprint !== expectedGroupingFingerprint(report)
  ) {
    throw new Error("Incident report grouping evidence is invalid.");
  }
  const privacy = report.privacy;
  if (
    !hasExactKeys(privacy, [
      "policy",
      "policy_version",
      "capture_implementation_version",
      "storage_target",
      "host_sync",
      "automatic_upload",
      "excluded_data_categories",
    ])
    || privacy.policy !== "strict_allowlist_content_free"
    || privacy.policy_version !== "systemsculpt.incident-privacy/1"
    || privacy.capture_implementation_version !== "agent-incident-recorder/1"
    || privacy.storage_target !== "vault_local"
    || privacy.host_sync !== "may_sync_with_vault"
    || privacy.automatic_upload !== false
    || !Array.isArray(privacy.excluded_data_categories)
    || privacy.excluded_data_categories.length !== INCIDENT_EXCLUDED_DATA_CATEGORIES.length
    || privacy.excluded_data_categories.some((item, index) =>
      item !== INCIDENT_EXCLUDED_DATA_CATEGORIES[index])
  ) {
    throw new Error("Incident report privacy validation failed.");
  }
  const rendering = report.rendering;
  if (
    !isRecord(rendering)
    || !isRecord(rendering.before_terminal_publish)
    || !isRecord(rendering.after_terminal_commit)
    || rendering.failure_surface_dom_committed !== true
    || rendering.failure_surface_paint_opportunity_observed !== true
    || rendering.after_terminal_commit.first_dom_commit_observed !== true
    || rendering.after_terminal_commit.first_paint_opportunity_observed !== true
  ) {
    throw new Error("Incident report rendering evidence is incomplete.");
  }
  const captureQuality = report.capture_quality;
  if (!isRecord(captureQuality) || captureQuality.report_bytes !== bytes) {
    throw new Error("Incident report byte accounting is invalid.");
  }
  const partialOutput = isRecord(report.run_summary)
    ? report.run_summary.partial_output
    : null;
  if (
    !isRecord(partialOutput)
    || !Number.isInteger(partialOutput.assistant_text_part_count)
    || partialOutput.assistant_text_part_count < 1
    || !Number.isInteger(partialOutput.assistant_text_character_count)
    || partialOutput.assistant_text_character_count < 1
  ) {
    throw new Error("Incident report partial-output evidence is incomplete.");
  }
  assertIncidentPrivacyShape(report);
  for (const canary of boundedForbiddenStrings(forbiddenStrings)) {
    if (serialized.includes(canary) || serialized.includes(sha256OfText(canary))) {
      throw new Error("Incident report contains a private canary.");
    }
  }
  return {
    reportId: report.report_id,
    bytes,
    sha256: sha256OfText(serialized),
  };
}

export function runObsidianPluginReload({ pluginId, vault, timeoutMs = 30000 }) {
  if (
    typeof pluginId !== "string"
    || !/^[a-z0-9-]{1,128}$/u.test(pluginId)
    || typeof vault !== "string"
    || vault.length === 0
    || vault.length > 256
    || /[\r\n\0]/u.test(vault)
  ) {
    return Promise.reject(new Error("The Obsidian reload target is invalid."));
  }
  return new Promise((resolve, reject) => {
    execFile(
      "obsidian",
      ["plugin:reload", `id=${pluginId}`, `vault=${vault}`],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (error) => error
        ? reject(new Error("The Obsidian plugin reload command failed."))
        : resolve(),
    );
  });
}

function temporarySibling(filePath, kind) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${kind}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
}

function withHandshakeFileLock(filePath, operation) {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } catch (error) {
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.rmSync(lockPath, { force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = fs.lstatSync(lockPath);
        if (Date.now() - lock.mtimeMs >= HANDSHAKE_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - startedAt >= HANDSHAKE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring handshake lock: ${lockPath}`);
      }
      Atomics.wait(handshakeLockWait, 0, 0, HANDSHAKE_LOCK_RETRY_MS);
    }
  }

  const owned = fs.fstatSync(descriptor);
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      const current = fs.lstatSync(lockPath);
      if (current.dev === owned.dev && current.ino === owned.ino) {
        fs.unlinkSync(lockPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

/** Atomically installs a private regular handshake without following an old symlink. */
export function writeHandshakeFileAtomically(filePath, handshake) {
  return withHandshakeFileLock(filePath, () => {
    const tempPath = temporarySibling(filePath, "tmp");
    let backupPath = null;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(handshake, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.chmodSync(tempPath, 0o600);
      try {
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        const replaceOnWindows = process.platform === "win32"
          && WINDOWS_REPLACE_ERROR_CODES.has(error?.code)
          && fs.existsSync(filePath);
        if (!replaceOnWindows) throw error;

        const existing = fs.lstatSync(filePath);
        if (!existing.isFile() && !existing.isSymbolicLink()) {
          throw new Error(`Handshake target must be a regular file or symlink: ${filePath}`);
        }
        backupPath = temporarySibling(filePath, "backup");
        fs.renameSync(filePath, backupPath);
        try {
          fs.renameSync(tempPath, filePath);
        } catch (replacementError) {
          try {
            fs.renameSync(backupPath, filePath);
            backupPath = null;
          } catch (restoreError) {
            throw new AggregateError(
              [replacementError, restoreError],
              `Could not replace ${filePath}; the previous handshake remains at ${backupPath}.`,
            );
          }
          throw replacementError;
        }
        fs.rmSync(backupPath, { force: true });
        backupPath = null;
      }

      const installed = fs.lstatSync(filePath);
      if (!installed.isFile() || installed.isSymbolicLink()) {
        throw new Error(`Handshake must be a regular file: ${filePath}`);
      }
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  });
}

/** Removes only the handshake written by this session, never a newer session's file. */
export function removeOwnedHandshakeFile(filePath, { serverId, token }) {
  return withHandshakeFileLock(filePath, () => {
    try {
      const before = fs.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink()) return false;
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (value?.serverId !== serverId || value?.token !== token) return false;
      const after = fs.lstatSync(filePath);
      if (before.dev !== after.dev || before.ino !== after.ino) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
}

export function resolvePluginTarget({
  root = process.cwd(),
  explicitPath = "",
  vaultName = "",
} = {}) {
  if (explicitPath) {
    return { path: path.resolve(explicitPath), vault: path.basename(explicitPath) };
  }
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${configPath}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Pass --plugin-dir <path-to-vault-plugin-folder> instead.",
    );
  }
  const targets = Array.isArray(parsed?.pluginTargets) ? parsed.pluginTargets : [];
  const normalized = targets
    .map((entry) => typeof entry === "string" ? { path: entry, vault: path.basename(entry) } : entry)
    .filter((entry) => entry && typeof entry.path === "string" && entry.path.length > 0);
  if (normalized.length === 0) {
    throw new Error("systemsculpt-sync.config.json has no pluginTargets; pass --plugin-dir.");
  }
  if (vaultName) {
    const match = normalized.find((entry) => entry.vault === vaultName);
    if (!match) {
      const known = normalized.map((entry) => entry.vault ?? entry.path).join(", ");
      throw new Error(`No pluginTarget named "${vaultName}". Known targets: ${known}.`);
    }
    return match;
  }
  return normalized[0];
}

export function expectedBuildStampFromTarget(pluginDir) {
  const manifestPath = path.join(pluginDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const id = manifest?.systemsculptDevBuild?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Resolves the immutable identity compiled into the exact installed main.js. */
export function expectedArtifactIdFromTarget(pluginDir) {
  let bundle;
  try {
    bundle = fs.readFileSync(path.join(pluginDir, "main.js"), "utf8");
  } catch {
    throw new Error("Unable to read the installed plugin JavaScript bundle.");
  }
  return extractPluginArtifactId(bundle);
}

/** Resolves the one API route compiled into the exact installed main.js. */
export function expectedApiBaseUrlFromTarget(pluginDir) {
  const mainPath = path.join(pluginDir, "main.js");
  let bundle;
  try {
    bundle = fs.readFileSync(mainPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read ${mainPath}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const apiBaseUrls = Array.from(new Set(
    (bundle.match(PLUGIN_API_BASE_PATTERN) ?? []).map((value) => value.replace(/\/+$/, "")),
  ));
  if (apiBaseUrls.length !== 1) {
    throw new Error(
      `Expected exactly one compiled SystemSculpt API base in ${mainPath}; found `
        + `${apiBaseUrls.length}: ${apiBaseUrls.join(", ") || "none"}.`,
    );
  }
  return apiBaseUrls[0];
}

function validateStepList(value, section, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} ${section} must be an array of action objects.`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const step = value[index];
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`${label} ${section}[${index}] must be an action object.`);
    }
    if (typeof step.action !== "string" || step.action.trim().length === 0) {
      throw new Error(`${label} ${section}[${index}] requires a non-empty action.`);
    }
    if (step.label !== undefined && typeof step.label !== "string") {
      throw new Error(`${label} ${section}[${index}] label must be a string.`);
    }
    if (
      step.params !== undefined
      && (!step.params || typeof step.params !== "object" || Array.isArray(step.params))
    ) {
      throw new Error(`${label} ${section}[${index}] params must be an object.`);
    }
    return step;
  });
}

/**
 * Normalizes legacy step arrays and cleanup-aware scenario objects.
 *
 * Arrays remain supported so every existing checked-in and ad-hoc scenario
 * keeps working. New scenarios can provide cleanup that the runner guarantees
 * from an outer finally block.
 */
export function validateScenario(value, label = "A scenario") {
  if (Array.isArray(value)) {
    return { steps: validateStepList(value, "steps", label), cleanup: [] };
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an action array or { steps: [...], cleanup: [...] }.`);
  }
  return {
    steps: validateStepList(value.steps, "steps", label),
    cleanup: validateStepList(value.cleanup ?? [], "cleanup", label),
  };
}

/**
 * Resolves every supported ESM scenario shape without silently dropping a
 * separately exported cleanup journey.
 */
export async function scenarioFromModule(module, label = "A scenario module") {
  const exported = module.default ?? module.scenario ?? module.steps;
  const resolvedExport = typeof exported === "function" ? await exported() : exported;
  const resolvedCleanup = typeof module.cleanup === "function"
    ? await module.cleanup()
    : module.cleanup;
  if (resolvedCleanup !== undefined && !Array.isArray(resolvedCleanup)) {
    throw new Error(`${label} cleanup export must resolve to an array of steps.`);
  }
  let scenario = resolvedExport;
  if (resolvedCleanup !== undefined) {
    if (Array.isArray(resolvedExport)) {
      scenario = { steps: resolvedExport, cleanup: resolvedCleanup };
    } else if (resolvedExport && typeof resolvedExport === "object") {
      scenario = {
        ...resolvedExport,
        cleanup: resolvedExport.cleanup === undefined
          ? resolvedCleanup
          : Array.isArray(resolvedExport.cleanup)
            ? [...resolvedExport.cleanup, ...resolvedCleanup]
            : resolvedExport.cleanup,
      };
    }
  }
  return validateScenario(scenario, label);
}

export class DriverSession {
  constructor({
    pluginDir,
    connectTimeoutMs = 20000,
    actionTimeoutMs = 60000,
    reloadPlugin = runObsidianPluginReload,
  }) {
    this.pluginDir = pluginDir;
    this.connectTimeoutMs = connectTimeoutMs;
    this.actionTimeoutMs = actionTimeoutMs;
    this.reloadPlugin = reloadPlugin;
    this.serverId = crypto.randomUUID();
    this.token = crypto.randomUUID();
    this.handshakePath = path.join(pluginDir, HANDSHAKE_FILE);
    this.expectedArtifactId = null;
    this.server = null;
    this.socket = null;
    this.claimedSocket = null;
    this.hello = null;
    this.connectionGeneration = 0;
    this.connectionWaiters = new Set();
    this.nextId = 1;
    this.pending = new Map();
    this.consoleBaseline = null;
    this.incidentBaseline = null;
    this.ownershipReceipt = null;
  }

  async connect() {
    if (!fs.existsSync(this.pluginDir)) {
      throw new Error(`Plugin folder does not exist: ${this.pluginDir}`);
    }
    // Capture executable provenance before granting the live process a socket.
    this.expectedArtifactId = expectedArtifactIdFromTarget(this.pluginDir);
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    const { port } = this.server.address();
    writeHandshakeFileAtomically(this.handshakePath, {
      version: PROTOCOL_VERSION,
      serverId: this.serverId,
      port,
      token: this.token,
      createdAt: new Date().toISOString(),
    });

    this.server.on("connection", (socket) => this.acceptSocket(socket));
    this.hello = await this.waitForConnectionAfter(0, this.connectTimeoutMs);
    return this.hello;
  }

  acceptSocket(socket) {
    socket.on("error", (error) => {
      if (this.socket === socket) this.failPending(error);
    });
    socket.on("close", () => {
      if (this.claimedSocket === socket) this.claimedSocket = null;
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending(new Error("The driver connection closed."));
    });
    if (this.socket || this.claimedSocket) {
      socket.close(1008, "session already connected");
      return;
    }
    this.claimedSocket = socket;
    socket.once("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        this.claimedSocket = null;
        socket.close(1008, "invalid hello");
        return;
      }
      if (
        message?.type !== "hello"
        || message.token !== this.token
        || message.serverId !== this.serverId
        || message.marker !== DRIVER_MARKER
      ) {
        this.claimedSocket = null;
        socket.close(1008, "invalid hello");
        return;
      }
      let expectedArtifactId;
      try {
        expectedArtifactId = expectedArtifactIdFromTarget(this.pluginDir);
      } catch (error) {
        this.claimedSocket = null;
        socket.close(1008, "installed artifact invalid");
        this.failConnectionWaiters(error);
        return;
      }
      this.expectedArtifactId = expectedArtifactId;
      if (message.artifactId !== expectedArtifactId) {
        this.claimedSocket = null;
        socket.close(1008, "loaded artifact mismatch");
        this.failConnectionWaiters(new Error(
          "Loaded plugin executable does not match the installed JavaScript bundle.",
        ));
        return;
      }
      if (this.socket || this.claimedSocket !== socket) {
        socket.close(1008, "session already connected");
        return;
      }
      this.claimedSocket = null;
      this.socket = socket;
      this.hello = message;
      this.connectionGeneration += 1;
      socket.on("message", (data) => this.handleMessage(String(data)));
      for (const waiter of [...this.connectionWaiters]) {
        if (this.connectionGeneration <= waiter.generation) continue;
        this.connectionWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  }

  waitForConnectionAfter(generation, timeoutMs = this.connectTimeoutMs) {
    if (this.socket && this.hello && this.connectionGeneration > generation) {
      return Promise.resolve(this.hello);
    }
    return new Promise((resolve, reject) => {
      const waiter = { generation, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.connectionWaiters.delete(waiter);
        reject(new Error(
          `No driver connected within ${timeoutMs}ms. Is Obsidian running with a `
            + "development or staging build of SystemSculpt AI (the release build excludes the driver)?",
        ));
      }, timeoutMs);
      this.connectionWaiters.add(waiter);
    });
  }

  failConnectionWaiters(error) {
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.connectionWaiters.clear();
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.type !== "result" || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error?.message ?? "The driver reported an unknown error."));
  }

  failPending(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  run(action, params = {}) {
    if (action.startsWith("e2e.")) return this.runHarnessAction(action, params);
    return this.runRemote(action, params);
  }

  runRemote(action, params = {}) {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("The driver session is not connected."));
    const id = this.nextId;
    this.nextId += 1;
    // A step may declare its own wait budget (waitFor timeoutMs); the session
    // timeout must always outlast it or long waits die at the transport.
    const declaredMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 0;
    const timeoutMs = declaredMs > 0
      ? Math.max(this.actionTimeoutMs, declaredMs + 5000)
      : this.actionTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          if (this.socket === socket) {
            /** @type {import("../../src/testing/driver/protocol").TestDriverActionCancel} */
            const cancellation = { type: "cancel", id };
            socket.send(JSON.stringify(cancellation));
          }
        } catch {
          // The timeout remains authoritative if cancellation cannot be sent.
        }
        reject(new Error(`Driver action "${action}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type: "action", id, action, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async runHarnessAction(action, params) {
    switch (action) {
      case "e2e.console.baseline": {
        const logs = await this.runRemote("logs", { level: "error", limit: 2000 });
        this.consoleBaseline = {
          generation: this.connectionGeneration,
          lastSeq: typeof logs?.lastSeq === "number" ? logs.lastSeq : 0,
        };
        return { baselined: true, connectionGeneration: this.connectionGeneration };
      }
      case "e2e.console.assertNoErrors":
        return this.assertNoConsoleErrors();
      case "e2e.incident.captureCopiedReport": {
        const copy = await this.runRemote("chat.readCopiedIncidentReport");
        if (!isRecord(copy) || typeof copy.serialized !== "string") {
          throw new Error("The incident copy bridge returned invalid data.");
        }
        const metadata = validateIncidentReportCopy(copy.serialized, {
          forbiddenStrings: boundedForbiddenStrings(params.forbiddenStrings),
        });
        if (copy.reportId !== metadata.reportId) {
          throw new Error("The incident copy bridge returned inconsistent identity.");
        }
        this.incidentBaseline = copy.serialized;
        return { captured: true, ...metadata, sha256: `sha256:${metadata.sha256}` };
      }
      case "e2e.incident.assertCopiedReportExact": {
        if (typeof this.incidentBaseline !== "string") {
          throw new Error("No incident report copy baseline exists.");
        }
        const copy = await this.runRemote("chat.readCopiedIncidentReport");
        if (!isRecord(copy) || typeof copy.serialized !== "string") {
          throw new Error("The incident copy bridge returned invalid data.");
        }
        const metadata = validateIncidentReportCopy(copy.serialized, {
          forbiddenStrings: boundedForbiddenStrings(params.forbiddenStrings),
        });
        if (
          copy.reportId !== metadata.reportId
          || copy.serialized !== this.incidentBaseline
        ) {
          throw new Error("The incident report copy changed across plugin reload.");
        }
        return {
          exact: true,
          reportId: metadata.reportId,
          bytes: metadata.bytes,
          sha256: `sha256:${metadata.sha256}`,
        };
      }
      case "e2e.plugin.reloadOwnedDevelopmentChat":
        return this.reloadOwnedDevelopmentChat(params);
      case "e2e.chat.resetOwnedDevelopmentState":
        return this.resetOwnedDevelopmentState(params);
      default:
        throw new Error(`Unknown E2E harness action "${action}".`);
    }
  }

  async assertNoConsoleErrors() {
    if (!this.consoleBaseline) throw new Error("No console error baseline exists.");
    const sinceSeq = this.consoleBaseline.generation === this.connectionGeneration
      ? this.consoleBaseline.lastSeq
      : 0;
    const logs = await this.runRemote("logs", {
      level: "error",
      sinceSeq,
      limit: 2000,
    });
    const entries = Array.isArray(logs?.entries) ? logs.entries : [];
    const dropped = typeof logs?.dropped === "number" ? logs.dropped : 0;
    if (entries.length !== 0 || dropped !== 0) {
      throw new Error("The workflow added one or more console errors.");
    }
    return { exact: true, addedConsoleErrors: 0 };
  }

  async reloadOwnedDevelopmentChat(params) {
    await this.assertNoConsoleErrors();
    const receipt = await this.runRemote("chat.exportDevelopmentOwnershipReceipt");
    if (!isRecord(receipt)) throw new Error("The development ownership receipt is invalid.");
    this.ownershipReceipt = receipt;
    const previousHello = this.hello;
    const previousGeneration = this.connectionGeneration;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(this.pluginDir, "manifest.json"), "utf8"));
    } catch {
      throw new Error("The installed plugin manifest is unavailable for reload.");
    }
    const pluginId = typeof manifest?.id === "string" ? manifest.id : "";
    const vault = typeof previousHello?.vault === "string" ? previousHello.vault : "";
    const timeoutMs = typeof params.timeoutMs === "number"
      ? Math.max(1000, Math.min(params.timeoutMs, 120000))
      : 30000;
    await this.reloadPlugin({ pluginId, vault, timeoutMs });
    const hello = await this.waitForConnectionAfter(previousGeneration, timeoutMs);
    if (
      !previousHello
      || hello.artifactId !== previousHello.artifactId
      || hello.buildStamp !== previousHello.buildStamp
      || hello.pluginVersion !== previousHello.pluginVersion
      || hello.apiBaseUrl !== previousHello.apiBaseUrl
      || hello.vault !== previousHello.vault
    ) {
      throw new Error("The reloaded plugin identity changed.");
    }
    this.consoleBaseline = {
      generation: this.connectionGeneration,
      lastSeq: 0,
    };
    await this.runRemote("chat.open");
    await this.runRemote("chat.importDevelopmentOwnershipReceipt", {
      receipt: this.ownershipReceipt,
    });
    this.ownershipReceipt = null;
    return {
      reloaded: true,
      exactPluginIdentityPreserved: true,
      developmentOwnershipRestored: true,
    };
  }

  async resetOwnedDevelopmentState(params) {
    const timeoutMs = typeof params.timeoutMs === "number"
      ? Math.max(1000, Math.min(params.timeoutMs, 120000))
      : 30000;
    if (!this.socket) {
      await this.waitForConnectionAfter(this.connectionGeneration, timeoutMs);
    }
    if (this.ownershipReceipt) {
      await this.runRemote("chat.importDevelopmentOwnershipReceipt", {
        receipt: this.ownershipReceipt,
      });
      this.ownershipReceipt = null;
    }
    const { timeoutMs: _ignored, ...cleanupParams } = params;
    return this.runRemote("chat.resetDevelopmentState", cleanupParams);
  }

  close() {
    this.incidentBaseline = null;
    this.ownershipReceipt = null;
    this.consoleBaseline = null;
    this.failConnectionWaiters(new Error("The driver session closed."));
    try {
      if (this.socket) this.socket.close(1000, "session complete");
    } catch {
      // Socket may already be closed.
    }
    try {
      if (this.server) this.server.close();
    } catch {
      // Server may already be closed.
    }
    try {
      removeOwnedHandshakeFile(this.handshakePath, {
        serverId: this.serverId,
        token: this.token,
      });
    } catch {
      // Handshake cleanup is best-effort.
    }
  }
}

/**
 * Captures what the app can still say about a failure, at the moment it fails.
 *
 * Without this, a failed step reports only its own timeout text, and
 * diagnosing it means re-running separate log and notice commands against an
 * app whose state has already moved on. Best-effort by design: a diagnostics
 * failure must never replace the original error.
 */
async function captureFailureDiagnostics(session) {
  const diagnostics = {};
  const collect = async (key, action, params) => {
    try { diagnostics[key] = await session.run(action, params); }
    catch (error) {
      diagnostics[`${key}Error`] = error instanceof Error ? error.message : String(error);
    }
  };
  await collect("logs", "logs", { level: "warn", limit: 40 });
  await collect("notices", "notices", { limit: 20 });
  await collect("chat", "snapshot", { scope: "chat" });
  return diagnostics;
}

export async function runSteps(session, steps) {
  const results = [];
  let failed = false;
  let blocked = false;
  let diagnostics = null;
  for (const [index, step] of steps.entries()) {
    const label = step.label ?? `${index + 1}. ${step.action}`;
    if (blocked && step.resumeAfterFailure !== true) {
      results.push({ label, action: step.action, skipped: true });
      continue;
    }
    if (step.resumeAfterFailure === true) blocked = false;
    const startedAt = Date.now();
    try {
      const result = await session.run(step.action, step.params ?? {});
      results.push({ label, action: step.action, ok: true, ms: Date.now() - startedAt, result });
    } catch (error) {
      failed = true;
      blocked = true;
      const failedStep = {
        label,
        action: step.action,
        ok: false,
        ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(failedStep);
      const failureDiagnostics = await captureFailureDiagnostics(session);
      failedStep.diagnostics = failureDiagnostics;
      diagnostics ??= failureDiagnostics;
    }
  }
  return { ok: !failed, steps: results, ...(diagnostics ? { diagnostics } : {}) };
}

async function runCleanupSteps(session, steps) {
  const results = [];
  let failed = false;
  for (const [index, step] of steps.entries()) {
    const label = step.label ?? `cleanup ${index + 1}. ${step.action}`;
    const startedAt = Date.now();
    try {
      const result = await session.run(step.action, step.params ?? {});
      results.push({ label, action: step.action, ok: true, ms: Date.now() - startedAt, result });
    } catch (error) {
      failed = true;
      results.push({
        label,
        action: step.action,
        ok: false,
        ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: !failed, steps: results };
}

/** Runs cleanup exactly once even when the primary runner throws unexpectedly. */
export async function runScenario(session, value) {
  const scenario = validateScenario(value);
  let outcome;
  let cleanupOutcome = { ok: true, steps: [] };
  try {
    outcome = await runSteps(session, scenario.steps);
  } finally {
    cleanupOutcome = await runCleanupSteps(session, scenario.cleanup);
  }
  return {
    ...outcome,
    ok: outcome.ok && cleanupOutcome.ok,
    cleanup: cleanupOutcome.steps,
  };
}
