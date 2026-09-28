import { normalizePath, type App } from "obsidian";
import type SystemSculptPlugin from "../main";
import { FileOperations } from "./vault/tools/FileOperations";
import { DirectoryOperations } from "./vault/tools/DirectoryOperations";
import { SearchOperations } from "./vault/tools/SearchOperations";
import { ManagementOperations } from "./vault/tools/ManagementOperations";
import {
  ReadFilesParams,
  WriteFileParams,
  EditFileParams,
  MultiEditParams,
  CreateDirectoriesParams,
  ListDirectoriesParams,
  MoveItemsParams,
  TrashFilesParams,
  FindFilesParams,
  GrepVaultParams,
  ManageWorkspaceParams,
  ManageContextParams
} from "./vault/types";

import {
  FirstPartyToolExecutionError,
  type FirstPartyToolExecutionOptions,
  type FirstPartyToolChatTarget,
} from "./types";
import {
  isFirstPartyToolName,
  type FirstPartyToolName,
} from "./toolNames";
import { toError } from "../utils/errors";

export class FirstPartyToolService {
  private fileOps!: FileOperations;
  private directoryOps!: DirectoryOperations;
  private searchOps!: SearchOperations;
  private readonly managementOps: ManagementOperations;
  private vaultRoot: string | null = null;
  private vaultRootAliases: string[] = [];

  constructor(private readonly plugin: SystemSculptPlugin, private readonly app: App) {
    this.managementOps = new ManagementOperations(app, plugin);
    this.setVaultAllowedPaths(["/"]);
  }

  async executeTool(
    requestedName: string,
    args: unknown,
    options?: FirstPartyToolExecutionOptions,
  ): Promise<unknown> {
    if (options?.signal?.aborted) {
      throw new FirstPartyToolExecutionError(
        "TOOL_CANCELLED_BEFORE_START",
        "Tool execution was cancelled before it started.",
      );
    }

    if (!isFirstPartyToolName(requestedName)) {
      throw new Error(`Unknown first-party tool: ${requestedName}`);
    }
    const mappedArgs = this.mapVaultArgs(requestedName, args);
    const execution = this.dispatch(requestedName, mappedArgs, options?.chatView);
    return await this.awaitStartedExecution(execution, options);
  }

  setVaultAllowedPaths(paths: string[]): void {
    const allowedPaths = [...paths];
    this.fileOps = new FileOperations(this.app, allowedPaths);
    this.directoryOps = new DirectoryOperations(this.app, allowedPaths, this.plugin);
    this.searchOps = new SearchOperations(this.app, allowedPaths, this.plugin);
  }

  setVaultRoot(root: string | null, aliases: string[] = []): void {
    this.vaultRoot = root ? normalizePath(root) : null;
    this.vaultRootAliases = (Array.isArray(aliases) ? aliases : [])
      .map((alias) => normalizePath(String(alias ?? "")).replace(/^\/+/, ""))
      .filter((alias) => alias.length > 0);
  }

  private async dispatch(
    toolName: FirstPartyToolName,
    args: unknown,
    chatView?: FirstPartyToolChatTarget,
  ): Promise<unknown> {
    switch (toolName) {
      case "read":
        return await this.fileOps.readFiles(args as ReadFilesParams);
      case "write":
        return await this.fileOps.writeFile(args as WriteFileParams);
      case "edit": {
        const { diff, appliedCount, requestedCount, skipped } =
          await this.fileOps.editFile(args as EditFileParams);
        // Honest reporting (BUG-02): success is false when nothing applied, so a
        // mistyped find-string under strict:false can no longer masquerade as a
        // successful edit. appliedCount/skipped let the caller retry the misses.
        return {
          path: (args as EditFileParams).path,
          success: appliedCount > 0,
          diff,
          appliedCount,
          requestedCount,
          skipped,
        };
      }
      case "multi_edit":
        return await this.fileOps.multiEditFiles(args as MultiEditParams);
      case "create_folders":
        return await this.directoryOps.createDirectories(args as CreateDirectoriesParams);
      case "list_items":
        return await this.directoryOps.listDirectories(args as ListDirectoriesParams);
      case "move":
        return await this.directoryOps.moveItems(args as MoveItemsParams);
      case "trash":
        return await this.directoryOps.trashFiles(args as TrashFilesParams);
      case "find":
        return await this.searchOps.findFiles(args as FindFilesParams);
      case "search":
        return await this.searchOps.grepVault(args as GrepVaultParams);
      case "open":
        return await this.managementOps.manageWorkspace(args as ManageWorkspaceParams);
      case "context":
        return await this.managementOps.manageContext(args as ManageContextParams, chatView);
    }
  }

