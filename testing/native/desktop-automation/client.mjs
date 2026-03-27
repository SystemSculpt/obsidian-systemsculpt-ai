import { loadDiscoveryEntries } from "./discovery.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DesktopAutomationClient {
  constructor(record) {
    this.record = record;
    this.baseUrl = `http://${record.host || "127.0.0.1"}:${record.port}`;
  }

  async request(pathname, options = {}) {
    const method = options.method || "GET";
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 300000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.record.token}`,
          "content-type": options.body ? "application/json" : "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        const message = payload?.error || `HTTP ${response.status} from ${pathname}`;
        throw new Error(message);
      }
      return payload?.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ping() {
    return await this.request("/v1/ping", { timeoutMs: 5000 });
  }

  async status() {
    return await this.request("/v1/status", { timeoutMs: 10000 });
  }

  async ensureChatOpen(body = {}) {
    return await this.request("/v1/chat/ensure-open", {
      method: "POST",
      body,
      timeoutMs: 30000,
    });
  }

  async getChatSnapshot() {
    return await this.request("/v1/chat/snapshot", { timeoutMs: 10000 });
  }

  async listModels() {
    return await this.request("/v1/chat/models", { timeoutMs: 60000 });
  }

  async setModel(modelId) {
    return await this.request("/v1/chat/model", {
      method: "POST",
      body: { modelId },
      timeoutMs: 60000,
    });
  }

  async setInput(text) {
    return await this.request("/v1/chat/input", {
      method: "POST",
      body: { text },
      timeoutMs: 10000,
    });
  }

  async setWebSearch(enabled) {
    return await this.request("/v1/chat/web-search", {
      method: "POST",
      body: { enabled: !!enabled },
      timeoutMs: 10000,
    });
  }

  async setApprovalMode(mode) {
    return await this.request("/v1/chat/approval-mode", {
      method: "POST",
      body: { mode },
      timeoutMs: 10000,
    });
  }

  async sendChat(body = {}) {
    return await this.request("/v1/chat/send", {
      method: "POST",
      body,
      timeoutMs: body.timeoutMs || 300000,
    });
  }

  async readVaultText(vaultPath) {
    const pathParam = encodeURIComponent(vaultPath);
    return await this.request(`/v1/vault/read-text?path=${pathParam}`, { timeoutMs: 30000 });
  }

  async writeVaultText(vaultPath, content) {
    return await this.request("/v1/vault/write-text", {
      method: "POST",
      body: { path: vaultPath, content },
      timeoutMs: 30000,
    });
  }

  async fetchWeb(body = {}) {
    return await this.request("/v1/web/fetch", {
      method: "POST",
      body,
      timeoutMs: 180000,
    });
  }

  async getYouTubeTranscript(body = {}) {
    return await this.request("/v1/youtube/transcript", {
      method: "POST",
      body,
      timeoutMs: 300000,
    });
  }

  async reloadPlugin() {
    return await this.request("/v1/plugin/reload", {
      method: "POST",
      body: {},
      timeoutMs: 10000,
    });
  }
}

export async function createDesktopAutomationClient(options = {}) {
  const entries = await loadDiscoveryEntries(options);
  const errors = [];

  for (const entry of entries) {
    const client = new DesktopAutomationClient(entry);
    try {
      await client.ping();
      return client;
    } catch (error) {
      errors.push(`${entry.discoveryFilePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const suffix = errors.length > 0 ? ` Tried: ${errors.join(" | ")}` : "";
  throw new Error(`No live desktop automation bridge was found.${suffix}`);
}

export async function waitForDesktopAutomationClient(options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const intervalMs = options.intervalMs || 500;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await createDesktopAutomationClient(options);
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw lastError || new Error("Timed out waiting for a live desktop automation bridge.");
}
