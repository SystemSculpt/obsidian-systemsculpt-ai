/** @jest-environment jsdom */

import { createHash, webcrypto } from "node:crypto";
import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { AgentChatView } from "../views/chatview/AgentChatView";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function bytes(value: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(value)).buffer;
}

function buildId(value: ArrayBuffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(new Uint8Array(value)).digest("hex")}`;
}

function makePlugin(readBinary: jest.Mock): SystemSculptPlugin {
  const app = new App();
  (app.vault as any).configDir = ".obsidian";
  (app.vault.adapter as any).readBinary = readBinary;
  const plugin = new SystemSculptPlugin(app, {
    id: "systemsculpt-ai",
    version: "6.6.0",
  } as any);
  (plugin as any)._internal_settings_systemsculpt_plugin = {
    licenseKey: "test-license",
  };
  return plugin;
}

function makeView(
  plugin: SystemSculptPlugin,
  conversationId: string,
): AgentChatView & Record<string, any> {
  const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
  Object.assign(view, {
    plugin,
    pendingThinConversationId: conversationId,
    thinBootstrapRequest: null,
    thinClientId: `client_${"c".repeat(32)}`,
  });
  return view;
}

describe("SystemSculptPlugin loaded plugin build identity", () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

  beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: webcrypto,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalCrypto) {
      Object.defineProperty(globalThis, "crypto", originalCrypto);
    } else {
      delete (globalThis as { crypto?: Crypto }).crypto;
    }
  });

  it("shares one concurrent read and hash across incident startup and multiple ChatViews", async () => {
    const installedBytes = bytes("one loaded plugin session\n");
    const read = deferred<ArrayBuffer>();
    const readBinary = jest.fn(() => read.promise);
    const digest = jest.spyOn(globalThis.crypto.subtle, "digest");
    const plugin = makePlugin(readBinary);
    const firstView = makeView(plugin, `conversation_${"a".repeat(32)}`);
    const secondView = makeView(plugin, `conversation_${"b".repeat(32)}`);

    (plugin as any).initializeAgentIncidentCoordinator();
    const cachedPromise = plugin.getLoadedPluginBuildId();
    expect(plugin.getLoadedPluginBuildId()).toBe(cachedPromise);
    const firstPreparation = (firstView as any).prepareThinConversation(
      (firstView as any).pendingThinConversationId,
    );
    const secondPreparation = (secondView as any).prepareThinConversation(
      (secondView as any).pendingThinConversationId,
    );

    expect(readBinary).toHaveBeenCalledTimes(1);
    expect(digest).not.toHaveBeenCalled();

    read.resolve(installedBytes);
    await Promise.all([cachedPromise, firstPreparation, secondPreparation]);
    await Promise.resolve();

    const expectedBuildId = buildId(installedBytes);
    expect(digest).toHaveBeenCalledTimes(1);
    expect((firstView as any).thinBootstrapRequest.plugin_build_id).toBe(expectedBuildId);
    expect((secondView as any).thinBootstrapRequest.plugin_build_id).toBe(expectedBuildId);
    expect((plugin as any).agentIncidentLoadedBundleId).toBe(expectedBuildId);
  });

  it("keeps one rejected promise while incident reporting falls back to no build ID", async () => {
    const cause = new Error("installed bundle unavailable");
    const readBinary = jest.fn(async () => {
      throw cause;
    });
    const plugin = makePlugin(readBinary);

    (plugin as any).initializeAgentIncidentCoordinator();
    const first = plugin.getLoadedPluginBuildId();
    const second = plugin.getLoadedPluginBuildId();
    expect(second).toBe(first);

    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toMatchObject({ status: "rejected" });
    if (results[0].status !== "rejected" || results[1].status !== "rejected") {
      throw new Error("Expected the build identity promise to reject.");
    }
    expect(results[1].reason).toBe(results[0].reason);
    expect(results[0].reason).toMatchObject({
      message: "SystemSculpt could not verify this plugin update. Reload Obsidian and try again.",
      cause,
    });
    expect(plugin.getLoadedPluginBuildId()).toBe(first);
    expect(readBinary).toHaveBeenCalledTimes(1);
    expect((plugin as any).agentIncidentLoadedBundleId).toBeNull();
  });

  it("keeps unloaded and reloaded plugin instances isolated", async () => {
    const firstBytes = bytes("first plugin session\n");
    const secondBytes = bytes("reloaded plugin session\n");
    const firstRead = jest.fn(async () => firstBytes);
    const secondRead = jest.fn(async () => secondBytes);
    const unloadedPlugin = makePlugin(firstRead);

    const firstPromise = unloadedPlugin.getLoadedPluginBuildId();
    await expect(firstPromise).resolves.toBe(buildId(firstBytes));

    const reloadedPlugin = makePlugin(secondRead);
    const secondPromise = reloadedPlugin.getLoadedPluginBuildId();
    expect(secondPromise).not.toBe(firstPromise);
    await expect(secondPromise).resolves.toBe(buildId(secondBytes));

    expect(unloadedPlugin.getLoadedPluginBuildId()).toBe(firstPromise);
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect(secondRead).toHaveBeenCalledTimes(1);
  });
});