  private async awaitStartedExecution<T>(
    execution: Promise<T>,
    options?: FirstPartyToolExecutionOptions,
  ): Promise<T> {
    if (!options?.signal && !options?.timeoutMs) return await execution;
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: number | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const unknownOutcome = (cause: unknown) => new FirstPartyToolExecutionError(
        "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN",
        "Cancellation was requested after tool execution began; the tool outcome is unknown.",
        cause,
      );
      const onAbort = () => finish(() => reject(unknownOutcome(new Error("Tool execution aborted"))));
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.timeoutMs) {
        timer = window.setTimeout(
          () => finish(() => reject(unknownOutcome(new Error("Tool execution timed out")))),
          options.timeoutMs,
        );
      }
      execution.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(toError(error, "Tool execution failed."))),
      );
    });
  }

  private mapVaultArgs(toolName: FirstPartyToolName, args: unknown): unknown {
    if (!this.vaultRoot || !args || typeof args !== "object") return args;
    const input = args as Record<string, unknown>;
    const asRecord = (value: unknown): Record<string, unknown> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const mapPath = (path: string): string => this.normalizeVaultPath(path);
    const stringArray = (value: unknown): string[] => Array.isArray(value)
      ? value.map((entry) => String(entry ?? ""))
      : typeof value === "string" ? [value] : [];

    switch (toolName) {
      case "read":
      case "create_folders":
      case "list_items":
      case "trash":
      case "context": {
        const paths = stringArray(input.paths ?? input.path);
        return paths.length > 0 ? { ...input, paths: paths.map(mapPath) } : args;
      }
      case "write":
      case "edit":
        return typeof input.path === "string" ? { ...input, path: mapPath(input.path) } : args;
      case "multi_edit":
        return Array.isArray(input.files)
          ? {
              ...input,
              files: input.files.map((file: unknown) => {
                const fileRecord = asRecord(file);
                return {
                  ...fileRecord,
                  path: mapPath(String(fileRecord.path ?? "")),
                };
              }),
            }
          : args;
      case "move":
        return Array.isArray(input.items)
          ? {
              ...input,
              items: input.items.map((item: unknown) => {
                const itemRecord = asRecord(item);
                return {
                  ...itemRecord,
                  source: mapPath(String(itemRecord.source ?? "")),
                  destination: mapPath(String(itemRecord.destination ?? "")),
                };
              }),
            }
          : args;
      case "open":
        if (Array.isArray(input.files)) {
          return {
            ...input,
            files: input.files.map((file: unknown) => {
              const fileRecord = asRecord(file);
              return {
                ...fileRecord,
                path: mapPath(String(fileRecord.path ?? "")),
              };
            }),
          };
        }
        return typeof input.path === "string"
          ? { ...input, files: [{ path: mapPath(input.path) }] }
          : args;
      default:
        return args;
    }
  }

  private normalizeVaultPath(path: string): string {
    const root = this.vaultRoot;
    const raw = String(path ?? "").trim();
    if (!root || !raw) return raw;

    let normalized = normalizePath(raw).replace(/^\/+/, "");
    for (const alias of this.vaultRootAliases) {
      if (normalized === alias) return root;
      if (normalized.startsWith(`${alias}/`)) {
        normalized = normalized.slice(alias.length + 1);
        break;
      }
    }
    if (normalized === root || normalized.startsWith(`${root}/`)) return normalized;
    return normalizePath(`${root}/${normalized}`);
  }
}
