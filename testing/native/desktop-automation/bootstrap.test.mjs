import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapDesktopAutomationClient, resolvePluginTarget } from "./bootstrap.mjs";

function jsonResponse(payload, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || (options.ok === false ? 500 : 200),
    async json() {
      return payload;
    },
  };
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

test("resolvePluginTarget prefers the latest discovery-matching target when selectors are omitted", async () => {
  const targets = [
    {
      index: 0,
      vaultName: "notes-a",
      vaultRoot: "/tmp/notes-a",
    },
    {
      index: 1,
      vaultName: "notes-b",
      vaultRoot: "/tmp/notes-b",
    },
  ];

  const resolved = await resolvePluginTarget(targets, {
    loadEntries: async () => [
      {
        pluginId: "systemsculpt-ai",
        vaultName: "notes-b",
        vaultPath: "/tmp/notes-b",
      },
    ],
  });

  assert.equal(resolved, targets[1]);
});

test("bootstrapDesktopAutomationClient does not rewrite data.json on every poll while waiting for recovery", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-automation-bootstrap-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
  const vaultRoot = path.join(tempDir, "automation-vault");
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", "systemsculpt-ai");
  const dataFilePath = path.join(pluginDir, "data.json");

  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    dataFilePath,
    `${JSON.stringify(
      {
        settingsMode: "advanced",
        desktopAutomationBridgeEnabled: true,
        vaultInstanceId: "vault-instance",
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const target = {
    index: 0,
    configPath: path.join(tempDir, "systemsculpt-sync.config.json"),
    pluginDir,
    dataFilePath,
    manifestFilePath: path.join(pluginDir, "manifest.json"),
    mainFilePath: path.join(pluginDir, "main.js"),
    vaultRoot,
    vaultName: "automation-vault",
  };

  let pluginDataWrites = 0;
  const originalWriteFile = fs.writeFile.bind(fs);
  t.mock.method(fs, "writeFile", async (...args) => {
    if (String(args[0]) === dataFilePath) {
      pluginDataWrites += 1;
    }
    return await originalWriteFile(...args);
  });

  await assert.rejects(
    bootstrapDesktopAutomationClient({
      targets: [target],
      loadEntries: async () => [],
      timeoutMs: 350,
      intervalMs: 100,
      settingsReassertIntervalMs: 1000,
    }),
    /No live desktop automation bridge was found after updating data\.json/
  );

  assert.equal(pluginDataWrites, 1);
});

test("bootstrapDesktopAutomationClient waits for the stable bridge generation before returning attach-only clients", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-automation-bootstrap-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
  const vaultRoot = path.join(tempDir, "automation-vault");
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", "systemsculpt-ai");
  const dataFilePath = path.join(pluginDir, "data.json");

  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    dataFilePath,
    `${JSON.stringify(
      {
        settingsMode: "advanced",
        desktopAutomationBridgeEnabled: true,
        vaultInstanceId: "vault-instance",
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const target = {
    index: 0,
    configPath: path.join(tempDir, "systemsculpt-sync.config.json"),
    pluginDir,
    dataFilePath,
    manifestFilePath: path.join(pluginDir, "manifest.json"),
    mainFilePath: path.join(pluginDir, "main.js"),
    vaultRoot,
    vaultName: "automation-vault",
  };

  let loadEntriesCalls = 0;
  const loadEntries = async () => {
    loadEntriesCalls += 1;
    return loadEntriesCalls === 1 ? [OLD_RECORD] : [NEW_RECORD, OLD_RECORD];
  };

  const originalFetch = globalThis.fetch;
  let newStatusCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const authorization = String(options.headers?.authorization || "");

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
      newStatusCalls += 1;
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
    throw new Error(`Unexpected fetch call: ${method} ${url} ${authorization}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await bootstrapDesktopAutomationClient({
    targets: [target],
    loadEntries,
    reload: false,
    timeoutMs: 2000,
    intervalMs: 100,
    settleIntervalMs: 100,
    stableForMs: 220,
  });

  assert.equal(result.reload.method, "none");
  assert.equal(result.client.baseUrl, "http://127.0.0.1:62002");
  assert.equal(result.client.record.startedAt, NEW_RECORD.startedAt);
  assert.ok(loadEntriesCalls >= 2);
  assert.ok(newStatusCalls >= 3);
});
