import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import type SystemSculptPlugin from "../../main";
import {
  resolvePiCommandCwd,
  startPiProcess,
  type PiResolvedRuntime,
} from "./PiProcessRuntime";
import {
  buildSystemSculptPiProviderEnv,
  ensureSystemSculptPiProviderExtension,
} from "./PiSystemSculptProvider";

export type PiRpcThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiRpcMessageImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PiRpcResponse =
  | {
      id?: string;
      type: "response";
      command: string;
      success: true;
      data?: any;
    }
  | {
      id?: string;
      type: "response";
      command: string;
      success: false;
      error: string;
    };

type PiRpcSuccessResponse = Extract<PiRpcResponse, { success: true }>;

export type PiRpcEvent = {
  type: string;
  [key: string]: unknown;
};

type PendingRequest = {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
};

export type PiRpcClientOptions = {
  plugin: SystemSculptPlugin;
  modelId?: string;
  thinkingLevel?: PiRpcThinkingLevel;
  systemPrompt?: string;
  sessionFile?: string;
  noSession?: boolean;
  cwd?: string;
};

type PiRpcStateResponse = {
  model?: {
    provider?: string;
    id?: string;
    reasoning?: boolean;
  } | null;
  thinkingLevel?: PiRpcThinkingLevel;
  isStreaming?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
};

export type PiRpcForkMessage = {
  entryId: string;
  text: string;
};

export class PiRpcProcessClient {
  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private runtime: PiResolvedRuntime | null = null;
  private lineReader: readline.Interface | null = null;
  private stderrBuffer = "";
  private nextRequestId = 1;
  private started = false;

  constructor(private readonly options: PiRpcClientOptions) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const args = ["--mode", "rpc"];
    args.push("--extension", await ensureSystemSculptPiProviderExtension(this.options.plugin));
    if (this.options.noSession) {
      args.push("--no-session");
    } else if (this.options.sessionFile) {
      args.push("--session", this.options.sessionFile);
    }
    if (this.options.modelId) {
      args.push("--model", this.options.modelId);
    }
    if (this.options.thinkingLevel) {
      args.push("--thinking", this.options.thinkingLevel);
    }
    const systemPrompt = String(this.options.systemPrompt || "").trim();
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const launched = await startPiProcess({
      plugin: this.options.plugin,
      args,
      env: buildSystemSculptPiProviderEnv(this.options.plugin),
      cwd: this.options.cwd || resolvePiCommandCwd(this.options.plugin),
    });

