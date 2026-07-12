import { loadDiscoveryEntries } from "./discovery.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseUrl(record) {
  return `http://${record.host || "127.0.0.1"}:${record.port}`;
}

async function requestJson(record, pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const response = await fetch(`${baseUrl(record)}${pathname}`, {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${record.token}`,
        "content-type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `HTTP ${response.status} from ${pathname}`);
    }
    return payload?.data;
  } finally {
    clearTimeout(timeout);
  }
}

function reloadClient(record) {
  return {
    record,
    async ping() {
      return await requestJson(record, "/v1/ping", { timeoutMs: 5000 });
    },
    async status() {
      return await requestJson(record, "/v1/status");
    },
    async reloadPlugin() {
      return await requestJson(record, "/v1/plugin/reload", {
        method: "POST",
        body: {},
      });
    },
  };
}

export async function createObsidianReloadClient(options = {}) {
  const loadEntries = options.loadEntries || loadDiscoveryEntries;
  const entries = await loadEntries(options);
  const errors = [];

  for (const entry of entries) {
    const client = reloadClient(entry);
    try {
      await client.ping();
      return client;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(
    `No live Obsidian reload bridge was found.${errors.length ? ` ${errors.join(" | ")}` : ""}`,
  );
}

export async function waitForObsidianReloadClient(options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  const intervalMs = Math.max(50, options.intervalMs || 250);
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await createObsidianReloadClient(options);
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw lastError || new Error("Timed out waiting for the Obsidian reload bridge.");
}

function isReloading(status) {
  return Boolean(status?.bridge?.reload?.scheduled || status?.bridge?.reload?.inFlight);
}

export async function waitForStableObsidianReloadClient(options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  const intervalMs = Math.max(50, options.intervalMs || 250);
  const settleMs = Math.max(50, options.settleMs || 250);
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const client = await createObsidianReloadClient(options);
      if (isReloading(await client.status())) {
        await sleep(intervalMs);
        continue;
      }
      await sleep(settleMs);
      if (!isReloading(await client.status())) return client;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw lastError || new Error("Timed out waiting for a stable Obsidian reload bridge.");
}
