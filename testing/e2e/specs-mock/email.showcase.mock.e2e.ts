import { expect } from "@wdio/globals";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getActiveChatViewState,
  getEnv,
  openFreshChatView,
  PLUGIN_ID,
  requireEnv,
  sendChatPromptDirect,
  upsertVaultFile,
  waitForChatComposer,
} from "../utils/systemsculptChat";

describe("Email showcase (mock) tiny workflow", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  let vaultPath: string;

  const briefPath = "Projects/Revenue Sprint/Daily Workflow.md";
  const notesPath = "Projects/Revenue Sprint/Weekly Execution Notes.md";

  const beat = async (ms = 850) => {
    await browser.pause(ms);
  };

  const hasContextPath = async (path: string) => {
    return await browser.executeObsidian(({ app }, path) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view = (leaf as any)?.view;
      const files = Array.from(view?.contextManager?.getContextFiles?.() || []);
      return files.includes(`[[${path}]]`);
    }, path);
  };

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

    await upsertVaultFile(
      briefPath,
      [
        "# Daily Workflow",
        "",
        "- One tiny workflow to focus on each day.",
        "- Keep setup simple and repeatable.",
        "- Goal: less switching, more output.",
      ].join("\n")
    );
    await upsertVaultFile(
      notesPath,
      [
        "# Weekly Execution Notes",
        "",
        "- Save one reusable prompt.",
        "- Run the workflow for 7 days before changing it.",
        "- Evaluate based on focus and output.",
      ].join("\n")
    );
  });

  it("walks through the tiny workflow demo used in strategy 1", async function () {
    this.timeout(180000);

    await openFreshChatView();
    await waitForChatComposer({ inputTimeoutMs: 20000 });
    await beat(1000);

    await browser.executeObsidian(async ({ app }, { briefPath }) => {
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
      const query = briefPath.split("/").pop()?.replace(/\.md$/, "") ?? "feature";
      input.value = `@${query}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      menu.show(0, input.value.length, query);
    }, { briefPath });

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

    await browser.executeObsidian(async ({ app }, { briefPath }) => {
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
      const pickIndex = suggestions.findIndex((s: any) => String(s?.description ?? "").includes(briefPath));
      menu.selectedIndex = pickIndex >= 0 ? pickIndex : 0;
      await menu.chooseSelected();
    }, { briefPath });

    await browser.waitUntil(async () => await hasContextPath(briefPath), {
      timeout: 20000,
      timeoutMsg: "Brief file was not added to context.",
    });
    await beat(1100);

    const dropDebug = await browser.executeObsidian(({ app }, { notesPath }) => {
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
            getAsString: (cb: (value: string) => void) => cb(notesPath),
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
    }, { notesPath });
    if (!dropDebug?.dispatched) throw new Error("Failed to dispatch drop event.");

    await browser.waitUntil(async () => await hasContextPath(notesPath), {
      timeout: 20000,
      timeoutMsg: "Notes file was not added to context.",
    });
    await beat(1100);

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
      await beat(900);
    }

    await beat(500);
    await sendChatPromptDirect(
      [
        "Give me a tiny-workflow kickoff plan in exactly 3 bullets.",
        "Use this structure:",
        "1) Pick one daily workflow.",
        "2) Save one reusable prompt.",
        "3) Run it for 7 days.",
      ].join("\n")
    );
    await beat(700);

    await browser.waitUntil(
      async () => {
        const state = await getActiveChatViewState();
        const assistant = [...state.messages].reverse().find((m) => m.role === "assistant");
        const assistantText = String(assistant?.content ?? "").trim();
        return assistantText.length > 40 && !state.isGenerating;
      },
      { timeout: 60000, timeoutMsg: "Assistant response did not finish for tiny-workflow showcase." }
    );
    await beat(2200);

    const finalState = await getActiveChatViewState();
    expect(finalState.messages.length).toBeGreaterThan(1);
  });
});
