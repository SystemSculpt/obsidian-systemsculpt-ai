import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { MCPToolInfo } from "../../types/mcp";
import { MCPYouTubeServer } from "../../mcp-tools/youtube/MCPYouTubeServer";
import type { MCPExecutionOptions } from "../MCPService";

export class YouTubeAdapter {
  private ytServer: MCPYouTubeServer;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.ytServer = new MCPYouTubeServer(plugin, app);
  }

  async listTools(): Promise<MCPToolInfo[]> {
    return await this.ytServer.getTools();
  }

  async executeTool(
    toolName: string,
    args: unknown,
    _chatView?: unknown,
    options?: MCPExecutionOptions
  ): Promise<unknown> {
    if (options?.signal?.aborted) {
      throw Object.assign(new Error('Tool execution was cancelled before it started.'), {
        code: 'TOOL_CANCELLED_BEFORE_START' as const,
      });
    }

    const execution = this.ytServer.executeTool(toolName, args);
    if (!options?.signal && !options?.timeoutMs) return await execution;
    return await new Promise<unknown>((resolve, reject) => {
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
}
