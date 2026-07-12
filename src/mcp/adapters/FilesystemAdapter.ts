import type { App } from "obsidian";
import SystemSculptPlugin from "../../main";
import { MCPToolInfo } from "../../types/mcp";
import type { MCPFilesystemServer } from "../../mcp-tools/filesystem/MCPFilesystemServer";
import type { MCPExecutionOptions } from "../MCPService";

export class FilesystemAdapter {
  private readonly fsServer: MCPFilesystemServer;

  constructor(plugin: SystemSculptPlugin, app: App) {
    // Since #142 the filesystem MCP server and its whole tool graph are pure
    // Obsidian-API code (no Node builtins), so the agent file tools run on
    // mobile too — no desktop-only gate. The module is still reached through a
    // lazy `require` rather than a static import so its graph stays off the
    // eager bundle-eval path and only evaluates when the adapter is actually
    // constructed (the #207 belt-and-suspenders against any future Node import).
    const mod = require("../../mcp-tools/filesystem/MCPFilesystemServer") as typeof import("../../mcp-tools/filesystem/MCPFilesystemServer");
    this.fsServer = new mod.MCPFilesystemServer(plugin, app);
  }

  async listTools(): Promise<MCPToolInfo[]> {
    return await this.fsServer.getTools();
  }

  async executeTool(toolName: string, args: any, chatView?: any, options?: MCPExecutionOptions): Promise<any> {
    if (options?.signal?.aborted) {
      throw Object.assign(new Error('Tool execution was cancelled before it started.'), {
        code: 'TOOL_CANCELLED_BEFORE_START' as const,
      });
    }

    const execution = this.fsServer.executeTool(toolName, args, chatView);
    return await this.awaitStartedExecution(execution, options);
  }

  private async awaitStartedExecution<T>(execution: Promise<T>, options?: MCPExecutionOptions): Promise<T> {
    if (!options?.signal && !options?.timeoutMs) return await execution;
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const unknown = (cause: unknown) => Object.assign(
        new Error('Cancellation was requested after tool execution began; the tool outcome is unknown.'),
        { code: 'TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN' as const, cause },
      );
      const onAbort = () => finish(() => reject(unknown(new Error('Tool execution aborted'))));
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      if (options?.timeoutMs) {
        timer = window.setTimeout(() => finish(() => reject(unknown(new Error('Tool execution timed out')))), options.timeoutMs);
      }
      execution.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
  }

  setAllowedPaths(paths: string[]): void {
    this.fsServer.setAllowedPaths(paths);
  }
}
