import test from "node:test";
import assert from "node:assert/strict";
import {
  createObsidianReloadClient,
  waitForStableObsidianReloadClient,
} from "./client.mjs";

const OLD_RECORD = {
  host: "127.0.0.1",
  port: 62001,
  token: "old-token",
  startedAt: "old-generation",
};
const NEW_RECORD = {
  host: "127.0.0.1",
  port: 62002,
  token: "new-token",
  startedAt: "new-generation",
};

function response(data) {
  return { ok: true, status: 200, async json() { return { ok: true, data }; } };
}

test("reload client exposes only record, ping, status, and reload", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    if (String(url).endsWith("/v1/ping")) return response(OLD_RECORD);
    if (String(url).endsWith("/v1/status")) return response({ bridge: { reload: {} } });
    if (String(url).endsWith("/v1/plugin/reload")) return response({ scheduled: true });
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = await createObsidianReloadClient({ loadEntries: async () => [OLD_RECORD] });
    assert.deepEqual(Object.keys(client).sort(), ["ping", "record", "reloadPlugin", "status"]);
    assert.deepEqual(await client.reloadPlugin(), { scheduled: true });
    assert.equal(calls.at(-1).method, "POST");
    assert.equal(calls.at(-1).body, "{}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stable wait attaches to the new generation and confirms it settled", async () => {
  const originalFetch = globalThis.fetch;
  let statusCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/ping")) return response(NEW_RECORD);
    if (String(url).endsWith("/v1/status")) {
      statusCalls += 1;
      return response({ bridge: { reload: { inFlight: statusCalls === 1 } } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = await waitForStableObsidianReloadClient({
      loadEntries: async (options) =>
        options.excludeStartedAt === OLD_RECORD.startedAt ? [NEW_RECORD] : [],
      excludeStartedAt: OLD_RECORD.startedAt,
      timeoutMs: 1000,
      intervalMs: 50,
      settleMs: 50,
    });
    assert.equal(client.record.startedAt, NEW_RECORD.startedAt);
    assert.ok(statusCalls >= 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
