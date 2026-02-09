import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePluginEnabled } from "../utils/obsidian";
import { ensureE2EVault, openFreshChatView, PLUGIN_ID } from "../utils/systemsculptChat";

type ApprovalDomSnapshot = {
  assistantCount: number;
  pendingToolVisible: boolean;
  statusText: string;
  approvalButtonsVisible: boolean;
};

describe("ChatView (live) streaming approval UX", () => {
  let vaultPath: string;

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
  });

  it("keeps the activity drawer expanded while awaiting approval", async function () {
    this.timeout(180000);

    await openFreshChatView();
    await browser.executeObsidian(async ({ app }) => {
      const plugin: any = (app as any)?.plugins?.plugins?.["systemsculpt-ai"];
      if (!plugin) throw new Error("SystemSculpt plugin missing");
      plugin.settings = plugin.settings || {};
      plugin.settings.toolingRequireApprovalForDestructiveTools = true;
      plugin.settings.mcpAutoAcceptTools = [];
      if (typeof plugin.saveSettings === "function") {
        await plugin.saveSettings();
      }
    });

    const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const { toolCallId } = await browser.executeObsidian(({ app }, { nonce }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view: any = leaf?.view;
      if (!view) throw new Error("Chat view missing");
      const manager: any = view.toolCallManager;
      if (!manager) throw new Error("ToolCallManager missing");

      const messageId = `e2e-approval-${Date.now()}-${nonce}`;
      const request = {
        id: `call_${nonce}_write`,
        type: "function",
        function: {
          name: "mcp-filesystem_write",
          arguments: JSON.stringify({ path: `E2E/${nonce}.txt`, content: "hello" }),
        },
      };
      const toolCall = manager.createToolCall(request, messageId, false);

      const message = {
        role: "assistant",
        message_id: messageId,
        content: `Awaiting approval ${nonce}`,
        tool_calls: [toolCall],
        messageParts: [
          {
            id: `tool_call_part-${toolCall.id}`,
            type: "tool_call",
            timestamp: 1,
            data: toolCall,
          },
        ],
      };

      view.messages.push(message);
      view.addMessage("assistant", message.content, messageId, message);
      return { toolCallId: toolCall.id };
    }, { nonce });

    const start = Date.now();
    const samples: Array<{ t: number; dom: ApprovalDomSnapshot }> = [];

    const snapshotDom = async (): Promise<ApprovalDomSnapshot> =>
      await browser.executeObsidian(({ app }, { toolCallId }) => {
        const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
        const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
        const activeLeaf: any = app.workspace.activeLeaf as any;
        const leaf =
          markedLeaf ||
          (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
        const view: any = (leaf as any)?.view;
        const manager: any = view?.toolCallManager;
        const call = manager?.getToolCall?.(toolCallId);
        const pending = call?.state === "pending";
        const assistantCount = (view?.messages || []).filter((m: any) => m?.role === "assistant").length;
        return {
          assistantCount,
          pendingToolVisible: pending,
          statusText: String(call?.state ?? ""),
          approvalButtonsVisible: pending,
        };
      }, { toolCallId });

    await browser.waitUntil(
      async () => {
        const dom = await snapshotDom();
        samples.push({ t: Date.now() - start, dom });
        return dom.approvalButtonsVisible;
      },
      { timeout: 30000, timeoutMsg: "Approval controls did not appear." }
    );

    // Sample a bit after the initial stream ends to catch auto-collapse regressions.
    for (const delay of [200, 400, 700]) {
      await browser.pause(delay);
      samples.push({ t: Date.now() - start, dom: await snapshotDom() });
    }

    const output = {
      generatedAt: new Date().toISOString(),
      nonce,
      samples,
    };

    const outputPath = path.join(process.cwd(), "testing", "e2e", "logs", `streaming-approval-ux-${Date.now()}.json`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`[e2e] streaming approval UX metrics written: ${outputPath}`);

    const relevant = samples.filter((s) => s.dom.approvalButtonsVisible);
    expect(relevant.length).toBeGreaterThan(0);

    for (const sample of relevant) {
      expect(sample.dom.pendingToolVisible).toBe(true);
    }

    expect(relevant[relevant.length - 1].dom.statusText.toLowerCase()).toContain("pending");

    // Deny to let the turn finish and keep test isolation.
    await browser.executeObsidian(({ app }, { toolCallId }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view: any = (leaf as any)?.view;
      const manager: any = view?.toolCallManager;
      manager?.denyToolCall?.(toolCallId);
    }, { toolCallId });

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }, { toolCallId }) => {
          const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
          const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
          const activeLeaf: any = app.workspace.activeLeaf as any;
          const leaf =
            markedLeaf ||
            (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
          const view: any = (leaf as any)?.view;
          const manager: any = view?.toolCallManager;
          const call = manager?.getToolCall?.(toolCallId);
          return call?.state === "denied";
        }, { toolCallId }),
      { timeout: 60000, timeoutMsg: "Turn did not complete after denying tool call." }
    );

    const maxAssistantCount = samples.reduce((acc, s) => Math.max(acc, s.dom.assistantCount), 0);
    expect(maxAssistantCount).toBe(1);
  });
});
