/**
 * @jest-environment node
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

jest.mock("obsidian", () => ({
  TFile: class {},
  normalizePath: (value: string) => String(value || "").replace(/\\/g, "/"),
}));

jest.mock("../../../core/plugin/viewTypes", () => ({
  CHAT_VIEW_TYPE: "systemsculpt-chat-view",
}));

jest.mock("../../../utils/titleUtils", () => ({
  generateDefaultChatTitle: jest.fn(() => "New Chat"),
}));

jest.mock("../../../views/chatview/modelSelection", () => ({
  loadChatModelPickerOptions: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../../utils/vaultPathUtils", () => ({
  resolveAbsoluteVaultPath: jest.fn(() => "/Users/systemsculpt/gits/private-vault/.obsidian"),
}));

import { DesktopAutomationBridge } from "../DesktopAutomationBridge";

describe("DesktopAutomationBridge discovery cleanup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-automation-bridge-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function createPluginStub() {
    return {
      settings: {
        desktopAutomationBridgeEnabled: true,
        vaultInstanceId: "vault-instance",
      },
      manifest: {
        id: "systemsculpt-ai",
        version: "5.2.0",
      },
      app: {
        vault: {
          getName: () => "private-vault",
          configDir: ".obsidian",
          adapter: {
            getBasePath: () => "/Users/systemsculpt/gits/private-vault",
          },
        },
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([]),
          getLeaf: jest.fn(),
        },
      },
      getLogger: () => ({
        info: jest.fn(),
        error: jest.fn(),
      }),
    } as any;
  }

  async function fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  it("removes the discovery file owned by the stopping bridge instance", async () => {
    const discoveryFilePath = path.join(tempDir, "vault-instance.json");
    const record = {
      token: "token-current",
      port: 60401,
      startedAt: "2026-03-27T14:39:37.000Z",
    };
    await fs.writeFile(
      discoveryFilePath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );

    const bridge = new DesktopAutomationBridge(createPluginStub());
    Object.assign(bridge as any, {
      server: {
        close: (callback: () => void) => callback(),
      },
      discoveryFilePath,
      token: record.token,
      port: record.port,
      startedAt: record.startedAt,
    });

    await bridge.stop();

    expect(await fileExists(discoveryFilePath)).toBe(false);
  });

  it("preserves a discovery file that has already been replaced by a newer bridge instance", async () => {
    const discoveryFilePath = path.join(tempDir, "vault-instance.json");
    const currentRecord = {
      token: "token-old",
      port: 60401,
      startedAt: "2026-03-27T14:39:37.000Z",
    };
    const newerRecord = {
      token: "token-new",
      port: 60455,
      startedAt: "2026-03-27T14:40:12.000Z",
    };
    await fs.writeFile(
      discoveryFilePath,
      `${JSON.stringify(newerRecord, null, 2)}\n`,
      "utf8"
    );

    const bridge = new DesktopAutomationBridge(createPluginStub());
    Object.assign(bridge as any, {
      server: {
        close: (callback: () => void) => callback(),
      },
      discoveryFilePath,
      token: currentRecord.token,
      port: currentRecord.port,
      startedAt: currentRecord.startedAt,
    });

    await bridge.stop();

    expect(await fileExists(discoveryFilePath)).toBe(true);
    expect(JSON.parse(await fs.readFile(discoveryFilePath, "utf8"))).toMatchObject(newerRecord);
  });
});
