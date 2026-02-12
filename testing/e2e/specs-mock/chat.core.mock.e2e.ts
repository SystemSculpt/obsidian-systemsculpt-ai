import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  approveAllToolCallsDirect,
  coerceMessageContentToText,
  configurePluginForLiveChat,
  ensureE2EVault,
  getActiveChatViewState,
  getEnv,
  openFreshChatView,
  PLUGIN_ID,
  readVaultFile,
  requireEnv,
  sendChatPromptDirect,
  upsertVaultFile,
} from "../utils/systemsculptChat";
import { fetchJson } from "../utils/http";

describe("ChatView (mock) core flows", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL") ?? "http://127.0.0.1:43111/api/v1";
  const mockApiOrigin = serverUrl.replace(/\/api\/v1\/?$/i, "");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  let vaultPath: string;

  const nonce = crypto.randomUUID().slice(0, 8);
  const alphaToken = `ALPHA_${nonce}`;
  const betaToken = `BETA_${nonce}`;
  const okToken = `OK_${nonce}`;

  const alphaPath = "Projects/Revenue Sprint/Alpha Notes.md";
  const betaPath = "Projects/Revenue Sprint/Beta Notes.md";
  const outputPath = "Projects/Revenue Sprint/Output Draft.md";
  const mentionPath = "Reference/SystemSculpt/Mention Sample.md";
  const dragPath = "Reference/SystemSculpt/Drag Sample.md";

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

    await upsertVaultFile(alphaPath, `ALPHA_TOKEN: ${alphaToken}\n`);
    await upsertVaultFile(betaPath, `BETA_TOKEN: ${betaToken}\n`);
    await upsertVaultFile(mentionPath, "Mention me");
    await upsertVaultFile(dragPath, "Drag me");
  });

  it("streams a basic completion and executes a tool call via approval pipeline", async function () {
    this.timeout(120000);

    await openFreshChatView();

    const prompt = [
      "This is an automated compliance test.",
      `Reply with EXACTLY: ${okToken}`,
      "No extra text.",
    ].join("\n");

    await sendChatPromptDirect(prompt);
    await browser.waitUntil(
      async () => {
        const state = await getActiveChatViewState();
        const assistant = [...state.messages].reverse().find((m) => m.role === "assistant");
        const assistantText = coerceMessageContentToText(assistant?.content).trim();
        return assistantText.includes(okToken);
      },
      { timeout: 60000, timeoutMsg: "Assistant did not return the expected completion token." }
    );

    const toolCallId = await browser.executeObsidian(({ app }, { outputPath, alphaToken, betaToken }) => {
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
        id: `e2e-tool-${Date.now()}`,
        type: "function",
        function: {
          name: "mcp-filesystem_write",
          arguments: JSON.stringify({
            path: outputPath,
            content: `ALPHA_TOKEN: ${alphaToken}\nBETA_TOKEN: ${betaToken}\n`,
          }),
        },
      };
      const tc = manager.createToolCall(request, `e2e-message-${Date.now()}`, false);
      return tc.id;
    }, { outputPath, alphaToken, betaToken });

    await approveAllToolCallsDirect();

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
      { timeout: 60000, timeoutMsg: "Tool call did not complete." }
    );

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }, { outputPath }) => {
          const file = app.vault.getAbstractFileByPath(outputPath);
          return !!file;
        }, { outputPath }),
      { timeout: 60000, timeoutMsg: "Output file was not created." }
    );

    const output = await readVaultFile(outputPath);
    expect(output).toContain(alphaToken);
    expect(output).toContain(betaToken);

    const statsResp = await fetchJson(`${mockApiOrigin}/_e2e/stats`, { method: "GET" });
    expect(statsResp.ok).toBe(true);
    expect(Number(statsResp.json?.legacyChatCompletions ?? -1)).toBe(0);
    expect(Number(statsResp.json?.v2Sessions ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Number(statsResp.json?.v2Turns ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("handles context intake + slash export + web search toggle", async function () {
    this.timeout(120000);

    await openFreshChatView();

    // @-mention context add
    await browser.executeObsidian(async ({ app }, { mentionPath }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view = (leaf as any)?.view;
      const input = view?.inputHandler?.input as HTMLTextAreaElement | undefined;
      const menu = view?.inputHandler?.atMentionMenu as any;
      if (!view || !input || !menu) throw new Error("Chat view/menu not ready");
      const query = mentionPath.split("/").pop()?.replace(/\\.md$/, "") ?? "mention";
      input.value = `@${query}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      menu.show(0, input.value.length, query);
    }, { mentionPath });

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }) => {
          const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
          const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
          const activeLeaf: any = app.workspace.activeLeaf as any;
          const leaf =
            markedLeaf ||
            (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
          const view = (leaf as any)?.view;
          const menu = view?.inputHandler?.atMentionMenu as any;
          return (menu?.suggestions?.length ?? 0) > 0;
        }),
      { timeout: 15000, timeoutMsg: "At-mention suggestions did not populate." }
    );

    await browser.executeObsidian(async ({ app }, { mentionPath }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view = (leaf as any)?.view;
      const menu = view?.inputHandler?.atMentionMenu as any;
      if (!menu) throw new Error("At-mention menu missing");
      const suggestions = (menu?.suggestions ?? []) as any[];
      if (suggestions.length === 0) throw new Error("At-mention suggestions empty");
      const pickIndex = suggestions.findIndex((s: any) => String(s?.description ?? "").includes(mentionPath));
      menu.selectedIndex = pickIndex >= 0 ? pickIndex : 0;
      await menu.chooseSelected();
    }, { mentionPath });

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }, { mentionPath }) => {
          const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
          const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
          const activeLeaf: any = app.workspace.activeLeaf as any;
          const leaf =
            markedLeaf ||
            (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
          const view = (leaf as any)?.view;
          const files = Array.from(view?.contextManager?.getContextFiles?.() || []);
          return files.includes(`[[${mentionPath}]]`);
        }, { mentionPath }),
      { timeout: 20000, timeoutMsg: "Mentioned file was not added to context." }
    );

    const dropDebug = await browser.executeObsidian(({ app }, { dragPath }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view: any = (leaf as any)?.view;
      const container = view?.containerEl?.querySelector?.(".systemsculpt-chat-container") as HTMLElement | null;
      if (!container) return { dispatched: false, reason: "Active chat container not found" };
      const dataTransfer: any = {
        items: [
          {
            type: "text/plain",
            getAsString: (cb: (value: string) => void) => {
              cb(dragPath);
            },
          },
        ],
        types: ["text/plain"],
        files: [],
      };
      const event =
        typeof (window as any).DragEvent === "function"
          ? new DragEvent("drop", { bubbles: true, cancelable: true })
          : new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      container.dispatchEvent(event);
      return { dispatched: true };
    }, { dragPath });
    if (!dropDebug?.dispatched) throw new Error("Failed to dispatch drop event.");

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }, { dragPath }) => {
          const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
          const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
          const activeLeaf: any = app.workspace.activeLeaf as any;
          const leaf =
            markedLeaf ||
            (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
          const view = (leaf as any)?.view;
          const files = Array.from(view?.contextManager?.getContextFiles?.() || []);
          return files.includes(`[[${dragPath}]]`);
        }, { dragPath }),
      { timeout: 20000, timeoutMsg: "Drag/drop file was not added to context." }
    );

    // Slash menu: open export modal (using the same command handlers)
    await browser.executeObsidian(async ({ app }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view = (leaf as any)?.view;
      const menu = view?.inputHandler?.slashCommandMenu as any;
      const commands = (menu?.commands ?? []) as any[];
      const exportCmd = commands.find((c) => c?.id === "export");
      if (!exportCmd) throw new Error("Export slash command missing");
      await exportCmd.execute(view);
    });

    const exportModalTitle = await $("h2=Export Chat");
    await exportModalTitle.waitForExist({ timeout: 15000 });

    // Web search toggle (only if supported)
    const supportsWebSearch = await browser.executeObsidian(({ app }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view = (leaf as any)?.view;
      return !!view?.supportsWebSearch?.();
    });
    if (supportsWebSearch) {
      await browser.executeObsidian(({ app }) => {
        const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
        const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
        const activeLeaf: any = app.workspace.activeLeaf as any;
        const leaf =
          markedLeaf ||
          (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
        const view = (leaf as any)?.view;
        view?.inputHandler?.toggleWebSearchEnabled?.();
      });
      const state = await getActiveChatViewState();
      expect(state).toBeTruthy();
    }
  });
});
