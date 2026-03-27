import { TFile, normalizePath } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { generateDefaultChatTitle } from "../../utils/titleUtils";
import { loadChatModelPickerOptions } from "../../views/chatview/modelSelection";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import type { ChatView } from "../../views/chatview/ChatView";
import type { AutomationApprovalMode } from "../../views/chatview/InputHandler";

type NodeHttpModule = typeof import("node:http");
type NodeFsModule = typeof import("node:fs/promises");
type NodePathModule = typeof import("node:path");
type NodeOsModule = typeof import("node:os");
type NodeCryptoModule = typeof import("node:crypto");
type IncomingMessage = import("node:http").IncomingMessage;
type ServerResponse = import("node:http").ServerResponse;
type Server = import("node:http").Server;

type BridgeRuntime = {
  http: NodeHttpModule;
  fs: NodeFsModule;
  path: NodePathModule;
  os: NodeOsModule;
  crypto: NodeCryptoModule;
};

type BridgeDiscoveryRecord = {
  version: 1;
  bridge: "desktop-automation";
  pluginId: string;
  pluginVersion: string;
  vaultName: string;
  vaultPath: string | null;
  vaultConfigDir: string | null;
  vaultInstanceId: string;
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: string;
};

type EnsureChatOptions = {
  createIfMissing?: boolean;
  reset?: boolean;
  selectedModelId?: string;
};

class BridgeHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeHttpError";
  }
}

