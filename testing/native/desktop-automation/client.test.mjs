import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopAutomationClient, waitForStableDesktopAutomationClient } from "./client.mjs";

function jsonResponse(payload, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || (options.ok === false ? 500 : 200),
    async json() {
      return payload;
    },
  };
}

function createFetchStub(routeHandler) {
  const calls = [];
  const fetchStub = async (url, options = {}) => {
    const normalizedCall = {
      url: String(url),
      method: String(options.method || "GET").toUpperCase(),
      authorization: String(options.headers?.authorization || ""),
    };
    calls.push(normalizedCall);
    return await routeHandler(normalizedCall);
  };
  fetchStub.calls = calls;
  return fetchStub;
}

const OLD_RECORD = {
  host: "127.0.0.1",
  port: 62001,
  token: "token-old",
  startedAt: "2026-03-28T00:00:00.000Z",
  discoveryFilePath: "/tmp/old.json",
};

const NEW_RECORD = {
  host: "127.0.0.1",
  port: 62002,
  token: "token-new",
  startedAt: "2026-03-28T00:00:05.000Z",
  discoveryFilePath: "/tmp/new.json",
};

const NEWER_RECORD = {
  host: "127.0.0.1",
  port: 62003,
  token: "token-newer",
  startedAt: "2026-03-28T00:00:10.000Z",
  discoveryFilePath: "/tmp/newer.json",
};

