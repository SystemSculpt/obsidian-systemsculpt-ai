import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bootstrapDesktopAutomationClient,
  diagnoseStaleDesktopAutomationRuntime,
  resolvePluginTarget,
} from "./bootstrap.mjs";

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

test("diagnoseStaleDesktopAutomationRuntime explains when the synced bundle is newer than the running bridge session", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-automation-bootstrap-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const vaultRoot = path.join(tempDir, "automation-vault");
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", "systemsculpt-ai");
  const diagnosticsDir = path.join(vaultRoot, ".systemsculpt", "diagnostics");
  const mainFilePath = path.join(pluginDir, "main.js");

  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(diagnosticsDir, { recursive: true });
  await fs.writeFile(mainFilePath, "module.exports = {};\n", "utf8");
  await fs.writeFile(
    path.join(diagnosticsDir, "session-latest.json"),
    `${JSON.stringify(
      {
        startedAt: "2026-03-30T02:59:14.095Z",
        bootstrappedAt: null,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await fs.utimes(
    mainFilePath,
    new Date("2026-03-30T03:38:29.260Z"),
    new Date("2026-03-30T03:38:29.260Z")
  );

  const diagnosis = await diagnoseStaleDesktopAutomationRuntime(
    {
      mainFilePath,
      vaultRoot,
      vaultName: "automation-vault",
    },
    {
      loadEntries: async () => [
        {
          ...OLD_RECORD,
          vaultName: "automation-vault",
          vaultPath: vaultRoot,
          startedAt: "2026-03-30T02:59:14.095Z",
        },
      ],
    }
  );

  assert.match(
    diagnosis,
    /synced main\.js on disk is newer than the last published bridge session/i
  );
  assert.match(diagnosis, /never reached bootstrappedAt/i);
  assert.match(diagnosis, /manual plugin reload or Obsidian restart once/i);
});

test("diagnoseStaleDesktopAutomationRuntime ignores bridges that are already current with the synced bundle", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-automation-bootstrap-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const vaultRoot = path.join(tempDir, "automation-vault");
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", "systemsculpt-ai");
  const mainFilePath = path.join(pluginDir, "main.js");

  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(mainFilePath, "module.exports = {};\n", "utf8");
  await fs.utimes(
    mainFilePath,
    new Date("2026-03-30T02:59:14.000Z"),
    new Date("2026-03-30T02:59:14.000Z")
  );

  const diagnosis = await diagnoseStaleDesktopAutomationRuntime(
    {
      mainFilePath,
      vaultRoot,
      vaultName: "automation-vault",
    },
    {
      loadEntries: async () => [
        {
          ...OLD_RECORD,
          vaultName: "automation-vault",
          vaultPath: vaultRoot,
          startedAt: "2026-03-30T02:59:14.095Z",
        },
      ],
    }
  );

  assert.equal(diagnosis, null);
});

test("resolvePluginTarget prefers the latest live discovery-matching target when selectors are omitted", async () => {
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
    createClient: async () => ({
      record: {
        pluginId: "systemsculpt-ai",
        vaultName: "notes-b",
        vaultPath: "/tmp/notes-b",
      },
    }),
  });

  assert.equal(resolved, targets[1]);
});

test("resolvePluginTarget falls back to the first synced target when discovery has no live bridge", async () => {
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
    createClient: async () => {
      throw new Error("No live desktop automation bridge was found.");
    },
  });

  assert.equal(resolved, targets[0]);
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

test("bootstrapDesktopAutomationClient tries the next synced target when the first target has no live bridge", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-automation-bootstrap-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const makeTarget = async (name, index) => {
    const vaultRoot = path.join(tempDir, name);
    const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", "systemsculpt-ai");
    const dataFilePath = path.join(pluginDir, "data.json");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      dataFilePath,
      `${JSON.stringify(
        {
          settingsMode: "advanced",
          desktopAutomationBridgeEnabled: true,
          vaultInstanceId: `${name}-instance`,
          selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    return {
      index,
      configPath: path.join(tempDir, "systemsculpt-sync.config.json"),
      pluginDir,
      dataFilePath,
      manifestFilePath: path.join(pluginDir, "manifest.json"),
      mainFilePath: path.join(pluginDir, "main.js"),
      vaultRoot,
      vaultName: name,
    };
  };

  const firstTarget = await makeTarget("notes-a", 0);
  const secondTarget = await makeTarget("notes-b", 1);

  const loadEntries = async (options = {}) => {
    if (options.vaultName === "notes-b") {
      return [
        {
          ...NEW_RECORD,
          vaultName: "notes-b",
          vaultPath: secondTarget.vaultRoot,
        },
      ];
    }
    return [];
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const authorization = String(options.headers?.authorization || "");

    if (method !== "GET") {
      throw new Error(`Unexpected method: ${method}`);
    }
    if (url === "http://127.0.0.1:62002/v1/ping" && authorization === "Bearer token-new") {
      return jsonResponse({
        ok: true,
        data: {
          ...NEW_RECORD,
          vaultName: "notes-b",
          vaultPath: secondTarget.vaultRoot,
        },
      });
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
    throw new Error(`Unexpected fetch call: ${method} ${url} ${authorization}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await bootstrapDesktopAutomationClient({
    targets: [firstTarget, secondTarget],
    loadEntries,
    reload: false,
    timeoutMs: 350,
    intervalMs: 50,
    settleIntervalMs: 50,
    stableForMs: 120,
  });

  assert.equal(result.target.vaultName, "notes-b");
  assert.equal(result.client.baseUrl, "http://127.0.0.1:62002");
});
