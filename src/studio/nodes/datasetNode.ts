import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizePath } from "obsidian";
import { deriveStudioAssetsDir } from "../paths";
import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { isRecord } from "../utils";
import { getText } from "./shared";

const DATASET_CACHE_SCHEMA = "studio.dataset-cache.v2" as const;
const DATASET_QUERY_PLACEHOLDER = /\{\{\s*query\s*\}\}/gi;
const DATASET_QUERY_ENV_KEY = "STUDIO_DATASET_QUERY";
const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_ADAPTER_COMMAND = "node";
const DEFAULT_ADAPTER_ARGS = ["scripts/db-query.js", "{{query}}"];
const DEFAULT_REFRESH_HOURS = 6;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

type DatasetCacheSnapshotV2 = {
  schema: typeof DATASET_CACHE_SCHEMA;
  nodeId: string;
  workingDirectory: string;
  query: string;
  adapterCommand: string;
  adapterArgs: string[];
  refreshHours: number;
  generatedAt: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

function isAbsolutePath(path: string): boolean {
  const normalized = String(path || "").trim().replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
}

function sanitizeFileSegment(value: string): string {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "value";
}

function readNumber(value: StudioJsonValue | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function readStringList(value: StudioJsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => getText(entry as StudioJsonValue));
}

function parseAdapterArgs(raw: StudioJsonValue | undefined): string[] {
  const fromConfig = readStringList(raw).filter((entry) => entry.length > 0);
  if (fromConfig.length > 0) {
    return fromConfig;
  }
  return [...DEFAULT_ADAPTER_ARGS];
}

function renderAdapterArgs(templates: string[], query: string): {
  args: string[];
  queryInjectedInArgs: boolean;
} {
  let queryInjectedInArgs = false;
  const args = templates.map((template) =>
    template.replace(DATASET_QUERY_PLACEHOLDER, () => {
      queryInjectedInArgs = true;
      return query;
    })
  );
  return {
    args,
    queryInjectedInArgs,
  };
}

function readCacheSnapshot(raw: string): DatasetCacheSnapshotV2 | null {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    if (parsed.schema !== DATASET_CACHE_SCHEMA) {
      return null;
    }

    const nodeId = getText(parsed.nodeId as StudioJsonValue).trim();
    const workingDirectory = getText(parsed.workingDirectory as StudioJsonValue).trim();
    const query = getText(parsed.query as StudioJsonValue).trim();
    const adapterCommand = getText(parsed.adapterCommand as StudioJsonValue).trim();
    const adapterArgs = readStringList(parsed.adapterArgs as StudioJsonValue);
    const refreshHours = readNumber(parsed.refreshHours as StudioJsonValue, -1);
    const generatedAt = getText(parsed.generatedAt as StudioJsonValue).trim();
    const stdout = getText(parsed.stdout as StudioJsonValue);
    const stderr = getText(parsed.stderr as StudioJsonValue);
    const exitCode = readNumber(parsed.exitCode as StudioJsonValue, -1);
    const timedOut = parsed.timedOut === true;

    if (
      !nodeId ||
      !workingDirectory ||
      !query ||
      !adapterCommand ||
      refreshHours < 1 ||
      !generatedAt ||
      !Number.isInteger(exitCode)
    ) {
      return null;
    }

    return {
      schema: DATASET_CACHE_SCHEMA,
      nodeId,
      workingDirectory,
      query,
      adapterCommand,
      adapterArgs,
      refreshHours,
      generatedAt,
      stdout,
      stderr,
      exitCode,
      timedOut,
    };
  } catch {
    return null;
  }
}

