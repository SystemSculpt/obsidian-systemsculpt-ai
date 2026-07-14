import { normalizePath, type App } from "obsidian";
import type SystemSculptPlugin from "../main";
import { buildManagedToolDefinition, type ManagedToolDefinition } from "../utils/tooling";
import { VaultToolModule } from "./vault/VaultToolModule";
import {
  FirstPartyToolExecutionError,
  type FirstPartyToolDefinition,
  type FirstPartyToolExecutionOptions,
} from "./types";
import {
  isFirstPartyToolName,
  type FirstPartyToolName,
} from "./toolNames";

export class FirstPartyToolService {
  private readonly vaultTools: VaultToolModule;
  private vaultRoot: string | null = null;
  private vaultRootAliases: string[] = [];

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.vaultTools = new VaultToolModule(plugin, app);
  }

  async getAvailableTools(): Promise<ManagedToolDefinition[]> {
    return this.vaultTools.getTools().map((tool) => this.toManagedDefinition(tool));
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
    const normalizedName = requestedName;

    const mappedArgs = this.mapVaultArgs(normalizedName, args);
    const execution = options?.chatView
      ? this.vaultTools.executeTool(normalizedName, mappedArgs, options.chatView)
      : this.vaultTools.executeTool(normalizedName, mappedArgs);
    return await this.awaitStartedExecution(execution, options);
  }

  setVaultAllowedPaths(paths: string[]): void {
    this.vaultTools.setAllowedPaths(paths);
  }

  setVaultRoot(root: string | null, aliases: string[] = []): void {
    this.vaultRoot = root ? normalizePath(root) : null;
    this.vaultRootAliases = (Array.isArray(aliases) ? aliases : [])
      .map((alias) => normalizePath(String(alias ?? "")).replace(/^\/+/, ""))
      .filter((alias) => alias.length > 0);
  }

  private toManagedDefinition(tool: FirstPartyToolDefinition): ManagedToolDefinition {
    return buildManagedToolDefinition({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    });
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
        (error) => finish(() => reject(error)),
      );
    });
  }

  private mapVaultArgs(toolName: FirstPartyToolName, args: unknown): unknown {
    if (!this.vaultRoot || !args || typeof args !== "object") return args;
    const input = args as Record<string, any>;
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
              files: input.files.map((file: any) => ({
                ...file,
                path: mapPath(String(file?.path ?? "")),
              })),
            }
          : args;
      case "move":
        return Array.isArray(input.items)
          ? {
              ...input,
              items: input.items.map((item: any) => ({
                ...item,
                source: mapPath(String(item?.source ?? "")),
                destination: mapPath(String(item?.destination ?? "")),
              })),
            }
          : args;
      case "open":
        if (Array.isArray(input.files)) {
          return {
            ...input,
            files: input.files.map((file: any) => ({
              ...file,
              path: mapPath(String(file?.path ?? "")),
            })),
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