    this.child = launched.child;
    this.runtime = launched.runtime;
    this.started = true;

    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrBuffer += String(chunk || "");
    });

    this.child.on("error", (error) => {
      this.rejectAllPending(new Error(this.decorateProcessError(error instanceof Error ? error.message : String(error))));
    });

    this.child.on("close", (code, signal) => {
      const message = this.decorateProcessError(
        `Pi RPC process exited with code ${typeof code === "number" ? code : "unknown"}${signal ? ` (${signal})` : ""}.`
      );
      this.rejectAllPending(new Error(message));
      this.started = false;
      this.child = null;
      this.runtime = null;
      this.lineReader?.close();
      this.lineReader = null;
    });

    this.lineReader = readline.createInterface({
      input: this.child.stdout,
      terminal: false,
    });
    this.lineReader.on("line", (line) => {
      this.handleLine(line);
    });

    const state = await this.getState();
    await this.syncConfiguredState(state);
  }

  public getRuntime(): PiResolvedRuntime | null {
    return this.runtime;
  }

  public getStderr(): string {
    return this.stderrBuffer;
  }

  public onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  public async stop(): Promise<void> {
    if (!this.child) {
      this.started = false;
      return;
    }

    const child = this.child;
    this.child = null;
    this.started = false;
    this.lineReader?.close();
    this.lineReader = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore kill failures.
        }
        finish();
      }, 1000);

      child.once("close", () => {
        clearTimeout(timeout);
        finish();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        finish();
      }
    });
  }

  public async prompt(message: string, images?: PiRpcMessageImage[]): Promise<void> {
    await this.send({
      type: "prompt",
      message,
      images,
    });
  }

  public async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  public async getState(): Promise<PiRpcStateResponse> {
    const response = await this.send({ type: "get_state" });
    return (response.data || {}) as PiRpcStateResponse;
  }

  public async getMessages(): Promise<any[]> {
    const response = await this.send({ type: "get_messages" });
    return Array.isArray(response.data?.messages) ? response.data.messages : [];
  }

  public async getAvailableModels(): Promise<any[]> {
    const response = await this.send({ type: "get_available_models" });
    return Array.isArray(response.data?.models) ? response.data.models : [];
  }

  public async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const response = await this.send({
      type: "fork",
      entryId,
    });
    return {
      text: String(response.data?.text || ""),
      cancelled: Boolean(response.data?.cancelled),
    };
  }

  public async getForkMessages(): Promise<PiRpcForkMessage[]> {
    const response = await this.send({ type: "get_fork_messages" });
    const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
    return messages
      .map((message: any) => ({
        entryId: String(message?.entryId || "").trim(),
        text: String(message?.text || ""),
      }))
      .filter((message: PiRpcForkMessage) => message.entryId.length > 0);
  }

  public async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({
      type: "set_model",
      provider,
      modelId,
    });
  }

  public async setSessionName(name: string): Promise<void> {
    await this.send({
      type: "set_session_name",
      name,
    });
  }

  public async getCommands(): Promise<any[]> {
    const response = await this.send({ type: "get_commands" });
    return Array.isArray(response.data?.commands) ? response.data.commands : [];
  }

  public async setThinkingLevel(level: PiRpcThinkingLevel): Promise<void> {
    await this.send({
      type: "set_thinking_level",
      level,
    });
  }

  private async syncConfiguredState(state: PiRpcStateResponse): Promise<void> {
    if (this.options.modelId) {
      const [expectedProvider, ...expectedModelParts] = this.options.modelId.split("/");
      const expectedModelId = expectedModelParts.join("/");
      const currentProvider = String(state.model?.provider || "").trim();
      const currentModelId = String(state.model?.id || "").trim();
      if (
        expectedProvider &&
        expectedModelId &&
        (currentProvider !== expectedProvider || currentModelId !== expectedModelId)
      ) {
        await this.setModel(expectedProvider, expectedModelId);
      }
    }

    if (
      this.options.thinkingLevel &&
      String(state.thinkingLevel || "").trim() !== this.options.thinkingLevel
    ) {
      await this.setThinkingLevel(this.options.thinkingLevel);
    }
  }

  private decorateProcessError(message: string): string {
    const stderr = String(this.stderrBuffer || "").trim();
    if (!stderr) {
      return message;
    }
    const firstLine = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine ? `${message} ${firstLine}` : `${message} ${stderr}`;
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async send(command: Record<string, unknown>): Promise<PiRpcSuccessResponse> {
    if (!this.child?.stdin || !this.started) {
      throw new Error("Pi RPC process is not running.");
    }

    const id = `rpc-${this.nextRequestId++}`;
    const payload = JSON.stringify({
      id,
      ...command,
    });

    const responsePromise = new Promise<PiRpcResponse>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    this.child.stdin.write(`${payload}\n`);
    const response = await responsePromise;
    if (!response.success) {
      throw new Error(String(response.error || `Pi RPC command failed: ${response.command}`));
    }
    return response as PiRpcSuccessResponse;
  }

  private handleLine(line: string): void {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (payload?.type === "response") {
      const id = String(payload.id || "").trim();
      if (!id) {
        return;
      }
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(id);
      pending.resolve(payload as PiRpcResponse);
      return;
    }

    if (payload?.type === "extension_ui_request") {
      const method = String(payload.method || "").trim().toLowerCase();
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        try {
          this.child?.stdin.write(
            `${JSON.stringify({
              type: "extension_ui_response",
              id: payload.id,
              cancelled: true,
            })}\n`
          );
        } catch {
          // Ignore write failures during shutdown.
        }
      }
    }

    for (const listener of this.eventListeners) {
      listener(payload as PiRpcEvent);
    }
  }
}