export const datasetNode: StudioNodeDefinition = {
  kind: "studio.dataset",
  version: "1.0.0",
  capabilityClass: "local_io",
  cachePolicy: "never",
  inputPorts: [],
  outputPorts: [{ id: "text", type: "text" }],
  configDefaults: {
    workingDirectory: "",
    customQuery: "",
    adapterCommand: DEFAULT_ADAPTER_COMMAND,
    adapterArgs: [...DEFAULT_ADAPTER_ARGS],
    refreshHours: DEFAULT_REFRESH_HOURS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  },
  configSchema: {
    fields: [
      {
        key: "workingDirectory",
        label: "Working Directory",
        description:
          "Folder where Studio runs your adapter command. Keep credentials there via env (for example .env.local/DATABASE_URL).",
        type: "directory_path",
        required: true,
        allowOutsideVault: true,
        placeholder: "/Users/systemsculpt/gits/systemsculpt-website",
      },
      {
        key: "customQuery",
        label: "Custom Query",
        description: "Dataset query/request payload text sent to your adapter.",
        type: "textarea",
        required: true,
        placeholder: "SELECT now() AS now;",
      },
      {
        key: "adapterCommand",
        label: "Adapter Command",
        description: "Command used to resolve this dataset (for example node, bun, python3, curl).",
        type: "text",
        required: true,
        placeholder: "node",
      },
      {
        key: "adapterArgs",
        label: "Adapter Arguments",
        description:
          "One argument per line. Use {{query}} to inject the query directly into args. Query is always available in STUDIO_DATASET_QUERY env.",
        type: "string_list",
        required: false,
      },
      {
        key: "refreshHours",
        label: "Refresh Hours",
        type: "number",
        required: true,
        min: 1,
        max: 72,
        integer: true,
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "number",
        required: true,
        min: 1000,
        max: 900_000,
        integer: true,
      },
      {
        key: "maxOutputBytes",
        label: "Max Output Bytes",
        type: "number",
        required: true,
        min: 1024,
        max: 10 * 1024 * 1024,
        integer: true,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const workingDirectory = getText(context.node.config.workingDirectory as StudioJsonValue).trim();
    if (!workingDirectory) {
      throw new Error(`Dataset node "${context.node.id}" requires a working directory.`);
    }
    if (!isAbsolutePath(workingDirectory)) {
      throw new Error(
        `Dataset node "${context.node.id}" requires an absolute working directory path. Received "${workingDirectory}".`
      );
    }

    context.services.assertFilesystemPath(workingDirectory);

    const query = getText(context.node.config.customQuery as StudioJsonValue).trim();
    if (!query) {
      throw new Error(`Dataset node "${context.node.id}" requires a custom query.`);
    }

    const adapterCommand =
      getText(context.node.config.adapterCommand as StudioJsonValue).trim() || DEFAULT_ADAPTER_COMMAND;
    if (!adapterCommand) {
      throw new Error(`Dataset node "${context.node.id}" requires an adapter command.`);
    }

    const adapterArgTemplates = parseAdapterArgs(context.node.config.adapterArgs as StudioJsonValue);
    const adapterArgsResult = renderAdapterArgs(adapterArgTemplates, query);

    const refreshHours = Math.max(
      1,
      Math.floor(readNumber(context.node.config.refreshHours as StudioJsonValue, DEFAULT_REFRESH_HOURS))
    );
    const timeoutMs = Math.max(
      1000,
      Math.floor(readNumber(context.node.config.timeoutMs as StudioJsonValue, DEFAULT_TIMEOUT_MS))
    );
    const maxOutputBytes = Math.max(
      1024,
      Math.floor(readNumber(context.node.config.maxOutputBytes as StudioJsonValue, DEFAULT_MAX_OUTPUT_BYTES))
    );

    const cacheRelativePath = normalizePath(
      `${deriveStudioAssetsDir(context.projectPath)}/cache/datasets/${sanitizeFileSegment(context.node.id)}.json`
    );
    context.services.assertFilesystemPath(cacheRelativePath);
    const cacheAbsolutePath = context.services.resolveAbsolutePath(cacheRelativePath);
    const nowMs = Date.now();

    try {
      const cacheRaw = await readFile(cacheAbsolutePath, "utf8");
      const cacheSnapshot = readCacheSnapshot(cacheRaw);
      if (
        cacheSnapshot &&
        cacheSnapshot.nodeId === context.node.id &&
        cacheSnapshot.workingDirectory === workingDirectory &&
        cacheSnapshot.query === query &&
        cacheSnapshot.adapterCommand === adapterCommand &&
        JSON.stringify(cacheSnapshot.adapterArgs) === JSON.stringify(adapterArgsResult.args)
      ) {
        const generatedAtMs = Date.parse(cacheSnapshot.generatedAt);
        const ageMs = Number.isFinite(generatedAtMs)
          ? Math.max(0, nowMs - generatedAtMs)
          : Number.POSITIVE_INFINITY;
        const maxAgeMs = refreshHours * ONE_HOUR_MS;
        if (Number.isFinite(ageMs) && ageMs <= maxAgeMs) {
          const cacheAgeHours = ageMs / ONE_HOUR_MS;
          context.log(`Dataset cache hit age=${cacheAgeHours.toFixed(3)}h`);
          return {
            outputs: {
              text: cacheSnapshot.stdout,
            },
          };
        }
      }
    } catch {
      // No cache file yet or unreadable cache; run a fresh query.
    }

    if (context.signal.aborted) {
      throw new Error(`Dataset node "${context.node.id}" aborted before execution.`);
    }

    if (!adapterArgsResult.queryInjectedInArgs) {
      context.log(
        `Dataset adapter args do not include {{query}}; adapter should read query from ${DATASET_QUERY_ENV_KEY}.`
      );
    }

    const result = await context.services.runCli({
      command: adapterCommand,
      args: adapterArgsResult.args,
      cwd: workingDirectory,
      env: {
        [DATASET_QUERY_ENV_KEY]: query,
      },
      timeoutMs,
      maxOutputBytes,
    });

    if (result.timedOut) {
      throw new Error(
        `Dataset node "${context.node.id}" timed out after ${timeoutMs}ms while running query.`
      );
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      const details = stderr || stdout || "no output";
      throw new Error(
        `Dataset node "${context.node.id}" query failed (exit ${result.exitCode}): ${details}`
      );
    }

    const generatedAt = new Date().toISOString();
    const cacheSnapshot: DatasetCacheSnapshotV2 = {
      schema: DATASET_CACHE_SCHEMA,
      nodeId: context.node.id,
      workingDirectory,
      query,
      adapterCommand,
      adapterArgs: adapterArgsResult.args,
      refreshHours,
      generatedAt,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };

    await mkdir(dirname(cacheAbsolutePath), { recursive: true });
    await writeFile(cacheAbsolutePath, `${JSON.stringify(cacheSnapshot, null, 2)}\n`, "utf8");

    return {
      outputs: {
        text: result.stdout,
      },
    };
  },
};
