import type { App } from "obsidian";

import { chatContainer } from "./locators";
import {
  type ActionContext,
  DriverActionError,
  type DriverActionHandlers,
  sha256OfText,
  sleep,
  throwIfActionCancelled,
} from "./actionCore";

/**
 * Diagnostics files the harness reads or removes: the incident report a
 * failure card copied, and diagnostics snapshot exports.
 */

const INCIDENT_REPORT_ID_PATTERN = /^report_(?!0{32}$)[a-f0-9]{32}$/u;

const INCIDENT_REPORT_DIRECTORY = ".systemsculpt/diagnostics/incidents";

const INCIDENT_REPORT_MAX_BYTES = 256 * 1024;

const INCIDENT_REPORT_PERSIST_TIMEOUT_MS = 5000;

/**
 * Diagnostics-export attribution state. The harness may only trash a
 * snapshot it baselined, attributed as the single new export, and validated
 * against the allowlisted content-free schema. Evidence stays metadata-only.
 */
interface DiagnosticsExportAttribution {
  baseline: Set<string> | null;
  attributed: {
    readonly basename: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  } | null;
}

const diagnosticsExportAttributions = new WeakMap<App, DiagnosticsExportAttribution>();

const DIAGNOSTICS_EXPORT_DIRECTORY = ".systemsculpt/diagnostics";

const DIAGNOSTICS_EXPORT_BASENAME_PATTERN =
  /^diagnostics-\d{8}-\d{6}-[0-9a-f]{32}\.txt$/u;

const DIAGNOSTICS_SNAPSHOT_TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "generated_at",
  "plugin_version",
  "obsidian_version",
  "status",
  "event_count",
  "events",
  "resource_sample_count",
  "resources",
]);

/**
 * The failure card copies only the report ID. Resolve it to the report the
 * plugin persisted under that ID, allowing a bounded wait for the local save.
 */
async function readCopiedIncidentReport(
  ctx: ActionContext,
): Promise<Readonly<{ reportId: string; serialized: string }>> {
  const ownerWindow = chatContainer(ctx.app)?.ownerDocument.defaultView ?? window;
  const clipboard = ownerWindow.navigator.clipboard;
  if (typeof clipboard?.readText !== "function") {
    throw new DriverActionError("Clipboard reading is unavailable in this development build.");
  }
  let reportId: string;
  try {
    reportId = await clipboard.readText();
  } catch {
    throw new DriverActionError("The copied incident report ID could not be read.");
  }
  if (!INCIDENT_REPORT_ID_PATTERN.test(reportId)) {
    throw new DriverActionError("The clipboard does not hold exactly one incident report ID.");
  }
  const serialized = await waitForPersistedIncidentReport(ctx, reportId);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes === 0 || bytes > INCIDENT_REPORT_MAX_BYTES) {
    throw new DriverActionError("The stored incident report has an invalid size.");
  }
  return { reportId, serialized };
}

async function waitForPersistedIncidentReport(
  ctx: ActionContext,
  reportId: string,
): Promise<string> {
  const path = `${INCIDENT_REPORT_DIRECTORY}/${reportId}.json`;
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    try {
      return await ctx.app.vault.adapter.read(path);
    } catch {
      if (Date.now() - startedAt >= INCIDENT_REPORT_PERSIST_TIMEOUT_MS) {
        throw new DriverActionError("The copied incident report is not durably stored.");
      }
    }
    await sleep(50);
  }
}

interface DiagnosticsAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  stat(path: string): Promise<{ type: string; size: number } | null>;
  trashLocal?(path: string): Promise<void>;
}

function diagnosticsAdapter(ctx: ActionContext): DiagnosticsAdapter {
  return ctx.app.vault.adapter;
}

function diagnosticsAttributionState(ctx: ActionContext): DiagnosticsExportAttribution {
  let state = diagnosticsExportAttributions.get(ctx.app);
  if (!state) {
    state = { baseline: null, attributed: null };
    diagnosticsExportAttributions.set(ctx.app, state);
  }
  return state;
}

async function listDiagnosticsExportBasenames(
  ctx: ActionContext,
): Promise<Set<string>> {
  const adapter = diagnosticsAdapter(ctx);
  const names = new Set<string>();
  if (!(await adapter.exists(DIAGNOSTICS_EXPORT_DIRECTORY))) return names;
  const listing = await adapter.list(DIAGNOSTICS_EXPORT_DIRECTORY);
  for (const filePath of listing.files) {
    const basename = filePath.split("/").pop() ?? "";
    if (DIAGNOSTICS_EXPORT_BASENAME_PATTERN.test(basename)) names.add(basename);
  }
  return names;
}

/**
 * Validate an export against the allowlisted content-free snapshot schema.
 * Throws with metadata-only messages; never includes snapshot content.
 */
