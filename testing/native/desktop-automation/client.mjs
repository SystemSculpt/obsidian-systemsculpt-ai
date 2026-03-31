import { loadDiscoveryEntries } from "./discovery.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBaseUrl(record) {
  return `http://${record.host || "127.0.0.1"}:${record.port}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isRecoveryCandidateError(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("unauthorized desktop automation request") ||
    [
      "fetch failed",
      "networkerror",
      "network error",
      "socket hang up",
      "other side closed",
      "econnrefused",
      "econnreset",
      "aborted",
    ].some((needle) => message.includes(needle))
  );
}

function isSameBridgeRecord(left, right) {
  if (!left || !right) {
    return false;
  }

  return (
    String(left.host || "127.0.0.1") === String(right.host || "127.0.0.1") &&
    Number(left.port) === Number(right.port) &&
    String(left.token || "") === String(right.token || "") &&
    String(left.startedAt || "") === String(right.startedAt || "")
  );
}

async function requestJson(baseUrl, token, pathname, options = {}) {
  const method = options.method || "GET";
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 300000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
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

export class DesktopAutomationClient {
  constructor(record, options = {}) {
    this.record = record;
    this.discoveryOptions = options.discoveryOptions || null;
    this.loadEntries = typeof options.loadEntries === "function" ? options.loadEntries : loadDiscoveryEntries;
    this.baseUrl = buildBaseUrl(record);
  }

  setRecord(record) {
    this.record = record;
    this.baseUrl = buildBaseUrl(record);
  }

  async findNextLiveRecord(options = {}) {
    if (!this.discoveryOptions) {
      return null;
    }

    const entries = await this.loadEntries(this.discoveryOptions);
    if (!Array.isArray(entries) || entries.length === 0) {
      return null;
    }

    const orderedEntries = options.preferDifferentRecord
      ? [
          ...entries.filter((entry) => !isSameBridgeRecord(entry, this.record)),
          ...entries.filter((entry) => isSameBridgeRecord(entry, this.record)),
        ]
      : entries;

    for (const entry of orderedEntries) {
      try {
        await requestJson(buildBaseUrl(entry), entry.token, "/v1/ping", { timeoutMs: 5000 });
        return entry;
      } catch {}
    }

    return null;
  }

  async refreshRecord(options = {}) {
    const nextRecord = await this.findNextLiveRecord(options);
    if (!nextRecord || isSameBridgeRecord(nextRecord, this.record)) {
      return false;
    }

    this.setRecord(nextRecord);
    return true;
  }

  async request(pathname, options = {}) {
    try {
      if (options.preflightRefresh !== false) {
        await this.refreshRecord();
      }
      return await requestJson(this.baseUrl, this.record.token, pathname, options);
    } catch (error) {
      if (!options.allowRecovery || !this.discoveryOptions || !isRecoveryCandidateError(error)) {
        throw error;
      }

      const recovered = await this.refreshRecord({ preferDifferentRecord: true });
      if (!recovered) {
        throw error;
      }

      return await requestJson(this.baseUrl, this.record.token, pathname, {
        ...options,
        allowRecovery: false,
        preflightRefresh: false,
      });
    }
  }

  async ping() {
    return await this.request("/v1/ping", {
      timeoutMs: 5000,
      allowRecovery: false,
      preflightRefresh: false,
    });
  }

  async status() {
    return await this.request("/v1/status", { timeoutMs: 10000, allowRecovery: true });
  }

  async getSettingsSnapshot() {
    return await this.request("/v1/settings/snapshot", {
      timeoutMs: 10000,
      allowRecovery: true,
    });
  }

  async openSettings(targetTab = "account") {
    return await this.request("/v1/settings/open", {
      method: "POST",
      body: { targetTab },
      timeoutMs: 30000,
      allowRecovery: true,
    });
  }

  async getProvidersSnapshot(body = {}) {
    const requestBody =
      body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
    const preflightRefresh = requestBody.preflightRefresh !== false;
    delete requestBody.preflightRefresh;
    return await this.request("/v1/settings/providers/snapshot", {
      method: "POST",
      body: requestBody,
      timeoutMs: 60000,
      allowRecovery: true,
      preflightRefresh,
    });
  }

  async setProviderApiKey(providerId, apiKey) {
    return await this.request("/v1/settings/providers/api-key", {
      method: "POST",
      body: { providerId, apiKey },
      timeoutMs: 60000,
      allowRecovery: true,
    });
  }

  async clearProviderAuth(providerId) {
    return await this.request("/v1/settings/providers/clear-auth", {
      method: "POST",
      body: { providerId },
      timeoutMs: 60000,
      allowRecovery: true,
    });
  }

  async ensureChatOpen(body = {}) {
    return await this.request("/v1/chat/ensure-open", {
      method: "POST",
      body,
      timeoutMs: 30000,
      allowRecovery: true,
    });
  }

  async openChatHistory(body = {}) {
    return await this.request("/v1/chat/open-history", {
      method: "POST",
      body,
      timeoutMs: 30000,
      allowRecovery: true,
    });
  }

  async getChatSnapshot() {
    return await this.request("/v1/chat/snapshot", { timeoutMs: 10000, allowRecovery: true });
  }

  async listModels(options = {}) {
    const preflightRefresh = options.preflightRefresh !== false;
    const params = new URLSearchParams();
    if (options.refresh) {
      params.set("refresh", "1");
    }
    const pathname = params.size > 0 ? `/v1/chat/models?${params.toString()}` : "/v1/chat/models";
    return await this.request(pathname, {
      timeoutMs: 60000,
      allowRecovery: true,
      preflightRefresh,
    });
  }

  async setModel(modelId) {
    return await this.request("/v1/chat/model", {
      method: "POST",
      body: { modelId },
      timeoutMs: 60000,
      allowRecovery: true,
    });
  }

  async setInput(text) {
    return await this.request("/v1/chat/input", {
      method: "POST",
      body: { text },
      timeoutMs: 10000,
      allowRecovery: true,
    });
  }

  async setWebSearch(enabled) {
    return await this.request("/v1/chat/web-search", {
      method: "POST",
      body: { enabled: !!enabled },
      timeoutMs: 10000,
      allowRecovery: true,
    });
  }

  async setApprovalMode(mode) {
    return await this.request("/v1/chat/approval-mode", {
      method: "POST",
      body: { mode },
      timeoutMs: 10000,
      allowRecovery: true,
    });
  }

  async sendChat(body = {}) {
    return await this.request("/v1/chat/send", {
      method: "POST",
      body,
      timeoutMs: body.timeoutMs || 300000,
      allowRecovery: false,
    });
  }

  async readVaultText(vaultPath) {
    const pathParam = encodeURIComponent(vaultPath);
    return await this.request(`/v1/vault/read-text?path=${pathParam}`, {
      timeoutMs: 30000,
      allowRecovery: true,
    });
  }

  async writeVaultText(vaultPath, content) {
    return await this.request("/v1/vault/write-text", {
      method: "POST",
      body: { path: vaultPath, content },
      timeoutMs: 30000,
      allowRecovery: true,
    });
  }

  async fetchWeb(body = {}) {
    return await this.request("/v1/web/fetch", {
      method: "POST",
      body,
      timeoutMs: 180000,
      allowRecovery: true,
    });
  }

  async getYouTubeTranscript(body = {}) {
    return await this.request("/v1/youtube/transcript", {
      method: "POST",
      body,
      timeoutMs: 300000,
      allowRecovery: true,
    });
  }

  async reloadPlugin() {
    return await this.request("/v1/plugin/reload", {
      method: "POST",
      body: {},
      timeoutMs: 10000,
      allowRecovery: false,
    });
  }
}

export async function createDesktopAutomationClient(options = {}) {
  const loadEntries = typeof options.loadEntries === "function" ? options.loadEntries : loadDiscoveryEntries;
  const entries = await loadEntries(options);
  const errors = [];

  for (const entry of entries) {
    const client = new DesktopAutomationClient(entry, {
      discoveryOptions: options,
      loadEntries,
    });
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

function getClientStabilityKey(client, status) {
  const bridgeStartedAt =
    String(status?.bridge?.startedAt || client?.record?.startedAt || "").trim() || "unknown-started-at";
  return `${client.baseUrl}|${String(client?.record?.token || "").trim()}|${bridgeStartedAt}`;
}

function isBridgeReloading(status) {
  const reload = status?.bridge?.reload;
  return Boolean(reload?.scheduled || reload?.inFlight);
}

export async function waitForStableDesktopAutomationClient(options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const intervalMs = Math.max(100, options.intervalMs || 500);
  const settleIntervalMs = Math.max(100, options.settleIntervalMs || 250);
  const stableForMs = Math.max(settleIntervalMs, options.stableForMs || 1500);
  const startedAt = Date.now();

  let lastError = null;
  let client = null;
  let stableKey = "";
  let stableSince = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (!client) {
        client = await createDesktopAutomationClient(options);
        stableKey = "";
        stableSince = 0;
      }

      const status = await client.status();
      const nextStableKey = getClientStabilityKey(client, status);

      if (isBridgeReloading(status) || nextStableKey !== stableKey) {
        stableKey = nextStableKey;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableForMs) {
        return client;
      }

      await sleep(settleIntervalMs);
    } catch (error) {
      lastError = error;
      client = null;
      stableKey = "";
      stableSince = 0;
      await sleep(intervalMs);
    }
  }

  throw lastError || new Error("Timed out waiting for a stable live desktop automation bridge.");
}