function loadBridgeRuntime(): BridgeRuntime {
  return {
    http: require("node:http") as NodeHttpModule,
    fs: require("node:fs/promises") as NodeFsModule,
    path: require("node:path") as NodePathModule,
    os: require("node:os") as NodeOsModule,
    crypto: require("node:crypto") as NodeCryptoModule,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVaultPath(value: unknown): string {
  const normalized = normalizePath(String(value || "").trim().replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized) {
    throw new BridgeHttpError(400, "A vault-relative path is required.");
  }
  return normalized;
}

function parseApprovalMode(value: unknown): AutomationApprovalMode | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "interactive" || value === "auto-approve" || value === "deny") {
    return value;
  }

  throw new BridgeHttpError(400, `Unsupported approval mode: ${String(value)}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class DesktopAutomationBridge {
  private readonly host = "127.0.0.1";
  private server: Server | null = null;
  private token: string | null = null;
  private port: number | null = null;
  private startedAt: string | null = null;
  private discoveryFilePath: string | null = null;
  private automationLeaf: WorkspaceLeaf | null = null;

  constructor(private readonly plugin: SystemSculptPlugin) {}

  public async syncFromSettings(): Promise<void> {
    if (!this.plugin.settings.desktopAutomationBridgeEnabled) {
      await this.stop();
      return;
    }

    if (this.server) {
      await this.writeDiscoveryFile();
      return;
    }

    await this.start();
  }

  public async stop(): Promise<void> {
    const runtime = loadBridgeRuntime();
    const server = this.server;
    const discoveryFilePath = this.discoveryFilePath;
    const ownership = {
      token: this.token,
      port: this.port,
      startedAt: this.startedAt,
    };

    this.server = null;
    this.token = null;
    this.port = null;
    this.startedAt = null;
    this.discoveryFilePath = null;
    this.automationLeaf = null;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }).catch(() => {});
    }

    if (discoveryFilePath) {
      await this.removeDiscoveryFileIfOwned(discoveryFilePath, ownership, runtime);
    }
  }

  private async removeDiscoveryFileIfOwned(
    filePath: string,
    ownership: {
      token: string | null;
      port: number | null;
      startedAt: string | null;
    },
    runtime: BridgeRuntime,
  ): Promise<void> {
    let shouldDelete = true;

    try {
      const raw = await runtime.fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        const recordedToken = String(parsed.token || "").trim();
        const recordedStartedAt = String(parsed.startedAt || "").trim();
        const recordedPort = Number(parsed.port);

        if (ownership.token) {
          shouldDelete = recordedToken === String(ownership.token).trim();
        } else if (ownership.startedAt || Number.isFinite(ownership.port)) {
          shouldDelete =
            recordedStartedAt === String(ownership.startedAt || "").trim() &&
            (!Number.isFinite(ownership.port) || recordedPort === Number(ownership.port));
        }
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
      if (code === "ENOENT") {
        return;
      }
    }

    if (shouldDelete) {
      await runtime.fs.rm(filePath, { force: true }).catch(() => {});
    }
  }

  private async start(): Promise<void> {
    const runtime = loadBridgeRuntime();
    const server = runtime.http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.host, () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Desktop automation bridge failed to bind a localhost port.");
    }

    this.server = server;
    this.port = address.port;
    this.token = runtime.crypto.randomBytes(24).toString("hex");
    this.startedAt = new Date().toISOString();
    await this.writeDiscoveryFile();

    this.plugin.getLogger().info("Desktop automation bridge started", {
      source: "DesktopAutomationBridge",
      metadata: {
        host: this.host,
        port: this.port,
        discoveryFilePath: this.discoveryFilePath,
      },
    });
  }

  private getDiscoveryDirectory(): string {
    const runtime = loadBridgeRuntime();
    return runtime.path.join(runtime.os.homedir(), ".systemsculpt", "obsidian-automation");
  }

  private getVaultPath(): string | null {
    const adapter = this.plugin.app.vault.adapter as {
      getBasePath?: () => string;
      basePath?: string;
      getFullPath?: (path: string) => string;
    };

    if (typeof adapter?.getBasePath === "function") {
      try {
        const value = adapter.getBasePath();
        if (typeof value === "string" && value.trim().length > 0) {
          return value;
        }
      } catch {}
    }

    if (typeof adapter?.basePath === "string" && adapter.basePath.trim().length > 0) {
      return adapter.basePath;
    }

    return resolveAbsoluteVaultPath(adapter, ".obsidian")?.replace(/[\\/]\.obsidian$/, "") ?? null;
  }

  private buildDiscoveryRecord(): BridgeDiscoveryRecord {
    if (!this.port || !this.token || !this.startedAt) {
      throw new Error("Desktop automation bridge is not running.");
    }

    return {
      version: 1,
      bridge: "desktop-automation",
      pluginId: this.plugin.manifest.id,
      pluginVersion: this.plugin.manifest.version,
      vaultName: this.plugin.app.vault.getName(),
      vaultPath: this.getVaultPath(),
      vaultConfigDir: this.plugin.app.vault.configDir || null,
      vaultInstanceId: String(this.plugin.settings.vaultInstanceId || "").trim(),
      pid: process.pid,
      host: this.host,
      port: this.port,
      token: this.token,
      startedAt: this.startedAt,
    };
  }

  private async writeDiscoveryFile(): Promise<void> {
    const runtime = loadBridgeRuntime();
    const record = this.buildDiscoveryRecord();
    const directory = this.getDiscoveryDirectory();
    const filePath = runtime.path.join(directory, `${record.vaultInstanceId || "unknown-vault"}.json`);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    await runtime.fs.mkdir(directory, { recursive: true });
    await runtime.fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await runtime.fs.rename(tempPath, filePath);
    this.discoveryFilePath = filePath;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.assertAuthorized(request);
      const url = new URL(request.url || "/", `http://${this.host}`);
      const method = String(request.method || "GET").toUpperCase();

      if (method === "GET" && url.pathname === "/v1/ping") {
        this.sendJson(response, 200, {
          ok: true,
          data: this.buildDiscoveryRecord(),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/status") {
        this.sendJson(response, 200, {
          ok: true,
          data: await this.getStatusSnapshot(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/chat/ensure-open") {
        const body = await this.readJsonBody(request);
        const view = await this.ensureChatView({
          createIfMissing: true,
          reset: Boolean(body.reset),
          selectedModelId: typeof body.selectedModelId === "string" ? body.selectedModelId : undefined,
        });
        this.sendJson(response, 200, {
          ok: true,
          data: view.getAutomationSnapshot(),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/chat/snapshot") {
        const view = await this.ensureChatView({ createIfMissing: true });
        this.sendJson(response, 200, {
          ok: true,
          data: view.getAutomationSnapshot(),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/chat/models") {
        const view = await this.ensureChatView({ createIfMissing: true });
        this.sendJson(response, 200, {
          ok: true,
          data: {
            selectedModelId: view.getEffectiveSelectedModelId(),
            currentModelName: view.getCurrentModelName(),
            options: await loadChatModelPickerOptions(this.plugin),
          },
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/chat/model") {
        const body = await this.readJsonBody(request);
        const modelId = String(body.modelId || "").trim();
        if (!modelId) {
          throw new BridgeHttpError(400, "modelId is required.");
        }
        const view = await this.ensureChatView({ createIfMissing: true });
        await view.setSelectedModelId(modelId, { focusInput: false });
        this.sendJson(response, 200, {
          ok: true,
          data: view.getAutomationSnapshot(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/chat/input") {
        const body = await this.readJsonBody(request);
        const view = await this.ensureChatView({ createIfMissing: true });
        if (!("text" in body)) {
          throw new BridgeHttpError(400, "text is required.");
        }
        view.setInputText(body.text as string | object, { focus: false });
        this.sendJson(response, 200, {
          ok: true,
          data: view.getAutomationSnapshot(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/chat/web-search") {
        const body = await this.readJsonBody(request);
        const view = await this.ensureChatView({ createIfMissing: true });
        view.setWebSearchEnabled(Boolean(body.enabled));
        this.sendJson(response, 200, {
          ok: true,
          data: view.getAutomationSnapshot(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/chat/approval-mode") {
        const body = await this.readJsonBody(request);
        const mode = parseApprovalMode(body.mode);
        if (!mode) {
          throw new BridgeHttpError(400, "mode is required.");
        }
        const view = await this.ensureChatView({ createIfMissing: true });
        view.setAutomationApprovalMode(mode);
        this.sendJson(response, 200, {
          ok: true,
          data: view.getAutomationSnapshot(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/chat/send") {
        const body = await this.readJsonBody(request);
        const view = await this.ensureChatView({
          createIfMissing: true,
          reset: Boolean(body.reset),
          selectedModelId: typeof body.selectedModelId === "string" ? body.selectedModelId : undefined,
        });
        await view.sendAutomationMessage({
          text: body.text as string | object | undefined,
          includeContextFiles:
            typeof body.includeContextFiles === "boolean" ? body.includeContextFiles : undefined,
          approvalMode: parseApprovalMode(body.approvalMode),
          webSearchEnabled:
            typeof body.webSearchEnabled === "boolean" ? body.webSearchEnabled : undefined,
        });
        this.sendJson(response, 200, {
          ok: true,
          data: view.getAutomationSnapshot(),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/vault/read-text") {
        const vaultPath = normalizeVaultPath(url.searchParams.get("path"));
        this.sendJson(response, 200, {
          ok: true,
          data: await this.readVaultText(vaultPath),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/vault/write-text") {
        const body = await this.readJsonBody(request);
        const vaultPath = normalizeVaultPath(body.path);
        const content = String(body.content ?? "");
        this.sendJson(response, 200, {
          ok: true,
          data: await this.writeVaultText(vaultPath, content),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/web/fetch") {
        const body = await this.readJsonBody(request);
        const requestedUrl = String(body.url || "").trim();
        if (!requestedUrl) {
          throw new BridgeHttpError(400, "url is required.");
        }

        const api = this.plugin.getWebResearchApiService();
        const fetchResult = await api.fetch({
          url: requestedUrl,
          maxChars:
            typeof body.maxChars === "number" && Number.isFinite(body.maxChars) ? body.maxChars : undefined,
        });

        let persisted: Record<string, unknown> | null = null;
        if (body.persistToVault !== false) {
          const corpus = this.plugin.getWebResearchCorpusService();
          const chatId = String(body.chatId || `desktop-automation-web-${Date.now()}`);
          const writeResult = await corpus.writeFetchRun({
            chatId,
            url: requestedUrl,
            fetch: fetchResult,
          });
          persisted = {
            chatId,
            ...writeResult,
          };
        }

        this.sendJson(response, 200, {
          ok: true,
          data: {
            url: requestedUrl,
            fetch: fetchResult,
            persisted,
          },
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/youtube/transcript") {
        const body = await this.readJsonBody(request);
        const requestedUrl = String(body.url || "").trim();
        if (!requestedUrl) {
          throw new BridgeHttpError(400, "url is required.");
        }

        const service = this.plugin.getYouTubeTranscriptService();
        const transcript = await service.getTranscript(requestedUrl);
        this.sendJson(response, 200, {
          ok: true,
          data: {
            url: requestedUrl,
            transcript,
          },
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/plugin/reload") {
        response.once("finish", () => {
          setTimeout(() => {
            void this.performSelfReload();
          }, 50);
        });
        this.sendJson(response, 202, {
          ok: true,
          data: {
            scheduled: true,
            startedAt: this.startedAt,
          },
        });
        return;
      }

      throw new BridgeHttpError(404, `Unsupported desktop automation route: ${method} ${url.pathname}`);
    } catch (error) {
      const statusCode = error instanceof BridgeHttpError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      this.plugin.getLogger().error("Desktop automation bridge request failed", error, {
        source: "DesktopAutomationBridge",
      });
      this.sendJson(response, statusCode, {
        ok: false,
        error: message,
      });
    }
  }

  private assertAuthorized(request: IncomingMessage): void {
    const header = request.headers.authorization || request.headers["x-systemsculpt-automation-token"];
    const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
    if (!token || token !== this.token) {
      throw new BridgeHttpError(401, "Unauthorized desktop automation request.");
    }
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return {};
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BridgeHttpError(400, "Request body must be valid JSON.");
    }

    if (!isRecord(parsed)) {
      throw new BridgeHttpError(400, "Request body must be a JSON object.");
    }

    return parsed;
  }

  private sendJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
    if (response.headersSent) {
      return;
    }

    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(`${JSON.stringify(payload, null, 2)}\n`);
  }

  private async getStatusSnapshot(): Promise<Record<string, unknown>> {
    return {
      bridge: {
        host: this.host,
        port: this.port,
        startedAt: this.startedAt,
        discoveryFilePath: this.discoveryFilePath,
      },
      plugin: {
        id: this.plugin.manifest.id,
        version: this.plugin.manifest.version,
      },
      vault: {
        name: this.plugin.app.vault.getName(),
        path: this.getVaultPath(),
        configDir: this.plugin.app.vault.configDir,
        vaultInstanceId: this.plugin.settings.vaultInstanceId ?? null,
      },
      chat: await this.getChatSnapshotIfAvailable(),
    };
  }

  private async getChatSnapshotIfAvailable(): Promise<Record<string, unknown> | null> {
    try {
      const view = await this.ensureChatView({ createIfMissing: false });
      return view?.getAutomationSnapshot?.() ?? null;
    } catch {
      return null;
    }
  }

  private async getAutomationLeaf(createIfMissing: boolean): Promise<WorkspaceLeaf | null> {
    const existingLeaves = this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    const currentAutomationLeaf =
      this.automationLeaf && existingLeaves.includes(this.automationLeaf) ? this.automationLeaf : null;
    if (currentAutomationLeaf) {
      return currentAutomationLeaf;
    }

    const markedLeaf =
      existingLeaves.find((leaf) => Boolean((leaf as any).__systemsculptAutomation === true)) || null;
    if (markedLeaf) {
      this.automationLeaf = markedLeaf;
      return markedLeaf;
    }

    if (!createIfMissing) {
      return existingLeaves[0] || null;
    }

    let leaf: WorkspaceLeaf | null = null;
    try {
      leaf = this.plugin.app.workspace.getLeaf("tab");
    } catch {
      leaf = null;
    }

    if (!leaf) {
      leaf = this.plugin.app.workspace.getLeaf(true);
    }

    (leaf as any).__systemsculptAutomation = true;
    this.automationLeaf = leaf;
    return leaf;
  }

  private async ensureChatView(options: EnsureChatOptions = {}): Promise<ChatView> {
    const leaf = await this.getAutomationLeaf(Boolean(options.createIfMissing));
    if (!leaf) {
      throw new BridgeHttpError(404, "No chat view is available.");
    }

    const selectedModelId = String(options.selectedModelId || this.plugin.settings.selectedModelId || "").trim();
    const currentType = String(leaf.getViewState()?.type || "");
    if (options.reset || currentType !== CHAT_VIEW_TYPE) {
      await leaf.setViewState({
        type: CHAT_VIEW_TYPE,
        state: {
          chatId: "",
          selectedModelId,
          chatTitle: generateDefaultChatTitle(),
        },
      });
    }

    const view = await this.waitForChatViewReady(leaf);
    if (selectedModelId && view.getEffectiveSelectedModelId() !== selectedModelId) {
      await view.setSelectedModelId(selectedModelId, { focusInput: false });
    }

    return view;
  }

  private async waitForChatViewReady(leaf: WorkspaceLeaf): Promise<ChatView> {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const view = leaf.view as ChatView | null;
      if (
        view &&
        typeof view.getViewType === "function" &&
        view.getViewType() === CHAT_VIEW_TYPE &&
        view.inputHandler
      ) {
        return view;
      }

      await delay(100);
    }

    throw new Error("Timed out waiting for the automation chat view to become ready.");
  }

  private async readVaultText(vaultPath: string): Promise<Record<string, unknown>> {
    const file = this.plugin.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) {
      throw new BridgeHttpError(404, `Vault file not found: ${vaultPath}`);
    }

    return {
      path: vaultPath,
      absolutePath: resolveAbsoluteVaultPath(this.plugin.app.vault.adapter, vaultPath),
      content: await this.plugin.app.vault.read(file),
    };
  }

  private async writeVaultText(vaultPath: string, content: string): Promise<Record<string, unknown>> {
    await this.ensureVaultFolderExists(vaultPath);

    const existing = this.plugin.app.vault.getAbstractFileByPath(vaultPath);
    if (existing instanceof TFile) {
      await this.plugin.app.vault.modify(existing, content);
    } else {
      await this.plugin.app.vault.create(vaultPath, content);
    }

    return await this.readVaultText(vaultPath);
  }

  private async ensureVaultFolderExists(vaultPath: string): Promise<void> {
    const segments = normalizeVaultPath(vaultPath).split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (this.plugin.app.vault.getAbstractFileByPath(current)) {
        continue;
      }
      try {
        await this.plugin.app.vault.createFolder(current);
      } catch (error) {
        const message = String((error as Error)?.message || error || "");
        if (!/exist/i.test(message)) {
          throw error;
        }
      }
    }
  }

  private async performSelfReload(): Promise<void> {
    const plugins = (this.plugin.app as any)?.plugins;
    if (!plugins?.disablePlugin || !plugins?.enablePlugin) {
      throw new Error("Obsidian plugin manager is unavailable for reload.");
    }

    const pluginId = this.plugin.manifest.id;
    await plugins.disablePlugin(pluginId);
    await delay(150);
    await plugins.enablePlugin(pluginId);
  }
}
