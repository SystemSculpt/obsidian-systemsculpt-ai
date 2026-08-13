/** @jest-environment jsdom */

import { App, Platform } from "obsidian";

import { DiagnosticsSessionLifecycle } from "../DiagnosticsSessionLifecycle";

type TestFile = Readonly<{
  contents: string;
  mtime: number;
  size: number;
}>;

const DIAGNOSTICS_PATH = ".systemsculpt/diagnostics";
const NOW = Date.UTC(2026, 7, 13, 16, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 250;
const CLEANUP_TOTAL_TIMEOUT_MS = 2_000;

function makeStorage(writeFile: jest.Mock = jest.fn(async () => ({ success: true, path: "saved" }))) {
  return {
    getPath: jest.fn(() => DIAGNOSTICS_PATH),
    writeFile,
  };
}

function makeLifecycle(
  app: App = new App(),
  storage = makeStorage(),
  pluginVersion: unknown = "6.6.0",
  getObsidianVersion: () => unknown = () => "1.13.2",
): DiagnosticsSessionLifecycle {
  return new DiagnosticsSessionLifecycle({
    adapter: app.vault.adapter,
    storage,
    pluginVersion,
    getObsidianVersion,
  });
}

function makeDiagnosticsAdapter(
  files: Readonly<Record<string, TestFile>>,
  explicitDirectories: readonly string[] = [],
) {
  const entries = new Map(Object.entries(files));
  const directories = new Set(explicitDirectories);
  for (const path of entries.keys()) {
    let separatorIndex = path.lastIndexOf("/");
    while (separatorIndex > DIAGNOSTICS_PATH.length) {
      const directory = path.slice(0, separatorIndex);
      directories.add(directory);
      separatorIndex = directory.lastIndexOf("/");
    }
  }
  return {
    list: jest.fn(async (path: string) => {
      const prefix = `${path}/`;
      const directFiles = [...entries.keys()].filter((entryPath) => {
        if (!entryPath.startsWith(prefix)) return false;
        return !entryPath.slice(prefix.length).includes("/");
      });
      const directFolders = [...directories].filter((directoryPath) => {
        if (!directoryPath.startsWith(prefix)) return false;
        return !directoryPath.slice(prefix.length).includes("/");
      });
      return { files: directFiles, folders: directFolders };
    }),
    stat: jest.fn(async (path: string) => {
      const file = entries.get(path);
      return file ? { type: "file", ctime: file.mtime, mtime: file.mtime, size: file.size } : null;
    }),
    read: jest.fn(async (path: string) => entries.get(path)?.contents ?? ""),
    remove: jest.fn(async (path: string) => {
      entries.delete(path);
    }),
    rmdir: jest.fn(async (path: string, recursive: boolean) => {
      const prefix = `${path}/`;
      if (!recursive && (
        [...entries.keys()].some((entryPath) => entryPath.startsWith(prefix))
        || [...directories].some((directoryPath) => directoryPath.startsWith(prefix))
      )) {
        throw new Error("directory-not-empty");
      }
      directories.delete(path);
    }),
  };
}

describe("DiagnosticsSessionLifecycle", () => {
  const platform = Platform as typeof Platform & {
    isDesktopApp?: boolean;
    isAndroidApp?: boolean;
    isIosApp?: boolean;
    isLinux?: boolean;
    isMacOS?: boolean;
    isMobileApp?: boolean;
    isWin?: boolean;
  };
  const originalPlatform = {
    isDesktopApp: platform.isDesktopApp,
    isAndroidApp: platform.isAndroidApp,
    isIosApp: platform.isIosApp,
    isLinux: platform.isLinux,
    isMacOS: platform.isMacOS,
    isMobileApp: platform.isMobileApp,
    isWin: platform.isWin,
  };

  beforeEach(() => {
    platform.isDesktopApp = true;
    platform.isAndroidApp = false;
    platform.isIosApp = false;
    platform.isLinux = false;
    platform.isMacOS = true;
    platform.isMobileApp = false;
    platform.isWin = false;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    platform.isDesktopApp = originalPlatform.isDesktopApp;
    platform.isAndroidApp = originalPlatform.isAndroidApp;
    platform.isIosApp = originalPlatform.isIosApp;
    platform.isLinux = originalPlatform.isLinux;
    platform.isMacOS = originalPlatform.isMacOS;
    platform.isMobileApp = originalPlatform.isMobileApp;
    platform.isWin = originalPlatform.isWin;
  });

  it.each([
    { name: "Android", isAndroidApp: true, isIosApp: false, operatingSystem: "Android" },
    { name: "iOS", isAndroidApp: false, isIosApp: true, operatingSystem: "iOS" },
  ])("writes exact allowlisted metadata for $name to both session files", async ({ isAndroidApp, isIosApp, operatingSystem }) => {
    platform.isDesktopApp = false;
    platform.isAndroidApp = isAndroidApp;
    platform.isIosApp = isIosApp;
    platform.isMacOS = false;
    platform.isMobileApp = true;
    const app = new App();
    (app.vault as any).getName = () => "PRIVATE_VAULT_CANARY";
    (app.vault as any).configDir = ".private-config-canary";
    (app as any).plugins = { enabledPlugins: new Set(["private-plugin-canary"]) };
    const writeFile = jest.fn(async () => ({ success: true, path: "saved" }));
    const lifecycle = makeLifecycle(app, makeStorage(writeFile), "6.6.0", () => "1.13.2/private-version-canary");
    jest.spyOn(lifecycle, "run").mockResolvedValue(undefined);
    const session = {
      sessionId: "20260813-160000",
      startedAt: "2026-08-13T16:00:00.000Z",
    };
    const expectedMetadata = {
      schemaVersion: 2,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      environment: {
        pluginVersion: "6.6.0",
        obsidianVersion: "unknown",
        hostDevice: "Mobile",
        operatingSystem,
      },
    };

    await lifecycle.schedule(session);

    expect(writeFile.mock.calls).toEqual([
      ["diagnostics", "session-latest.json", expectedMetadata],
      ["diagnostics", `session-${session.sessionId}.json`, expectedMetadata],
    ]);
    const serialized = JSON.stringify(writeFile.mock.calls);
    expect(serialized).not.toMatch(/PRIVATE_VAULT_CANARY|private-config-canary|private-plugin-canary|private-version-canary/u);
    expect(serialized).not.toMatch(/vaultName|obsidianConfigDir|enabledPlugins/u);
  });

  it("finishes session startup without waiting for detached cleanup", async () => {
    const lifecycle = makeLifecycle();
    const cleanup = jest.spyOn(lifecycle, "run").mockReturnValue(new Promise<void>(() => undefined));

    await expect(lifecycle.schedule({
      sessionId: "20260813-160000",
      startedAt: "2026-08-13T16:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("contains a rejected detached cleanup without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const lifecycle = makeLifecycle();
    jest.spyOn(lifecycle, "run").mockRejectedValue(new Error("private-cleanup-failure"));

    try {
      await lifecycle.schedule({
        sessionId: "20260813-160000",
        startedAt: "2026-08-13T16:00:00.000Z",
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("uses a generic warning when session metadata persistence fails", async () => {
    const writeFile = jest.fn(async () => { throw new Error("private-write-failure"); });
    const lifecycle = makeLifecycle(new App(), makeStorage(writeFile));
    jest.spyOn(lifecycle, "run").mockResolvedValue(undefined);
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await lifecycle.schedule({
      sessionId: "20260813-160000",
      startedAt: "2026-08-13T16:00:00.000Z",
    });

    expect(warning.mock.calls).toEqual([["[SystemSculpt][Diagnostics] Failed to write session metadata"]]);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-write-failure");
  });

  it("removes expired and privacy-unsafe automatic files only", async () => {
    const old = NOW - 15 * DAY_MS;
    const recent = NOW - DAY_MS;
    const files: Record<string, TestFile> = {
      [`${DIAGNOSTICS_PATH}/systemsculpt-20260729-160000.log`]: { contents: "old log", mtime: old, size: 7 },
      [`${DIAGNOSTICS_PATH}/resource-metrics-20260729-160000.ndjson`]: { contents: "old metrics", mtime: old, size: 11 },
      [`${DIAGNOSTICS_PATH}/session-20260729-155959.json`]: {
        contents: JSON.stringify({ schemaVersion: 2, environment: { hostDevice: "Desktop" } }),
        mtime: old,
        size: 80,
      },
      [`${DIAGNOSTICS_PATH}/session-20260812-160000.json`]: {
        contents: JSON.stringify({ vaultName: "PRIVATE_VAULT_CANARY", enabledPlugins: ["private-plugin-canary"] }),
        mtime: recent,
        size: 96,
      },
      [`${DIAGNOSTICS_PATH}/session-latest.json`]: {
        contents: JSON.stringify({ obsidianConfigDir: ".private-config-canary" }),
        mtime: recent,
        size: 64,
      },
      [`${DIAGNOSTICS_PATH}/systemsculpt-20260812-160000.log`]: { contents: "recent log", mtime: recent, size: 10 },
      [`${DIAGNOSTICS_PATH}/resource-metrics-20260812-160000.ndjson`]: { contents: "recent metrics", mtime: recent, size: 14 },
      [`${DIAGNOSTICS_PATH}/session-20260812-150000.json`]: {
        contents: JSON.stringify({ schemaVersion: 2, environment: { hostDevice: "Desktop" } }),
        mtime: recent,
        size: 80,
      },
      [`${DIAGNOSTICS_PATH}/diagnostics-20260701-120000-${"a".repeat(32)}.txt`]: { contents: "user export", mtime: old, size: 1 },
      [`${DIAGNOSTICS_PATH}/resource-report-20260701-120000.txt`]: { contents: "user report", mtime: old, size: 1 },
      [`${DIAGNOSTICS_PATH}/incident-report_123.json`]: { contents: "incident", mtime: old, size: 1 },
      [`${DIAGNOSTICS_PATH}/systemsculpt-latest.log`]: { contents: "active", mtime: old, size: 1 },
      [`${DIAGNOSTICS_PATH}/resource-metrics-latest.ndjson`]: { contents: "active", mtime: old, size: 1 },
    };
    const adapter = makeDiagnosticsAdapter(files);
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    await lifecycle.run(NOW);

    expect(adapter.remove.mock.calls.map(([path]) => path).sort()).toEqual([
      `${DIAGNOSTICS_PATH}/resource-metrics-20260729-160000.ndjson`,
      `${DIAGNOSTICS_PATH}/session-20260729-155959.json`,
      `${DIAGNOSTICS_PATH}/session-20260812-160000.json`,
      `${DIAGNOSTICS_PATH}/session-latest.json`,
      `${DIAGNOSTICS_PATH}/systemsculpt-20260729-160000.log`,
    ]);
    for (const preservedPath of [
      `${DIAGNOSTICS_PATH}/diagnostics-20260701-120000-${"a".repeat(32)}.txt`,
      `${DIAGNOSTICS_PATH}/resource-report-20260701-120000.txt`,
      `${DIAGNOSTICS_PATH}/incident-report_123.json`,
      `${DIAGNOSTICS_PATH}/systemsculpt-latest.log`,
      `${DIAGNOSTICS_PATH}/resource-metrics-latest.ndjson`,
    ]) {
      expect(adapter.stat).not.toHaveBeenCalledWith(preservedPath);
      expect(adapter.read).not.toHaveBeenCalledWith(preservedPath);
      expect(adapter.remove).not.toHaveBeenCalledWith(preservedPath);
    }
  });

  it.each([
    "vaultName",
    "vault_name",
    "obsidianConfigDir",
    "obsidian_config_dir",
    "enabledPlugins",
    "enabled_plugins",
  ])("removes session metadata with the legacy private key %s", async (privateKey) => {
    const path = `${DIAGNOSTICS_PATH}/session-20260812-160000.json`;
    const contents = JSON.stringify({ [privateKey]: "PRIVATE_SESSION_VALUE" });
    const adapter = makeDiagnosticsAdapter({
      [path]: { contents, mtime: NOW - DAY_MS, size: contents.length },
    });
    const app = new App();
    (app.vault as any).adapter = adapter;

    await makeLifecycle(app).run(NOW);

    expect(adapter.remove.mock.calls).toEqual([[path]]);
  });

  it("removes only exact plugin-owned legacy operations and ChatView UI logs", async () => {
    const exactChatIdentifier = "a".repeat(120);
    const files: Record<string, TestFile> = {
      [`${DIAGNOSTICS_PATH}/operations-latest.ndjson`]: { contents: "private operations", mtime: NOW, size: 18 },
      [`${DIAGNOSTICS_PATH}/operations-20260812-160000.ndjson`]: { contents: "private operations", mtime: NOW, size: 18 },
      [`${DIAGNOSTICS_PATH}/operations-manual-export.ndjson`]: { contents: "user export", mtime: NOW, size: 11 },
      [`${DIAGNOSTICS_PATH}/operations-20260812-160000.ndjson.backup`]: { contents: "user backup", mtime: NOW, size: 11 },
      [`${DIAGNOSTICS_PATH}/operations-20260812-160000.json`]: { contents: "user export", mtime: NOW, size: 11 },
      [`${DIAGNOSTICS_PATH}/diagnostics-20260812-160000-${"b".repeat(32)}.txt`]: { contents: "user export", mtime: NOW, size: 11 },
      [`${DIAGNOSTICS_PATH}/chat-debug/chat-unsaved-chat-ui.json`]: { contents: "private chat", mtime: NOW, size: 12 },
      [`${DIAGNOSTICS_PATH}/chat-debug/chat-${exactChatIdentifier}-ui.json`]: { contents: "private chat", mtime: NOW, size: 12 },
      [`${DIAGNOSTICS_PATH}/chat-debug/chat---ui.json`]: { contents: "private chat", mtime: NOW, size: 12 },
      [`${DIAGNOSTICS_PATH}/chat-debug/chat-unsaved-chat-stream.ndjson`]: { contents: "legacy stream", mtime: NOW, size: 13 },
      [`${DIAGNOSTICS_PATH}/chat-debug/chat-unsaved-chat-ui-copy.json`]: { contents: "user export", mtime: NOW, size: 11 },
      [`${DIAGNOSTICS_PATH}/chat-debug/export-chat-unsaved-chat-ui.json`]: { contents: "user export", mtime: NOW, size: 11 },
      [`${DIAGNOSTICS_PATH}/chat-debug/chat-${"c".repeat(121)}-ui.json`]: { contents: "user export", mtime: NOW, size: 11 },
      [`${DIAGNOSTICS_PATH}/chat-debug/nested/chat-private-ui.json`]: { contents: "nested user file", mtime: NOW, size: 16 },
    };
    const adapter = makeDiagnosticsAdapter(files);
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    await lifecycle.run(NOW);

    expect(adapter.remove.mock.calls.map(([path]) => path).sort()).toEqual([
      `${DIAGNOSTICS_PATH}/chat-debug/chat---ui.json`,
      `${DIAGNOSTICS_PATH}/chat-debug/chat-${exactChatIdentifier}-ui.json`,
      `${DIAGNOSTICS_PATH}/chat-debug/chat-unsaved-chat-ui.json`,
      `${DIAGNOSTICS_PATH}/operations-20260812-160000.ndjson`,
      `${DIAGNOSTICS_PATH}/operations-latest.ndjson`,
    ]);
    for (const preservedPath of [
      `${DIAGNOSTICS_PATH}/operations-manual-export.ndjson`,
      `${DIAGNOSTICS_PATH}/operations-20260812-160000.ndjson.backup`,
      `${DIAGNOSTICS_PATH}/operations-20260812-160000.json`,
      `${DIAGNOSTICS_PATH}/diagnostics-20260812-160000-${"b".repeat(32)}.txt`,
      `${DIAGNOSTICS_PATH}/chat-debug/chat-unsaved-chat-stream.ndjson`,
      `${DIAGNOSTICS_PATH}/chat-debug/chat-unsaved-chat-ui-copy.json`,
      `${DIAGNOSTICS_PATH}/chat-debug/export-chat-unsaved-chat-ui.json`,
      `${DIAGNOSTICS_PATH}/chat-debug/chat-${"c".repeat(121)}-ui.json`,
      `${DIAGNOSTICS_PATH}/chat-debug/nested/chat-private-ui.json`,
    ]) {
      expect(adapter.stat).not.toHaveBeenCalledWith(preservedPath);
      expect(adapter.read).not.toHaveBeenCalledWith(preservedPath);
      expect(adapter.remove).not.toHaveBeenCalledWith(preservedPath);
    }
    expect(adapter.rmdir).not.toHaveBeenCalled();
  });

  it("removes an owned ChatView debug directory only after a confirmed empty relist", async () => {
    const chatLogPath = `${DIAGNOSTICS_PATH}/chat-debug/chat-chat-1-ui.json`;
    const adapter = makeDiagnosticsAdapter({
      [chatLogPath]: { contents: "private chat", mtime: NOW, size: 12 },
    });
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    await lifecycle.run(NOW);

    expect(adapter.remove).toHaveBeenCalledWith(chatLogPath);
    expect(adapter.list.mock.calls.map(([path]) => path)).toEqual([
      DIAGNOSTICS_PATH,
      `${DIAGNOSTICS_PATH}/chat-debug`,
      `${DIAGNOSTICS_PATH}/chat-debug`,
    ]);
    expect(adapter.rmdir).toHaveBeenCalledWith(`${DIAGNOSTICS_PATH}/chat-debug`, false);
  });

  it("leaves an empty owned ChatView debug directory when safe nonrecursive removal is unavailable", async () => {
    const chatLogPath = `${DIAGNOSTICS_PATH}/chat-debug/chat-chat-1-ui.json`;
    const adapter = makeDiagnosticsAdapter({
      [chatLogPath]: { contents: "private chat", mtime: NOW, size: 12 },
    });
    (adapter as any).rmdir = undefined;
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    await expect(lifecycle.run(NOW)).resolves.toBeUndefined();

    expect(adapter.remove).toHaveBeenCalledWith(chatLogPath);
  });

  it("shares deterministic entry and candidate limits across huge root and ChatView directories", async () => {
    const files: Record<string, TestFile> = {};
    for (let index = 0; index < 900; index += 1) {
      files[`${DIAGNOSTICS_PATH}/systemsculpt-20260813-${index.toString().padStart(6, "0")}.log`] = {
        contents: "x",
        mtime: NOW - index,
        size: 1,
      };
      files[`${DIAGNOSTICS_PATH}/chat-debug/chat-${index.toString().padStart(6, "0")}-ui.json`] = {
        contents: "private chat",
        mtime: NOW - index,
        size: 12,
      };
    }
    const adapter = makeDiagnosticsAdapter(files);
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await lifecycle.run(NOW);

    expect(adapter.remove).toHaveBeenCalledTimes(128);
    expect(adapter.remove.mock.calls.map(([path]) => path)).toEqual(
      Array.from({ length: 128 }, (_, index) =>
        `${DIAGNOSTICS_PATH}/chat-debug/chat-${index.toString().padStart(6, "0")}-ui.json`),
    );
    expect(adapter.stat).not.toHaveBeenCalled();
    expect(adapter.rmdir).not.toHaveBeenCalled();
  });

  it("stops before deletion when the nested ChatView listing hangs", async () => {
    jest.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let rejectNestedListing: ((reason?: unknown) => void) | undefined;
    const nestedListing = new Promise<never>((_resolve, reject) => {
      rejectNestedListing = reject;
    });
    const operationsPath = `${DIAGNOSTICS_PATH}/operations-latest.ndjson`;
    const chatLogPath = `${DIAGNOSTICS_PATH}/chat-debug/chat-chat-1-ui.json`;
    const adapter = makeDiagnosticsAdapter({
      [operationsPath]: { contents: "private operations", mtime: NOW, size: 18 },
      [chatLogPath]: { contents: "private chat", mtime: NOW, size: 12 },
    });
    const normalList = adapter.list.getMockImplementation()!;
    adapter.list.mockImplementation((path: string) => {
      if (path === `${DIAGNOSTICS_PATH}/chat-debug`) return nestedListing;
      return normalList(path);
    });
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    try {
      const cleanup = lifecycle.run(NOW);
      await jest.advanceTimersByTimeAsync(CLEANUP_OPERATION_TIMEOUT_MS + 1);
      await expect(cleanup).resolves.toBeUndefined();

      expect(adapter.remove).not.toHaveBeenCalled();
      expect(adapter.rmdir).not.toHaveBeenCalled();
      rejectNestedListing?.(new Error("private-late-nested-list-failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("retries a timed-out nested deletion on a later startup and consumes a late rejection", async () => {
    jest.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let rejectFirstRemoval: ((reason?: unknown) => void) | undefined;
    const firstRemoval = new Promise<void>((_resolve, reject) => {
      rejectFirstRemoval = reject;
    });
    const chatLogPath = `${DIAGNOSTICS_PATH}/chat-debug/chat-chat-1-ui.json`;
    const adapter = makeDiagnosticsAdapter({
      [chatLogPath]: { contents: "private chat", mtime: NOW, size: 12 },
    });
    const normalRemove = adapter.remove.getMockImplementation()!;
    adapter.remove.mockImplementationOnce(() => firstRemoval);
    const app = new App();
    (app.vault as any).adapter = adapter;
    const firstLifecycle = makeLifecycle(app);

    try {
      const firstCleanup = firstLifecycle.run(NOW);
      await jest.advanceTimersByTimeAsync(CLEANUP_OPERATION_TIMEOUT_MS + 1);
      await expect(firstCleanup).resolves.toBeUndefined();
      expect(adapter.rmdir).not.toHaveBeenCalled();

      adapter.remove.mockImplementation(normalRemove);
      const nextStartupLifecycle = makeLifecycle(app);
      await expect(nextStartupLifecycle.run(NOW)).resolves.toBeUndefined();

      expect(adapter.remove).toHaveBeenCalledTimes(2);
      expect(adapter.rmdir).toHaveBeenCalledWith(`${DIAGNOSTICS_PATH}/chat-debug`, false);
      rejectFirstRemoval?.(new Error("private-late-nested-remove-failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("counts log, metrics, and session archives together under the 60-file limit", async () => {
    const files: Record<string, TestFile> = {};
    const archiveName = (index: number): string => {
      const timestamp = `20260813-${index.toString().padStart(6, "0")}`;
      if (index % 3 === 0) return `systemsculpt-${timestamp}.log`;
      if (index % 3 === 1) return `resource-metrics-${timestamp}.ndjson`;
      return `session-${timestamp}.json`;
    };
    for (let index = 0; index < 65; index += 1) {
      const name = archiveName(index);
      files[`${DIAGNOSTICS_PATH}/${name}`] = { contents: name.startsWith("session-") ? "{}" : "x", mtime: NOW - index, size: 1 };
    }
    const adapter = makeDiagnosticsAdapter(files);
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    await lifecycle.run(NOW);

    expect(adapter.remove).toHaveBeenCalledTimes(5);
    expect(adapter.remove.mock.calls.map(([path]) => path).sort()).toEqual(
      [60, 61, 62, 63, 64].map((index) => `${DIAGNOSTICS_PATH}/${archiveName(index)}`).sort(),
    );
  });

  it("counts log, metrics, and session archives together under the 10 MiB limit", async () => {
    const mebibyte = 1024 * 1024;
    const files: Record<string, TestFile> = {
      [`${DIAGNOSTICS_PATH}/systemsculpt-20260813-155959.log`]: { contents: "", mtime: NOW - 1, size: 6 * mebibyte },
      [`${DIAGNOSTICS_PATH}/resource-metrics-20260813-155958.ndjson`]: { contents: "", mtime: NOW - 2, size: 4 * mebibyte },
      [`${DIAGNOSTICS_PATH}/session-20260813-155957.json`]: { contents: "{}", mtime: NOW - 3, size: 1 },
    };
    const adapter = makeDiagnosticsAdapter(files);
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    await lifecycle.run(NOW);

    expect(adapter.remove).toHaveBeenCalledTimes(1);
    expect(adapter.remove).toHaveBeenCalledWith(`${DIAGNOSTICS_PATH}/session-20260813-155957.json`);
  });

  it("settles after a hung directory listing", async () => {
    jest.useFakeTimers();
    const adapter = makeDiagnosticsAdapter({});
    adapter.list.mockReturnValue(new Promise(() => undefined));
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    const cleanup = lifecycle.run(NOW);
    await jest.advanceTimersByTimeAsync(CLEANUP_OPERATION_TIMEOUT_MS + 1);
    await expect(cleanup).resolves.toBeUndefined();

    expect(adapter.stat).not.toHaveBeenCalled();
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("uses a generic warning when cleanup collection fails", async () => {
    const adapter = makeDiagnosticsAdapter({});
    adapter.list.mockRejectedValue(new Error("private-list-failure"));
    const app = new App();
    (app.vault as any).adapter = adapter;
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await makeLifecycle(app).run(NOW);

    expect(warning.mock.calls).toEqual([[
      "[SystemSculpt][Diagnostics] Archive cleanup skipped 1 file checks and 0 removals",
    ]]);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-list-failure");
  });

  it("settles after a hung stat without scheduling a removal", async () => {
    jest.useFakeTimers();
    const path = `${DIAGNOSTICS_PATH}/systemsculpt-20260729-160000.log`;
    const adapter = makeDiagnosticsAdapter({
      [path]: { contents: "old", mtime: NOW - 15 * DAY_MS, size: 3 },
    });
    adapter.stat.mockReturnValue(new Promise(() => undefined));
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    const cleanup = lifecycle.run(NOW);
    await jest.advanceTimersByTimeAsync(CLEANUP_OPERATION_TIMEOUT_MS + 1);
    await expect(cleanup).resolves.toBeUndefined();

    expect(adapter.stat).toHaveBeenCalledTimes(1);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("settles after a hung session read without scheduling a removal", async () => {
    jest.useFakeTimers();
    const path = `${DIAGNOSTICS_PATH}/session-20260812-160000.json`;
    const adapter = makeDiagnosticsAdapter({
      [path]: { contents: "", mtime: NOW - DAY_MS, size: 64 },
    });
    adapter.read.mockReturnValue(new Promise(() => undefined));
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    const cleanup = lifecycle.run(NOW);
    await jest.advanceTimersByTimeAsync(CLEANUP_OPERATION_TIMEOUT_MS + 1);
    await expect(cleanup).resolves.toBeUndefined();

    expect(adapter.read).toHaveBeenCalledTimes(1);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("settles after a hung removal and consumes its later rejection", async () => {
    jest.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let rejectRemoval: ((reason?: unknown) => void) | undefined;
    const pendingRemoval = new Promise<void>((_resolve, reject) => {
      rejectRemoval = reject;
    });
    const path = `${DIAGNOSTICS_PATH}/systemsculpt-20260729-160000.log`;
    const adapter = makeDiagnosticsAdapter({
      [path]: { contents: "old", mtime: NOW - 15 * DAY_MS, size: 3 },
    });
    adapter.remove.mockReturnValue(pendingRemoval);
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    try {
      const cleanup = lifecycle.run(NOW);
      await jest.advanceTimersByTimeAsync(CLEANUP_OPERATION_TIMEOUT_MS + 1);
      await expect(cleanup).resolves.toBeUndefined();
      rejectRemoval?.(new Error("private-late-remove-failure"));
      await Promise.resolve();
      await Promise.resolve();

      expect(adapter.remove).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("selects at most 128 deterministic direct automatic children from a hostile listing", async () => {
    const files: Record<string, TestFile> = {};
    const automaticPaths = Array.from({ length: 200 }, (_, index) => {
      const path = `${DIAGNOSTICS_PATH}/systemsculpt-20260813-${index.toString().padStart(6, "0")}.log`;
      files[path] = { contents: "x", mtime: NOW - index, size: 1 };
      return path;
    });
    const listedFiles = [
      ...automaticPaths.slice().reverse(),
      `${DIAGNOSTICS_PATH}/nested/systemsculpt-20260813-999999.log`,
      `${DIAGNOSTICS_PATH}/../systemsculpt-20260813-999998.log`,
      "unrelated.txt",
    ];
    listedFiles.length = 5_000;
    Object.defineProperty(listedFiles, 1_024, {
      get: () => {
        throw new Error("out-of-budget-entry-read");
      },
    });
    const adapter = makeDiagnosticsAdapter(files);
    adapter.list.mockResolvedValue({ files: listedFiles, folders: [] });
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await lifecycle.run(NOW);

    expect(adapter.stat.mock.calls.map(([path]) => path)).toEqual(automaticPaths.slice(0, 128));
    expect(adapter.stat).not.toHaveBeenCalledWith(`${DIAGNOSTICS_PATH}/nested/systemsculpt-20260813-999999.log`);
    expect(adapter.stat).not.toHaveBeenCalledWith(`${DIAGNOSTICS_PATH}/../systemsculpt-20260813-999998.log`);
  });

  it("reads at most 512 KiB of session metadata", async () => {
    const files: Record<string, TestFile> = {};
    for (let index = 0; index < 10; index += 1) {
      const path = `${DIAGNOSTICS_PATH}/session-20260813-${index.toString().padStart(6, "0")}.json`;
      files[path] = { contents: "{}", mtime: NOW - index, size: 64 * 1024 };
    }
    const adapter = makeDiagnosticsAdapter(files);
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await lifecycle.run(NOW);

    expect(adapter.stat).toHaveBeenCalledTimes(10);
    expect(adapter.read).toHaveBeenCalledTimes(8);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("stops before mutation when the total cleanup deadline expires", async () => {
    jest.useFakeTimers();
    const files: Record<string, TestFile> = {};
    for (let index = 0; index < 20; index += 1) {
      const path = `${DIAGNOSTICS_PATH}/systemsculpt-20260729-${index.toString().padStart(6, "0")}.log`;
      files[path] = { contents: "old", mtime: NOW - 15 * DAY_MS, size: 3 };
    }
    const adapter = makeDiagnosticsAdapter(files);
    adapter.stat.mockImplementation(async (path: string) => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
      const file = files[path];
      return file ? { type: "file", ctime: file.mtime, mtime: file.mtime, size: file.size } : null;
    });
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);

    const cleanup = lifecycle.run(NOW);
    await jest.advanceTimersByTimeAsync(CLEANUP_TOTAL_TIMEOUT_MS + 1);
    await expect(cleanup).resolves.toBeUndefined();

    expect(adapter.stat.mock.calls.length).toBeLessThan(20);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("does not schedule mutations after cleanup admission closes", async () => {
    const path = `${DIAGNOSTICS_PATH}/systemsculpt-20260729-160000.log`;
    const adapter = makeDiagnosticsAdapter({
      [path]: { contents: "old", mtime: NOW - 15 * DAY_MS, size: 3 },
    });
    const app = new App();
    (app.vault as any).adapter = adapter;
    const lifecycle = makeLifecycle(app);
    adapter.stat.mockImplementation(async () => {
      lifecycle.close();
      return { type: "file", ctime: NOW, mtime: NOW - 15 * DAY_MS, size: 3 };
    });

    await lifecycle.run(NOW);

    expect(adapter.remove).not.toHaveBeenCalled();
  });
});