function validateDiagnosticsSnapshotText(ctx: ActionContext, text: string): {
  eventCount: number;
  resourceSampleCount: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DriverActionError("Diagnostics export is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DriverActionError("Diagnostics export is not a JSON object.");
  }
  const snapshot = parsed as Record<string, unknown>;
  for (const key of Object.keys(snapshot)) {
    if (!DIAGNOSTICS_SNAPSHOT_TOP_LEVEL_KEYS.has(key)) {
      throw new DriverActionError(
        `Diagnostics export contains a non-allowlisted top-level key: "${key}".`,
      );
    }
  }
  if (snapshot.schema_version !== 1) {
    throw new DriverActionError("Diagnostics export schema_version must be 1.");
  }
  if (
    typeof snapshot.generated_at !== "string"
    || !Number.isFinite(Date.parse(snapshot.generated_at))
  ) {
    throw new DriverActionError("Diagnostics export generated_at is invalid.");
  }
  if (snapshot.plugin_version !== ctx.pluginVersion) {
    throw new DriverActionError(
      "Diagnostics export plugin_version does not match the loaded plugin.",
    );
  }
  if (!Array.isArray(snapshot.events) || snapshot.event_count !== snapshot.events.length) {
    throw new DriverActionError(
      "Diagnostics export event_count does not match its events array.",
    );
  }
  if (
    !Array.isArray(snapshot.resources)
    || snapshot.resource_sample_count !== snapshot.resources.length
  ) {
    throw new DriverActionError(
      "Diagnostics export resource_sample_count does not match its resources array.",
    );
  }
  if (text.includes("tool_call_id")) {
    throw new DriverActionError(
      "Diagnostics export privacy canary failed: tool_call_id must not be exported.",
    );
  }
  const adapter = ctx.app.vault.adapter as unknown as {
    getBasePath?: () => string;
  };
  if (typeof adapter.getBasePath === "function") {
    let basePath = "";
    try {
      basePath = adapter.getBasePath();
    } catch {
      basePath = "";
    }
    if (basePath && text.includes(basePath)) {
      throw new DriverActionError(
        "Diagnostics export privacy canary failed: absolute vault path leaked.",
      );
    }
  }
  return {
    eventCount: snapshot.events.length,
    resourceSampleCount: snapshot.resources.length,
  };
}

async function baselineDiagnosticsExports(
  ctx: ActionContext,
): Promise<Record<string, unknown>> {
  const state = diagnosticsAttributionState(ctx);
  state.baseline = await listDiagnosticsExportBasenames(ctx);
  state.attributed = null;
  return { baselinedCount: state.baseline.size };
}

async function attributeNewDiagnosticsExport(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const state = diagnosticsAttributionState(ctx);
  if (!state.baseline) {
    throw new DriverActionError(
      "diagnostics.attributeNewExport requires diagnostics.baselineExports first.",
    );
  }
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
  const startedAt = Date.now();
  let fresh: string[] = [];
  for (;;) {
    throwIfActionCancelled(ctx);
    const current = await listDiagnosticsExportBasenames(ctx);
    fresh = [...current].filter((name) => !state.baseline!.has(name));
    if (fresh.length > 1) {
      throw new DriverActionError(
        `Expected exactly one new diagnostics export; found ${fresh.length}.`,
      );
    }
    if (fresh.length === 1) break;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        `No new diagnostics export appeared within ${timeoutMs}ms.`,
      );
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  const basename = fresh[0];
  const path = `${DIAGNOSTICS_EXPORT_DIRECTORY}/${basename}`;
  const adapter = diagnosticsAdapter(ctx);
  const stat = await adapter.stat(path);
  if (!stat || stat.type !== "file") {
    throw new DriverActionError(
      "The new diagnostics export is not a regular file.",
    );
  }
  const text = await adapter.read(path);
  const { eventCount, resourceSampleCount } = validateDiagnosticsSnapshotText(ctx, text);
  const bytes = new TextEncoder().encode(text).byteLength;
  const sha256 = sha256OfText(text);
  state.attributed = { basename, path, bytes, sha256 };
  return { basename, bytes, sha256: `sha256:${sha256}`, eventCount, resourceSampleCount };
}

async function trashAttributedDiagnosticsExport(
  ctx: ActionContext,
): Promise<Record<string, unknown>> {
  const state = diagnosticsAttributionState(ctx);
  const attributed = state.attributed;
  if (!attributed) {
    throw new DriverActionError(
      "diagnostics.trashAttributedExport requires a successful diagnostics.attributeNewExport.",
    );
  }
  const adapter = diagnosticsAdapter(ctx);
  if (!(await adapter.exists(attributed.path))) {
    throw new DriverActionError(
      "The attributed diagnostics export no longer exists; refusing to trash.",
    );
  }
  const stat = await adapter.stat(attributed.path);
  if (!stat || stat.type !== "file") {
    throw new DriverActionError(
      "The attributed diagnostics export is no longer a regular file; refusing to trash.",
    );
  }
  const text = await adapter.read(attributed.path);
  if (
    new TextEncoder().encode(text).byteLength !== attributed.bytes
    || sha256OfText(text) !== attributed.sha256
  ) {
    throw new DriverActionError(
      "The attributed diagnostics export changed since attribution; refusing to trash.",
    );
  }
  if (typeof adapter.trashLocal !== "function") {
    throw new DriverActionError(
      "Recoverable local trash is unavailable; refusing to delete permanently.",
    );
  }
  await adapter.trashLocal(attributed.path);
  if (await adapter.exists(attributed.path)) {
    throw new DriverActionError(
      "The attributed diagnostics export still exists after trashing.",
    );
  }
  state.attributed = null;
  state.baseline = null;
  return { basename: attributed.basename, trashed: true };
}

export const DIAGNOSTICS_EXPORT_ACTIONS: DriverActionHandlers = {
  "chat.readCopiedIncidentReport": readCopiedIncidentReport,
  "diagnostics.baselineExports": baselineDiagnosticsExports,
  "diagnostics.attributeNewExport": attributeNewDiagnosticsExport,
  "diagnostics.trashAttributedExport": trashAttributedDiagnosticsExport,
};
