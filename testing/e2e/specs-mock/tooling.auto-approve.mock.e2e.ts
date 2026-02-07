import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  openFreshChatView,
  PLUGIN_ID,
  requireEnv,
  upsertVaultFile,
} from "../utils/systemsculptChat";

describe("Tooling (mock) auto-approve read-only", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  let vaultPath: string;

  const nonce = crypto.randomUUID().slice(0, 8);
  const token = `AUTO_${nonce}`;
  const readPath = "E2E/auto-approve.md";

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        mcpEnabled: true,
        mcpAutoAccept: false,
        toolingAutoApproveReadOnly: true,
      },
    });

    await upsertVaultFile(readPath, `AUTO_TOKEN: ${token}\n`);
  });

  it("auto-approves mcp-filesystem_read without manual approval", async function () {
    this.timeout(120000);

    await openFreshChatView();

    const toolCallId = await browser.executeObsidian(({ app }, { readPath }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view = (leaf as any)?.view;
      const manager = view?.toolCallManager as any;
      if (!manager) throw new Error("ToolCallManager missing");

      const request = {
        id: `e2e-read-${Date.now()}`,
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          arguments: JSON.stringify({ paths: [readPath] }),
        },
      };

      const tc = manager.createToolCall(request, `e2e-message-${Date.now()}`, false);
      return tc.id;
    }, { readPath });

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }, { toolCallId }) => {
          const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
          const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
          const activeLeaf: any = app.workspace.activeLeaf as any;
          const leaf =
            markedLeaf ||
            (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
          const view = (leaf as any)?.view;
          const manager = view?.toolCallManager as any;
          const call = manager?.getToolCall?.(toolCallId);
          return call?.state === "completed";
        }, { toolCallId }),
      { timeout: 60000, timeoutMsg: "Read tool call did not complete." }
    );

    const snapshot = await browser.executeObsidian(({ app }, { toolCallId }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view = (leaf as any)?.view;
      const manager = view?.toolCallManager as any;
      const call = manager?.getToolCall?.(toolCallId);
      return {
        autoApproved: call?.autoApproved,
        result: call?.result,
      };
    }, { toolCallId });

    expect(snapshot.autoApproved).toBe(true);
    expect(snapshot.result?.success).toBe(true);
    expect(snapshot.result?.data?.files?.[0]?.content ?? "").toContain(token);
  });
});