test("createDesktopAutomationClient refreshes itself when discovery rolls to a newer bridge record", async () => {
  let loadEntriesCalls = 0;
  const loadEntries = async () => {
    loadEntriesCalls += 1;
    return loadEntriesCalls === 1 ? [OLD_RECORD] : [NEW_RECORD];
  };

  const originalFetch = globalThis.fetch;
  const fetchStub = createFetchStub(async ({ url, method, authorization }) => {
    if (method !== "GET") {
      throw new Error(`Unexpected method: ${method}`);
    }
    if (url === "http://127.0.0.1:62001/v1/ping" && authorization === "Bearer token-old") {
      return jsonResponse({ ok: true, data: OLD_RECORD });
    }
    if (url === "http://127.0.0.1:62002/v1/ping" && authorization === "Bearer token-new") {
      return jsonResponse({ ok: true, data: NEW_RECORD });
    }
    if (url === "http://127.0.0.1:62002/v1/status" && authorization === "Bearer token-new") {
      return jsonResponse({ ok: true, data: { marker: "new-bridge" } });
    }
    throw new Error(`Unexpected fetch call: ${method} ${url} ${authorization}`);
  });

  globalThis.fetch = fetchStub;
  try {
    const client = await createDesktopAutomationClient({
      vaultName: "automation-vault",
      loadEntries,
    });

    assert.equal(client.baseUrl, "http://127.0.0.1:62001");

    const status = await client.status();

    assert.deepEqual(status, { marker: "new-bridge" });
    assert.equal(client.baseUrl, "http://127.0.0.1:62002");
    assert.deepEqual(
      fetchStub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET http://127.0.0.1:62001/v1/ping",
        "GET http://127.0.0.1:62002/v1/ping",
        "GET http://127.0.0.1:62002/v1/status",
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DesktopAutomationClient retries once on unauthorized after discovery publishes a replacement bridge", async () => {
  let loadEntriesCalls = 0;
  const loadEntries = async () => {
    loadEntriesCalls += 1;
    if (loadEntriesCalls <= 2) {
      return [OLD_RECORD];
    }
    return [NEW_RECORD];
  };

  const originalFetch = globalThis.fetch;
  const fetchStub = createFetchStub(async ({ url, method, authorization }) => {
    if (method !== "GET") {
      throw new Error(`Unexpected method: ${method}`);
    }
    if (url === "http://127.0.0.1:62001/v1/ping" && authorization === "Bearer token-old") {
      return jsonResponse({ ok: true, data: OLD_RECORD });
    }
    if (url === "http://127.0.0.1:62001/v1/status" && authorization === "Bearer token-old") {
      return jsonResponse(
        { ok: false, error: "Unauthorized desktop automation request." },
        { ok: false, status: 401 },
      );
    }
    if (url === "http://127.0.0.1:62002/v1/ping" && authorization === "Bearer token-new") {
      return jsonResponse({ ok: true, data: NEW_RECORD });
    }
    if (url === "http://127.0.0.1:62002/v1/status" && authorization === "Bearer token-new") {
      return jsonResponse({ ok: true, data: { marker: "recovered" } });
    }
    throw new Error(`Unexpected fetch call: ${method} ${url} ${authorization}`);
  });

  globalThis.fetch = fetchStub;
  try {
    const client = await createDesktopAutomationClient({
      vaultName: "automation-vault",
      loadEntries,
    });

    const status = await client.status();

    assert.deepEqual(status, { marker: "recovered" });
    assert.equal(client.baseUrl, "http://127.0.0.1:62002");
    assert.deepEqual(
      fetchStub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET http://127.0.0.1:62001/v1/ping",
        "GET http://127.0.0.1:62001/v1/ping",
        "GET http://127.0.0.1:62001/v1/status",
        "GET http://127.0.0.1:62002/v1/ping",
        "GET http://127.0.0.1:62002/v1/status",
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("waitForStableDesktopAutomationClient waits for the bridge generation to settle after reload churn", async () => {
  let loadEntriesCalls = 0;
  const loadEntries = async () => {
    loadEntriesCalls += 1;
    if (loadEntriesCalls <= 2) {
      return [NEW_RECORD];
    }
    return [NEWER_RECORD, NEW_RECORD];
  };

  const originalFetch = globalThis.fetch;
  const fetchStub = createFetchStub(async ({ url, method, authorization }) => {
    if (method !== "GET") {
      throw new Error(`Unexpected method: ${method}`);
    }
    if (url === "http://127.0.0.1:62002/v1/ping" && authorization === "Bearer token-new") {
      return jsonResponse({ ok: true, data: NEW_RECORD });
    }
    if (url === "http://127.0.0.1:62002/v1/status" && authorization === "Bearer token-new") {
      return jsonResponse({
        ok: true,
        data: {
          bridge: {
            startedAt: NEW_RECORD.startedAt,
            reload: {
              scheduled: false,
              inFlight: false,
            },
          },
        },
      });
    }
    if (url === "http://127.0.0.1:62003/v1/ping" && authorization === "Bearer token-newer") {
      return jsonResponse({ ok: true, data: NEWER_RECORD });
    }
    if (url === "http://127.0.0.1:62003/v1/status" && authorization === "Bearer token-newer") {
      return jsonResponse({
        ok: true,
        data: {
          bridge: {
            startedAt: NEWER_RECORD.startedAt,
            reload: {
              scheduled: false,
              inFlight: false,
            },
          },
        },
      });
    }
    throw new Error(`Unexpected fetch call: ${method} ${url} ${authorization}`);
  });

  globalThis.fetch = fetchStub;
  try {
    const client = await waitForStableDesktopAutomationClient({
      vaultName: "automation-vault",
      loadEntries,
      timeoutMs: 2000,
      intervalMs: 100,
      settleIntervalMs: 100,
      stableForMs: 220,
    });

    assert.equal(client.baseUrl, "http://127.0.0.1:62003");
    assert.equal(client.record.startedAt, NEWER_RECORD.startedAt);
    const calls = fetchStub.calls.map((call) => `${call.method} ${call.url}`);
    assert.deepEqual(calls.slice(0, 5), [
      "GET http://127.0.0.1:62002/v1/ping",
      "GET http://127.0.0.1:62002/v1/ping",
      "GET http://127.0.0.1:62002/v1/status",
      "GET http://127.0.0.1:62003/v1/ping",
      "GET http://127.0.0.1:62003/v1/status",
    ]);
    assert.ok(
      calls.filter((call) => call === "GET http://127.0.0.1:62003/v1/status").length >= 3,
      "expected the newer bridge to be observed repeatedly before resolving",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("waitForStableDesktopAutomationClient does not resolve while the bridge still reports reload in flight", async () => {
  let statusCalls = 0;
  const loadEntries = async () => [NEW_RECORD];

  const originalFetch = globalThis.fetch;
  const fetchStub = createFetchStub(async ({ url, method, authorization }) => {
    if (method !== "GET") {
      throw new Error(`Unexpected method: ${method}`);
    }
    if (url === "http://127.0.0.1:62002/v1/ping" && authorization === "Bearer token-new") {
      return jsonResponse({ ok: true, data: NEW_RECORD });
    }
    if (url === "http://127.0.0.1:62002/v1/status" && authorization === "Bearer token-new") {
      statusCalls += 1;
      return jsonResponse({
        ok: true,
        data: {
          bridge: {
            startedAt: NEW_RECORD.startedAt,
            reload: {
              scheduled: false,
              inFlight: statusCalls === 1,
            },
          },
        },
      });
    }
    throw new Error(`Unexpected fetch call: ${method} ${url} ${authorization}`);
  });

  globalThis.fetch = fetchStub;
  try {
    const client = await waitForStableDesktopAutomationClient({
      vaultName: "automation-vault",
      loadEntries,
      timeoutMs: 2000,
      intervalMs: 100,
      settleIntervalMs: 100,
      stableForMs: 220,
    });

    assert.equal(client.baseUrl, "http://127.0.0.1:62002");
    assert.equal(statusCalls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
