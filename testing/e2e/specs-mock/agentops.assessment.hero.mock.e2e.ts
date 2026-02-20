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

describe("AgentOps assessment hero (mock) workflow", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  let vaultPath: string;

  const intakePath = "Business/AgentOps/Assessment Intake.md";
  const discoveryPath = "Business/AgentOps/Workflow Discovery.md";

  const beat = async (ms = 500) => {
    await browser.pause(ms);
  };

  const hasContextPath = async (path: string) => {
    return await browser.executeObsidian(({ app }, targetPath) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view = (leaf as any)?.view;
      const files = Array.from(view?.contextManager?.getContextFiles?.() || []);
      return files.includes(`[[${targetPath}]]`);
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
      intakePath,
      [
        "# AgentOps Assessment Intake",
        "",
        "- Goal: reduce content ops cycle time by 35%.",
        "- Primary owner: Marketing Operations Lead.",
        "- Constraints: approval logs, PII-safe processing, rollback plan.",
      ].join("\n")
    );

    await upsertVaultFile(
      discoveryPath,
      [
        "# Workflow Discovery",
        "",
        "- Candidate workflows: onboarding follow-up, weekly SEO publish, support triage.",
        "- Risks: missing review gates, unstable prompts, weak attribution.",
        "- Need: ROI scoring + launch path in five business days.",
      ].join("\n")
    );
  });

  it("creates an assessment-ready summary flow for hero capture", async function () {
    this.timeout(180000);

    await openFreshChatView();
    await waitForChatComposer({ inputTimeoutMs: 20000 });
    await beat(420);

    await browser.executeObsidian(async ({ app }, { intakePath }) => {
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
      const query = intakePath.split("/").pop()?.replace(/\.md$/, "") ?? "assessment";
      input.value = `@${query}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      menu.show(0, input.value.length, query);
    }, { intakePath });

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

    await browser.executeObsidian(async ({ app }, { intakePath }) => {
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
      const pickIndex = suggestions.findIndex((s: any) => String(s?.description ?? "").includes(intakePath));
      menu.selectedIndex = pickIndex >= 0 ? pickIndex : 0;
      await menu.chooseSelected();
    }, { intakePath });

    await browser.waitUntil(async () => await hasContextPath(intakePath), {
      timeout: 20000,
      timeoutMsg: "Intake file was not added to context.",
    });
    await beat(450);

    const dropDebug = await browser.executeObsidian(({ app }, { discoveryPath }) => {
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
            getAsString: (cb: (value: string) => void) => cb(discoveryPath),
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
    }, { discoveryPath });
    if (!dropDebug?.dispatched) throw new Error("Failed to dispatch drop event.");

    await browser.waitUntil(async () => await hasContextPath(discoveryPath), {
      timeout: 20000,
      timeoutMsg: "Discovery file was not added to context.",
    });
    await beat(300);

    await sendChatPromptDirect(
      [
        "Draft an AgentOps assessment kickoff snapshot in exactly 4 bullets for leadership.",
        "Bullets must be labeled: Qualification, Discovery, Risk, Launch.",
        "Each bullet must be one short sentence and business-focused.",
      ].join("\n")
    );
    await beat(450);

    await browser.waitUntil(
      async () => {
        const state = await getActiveChatViewState();
        const assistant = [...state.messages].reverse().find((m) => m.role === "assistant");
        const assistantText = String(assistant?.content ?? "").trim();
        return assistantText.length > 80 && !state.isGenerating;
      },
      { timeout: 60000, timeoutMsg: "Assistant response did not finish for AgentOps hero showcase." }
    );

    await beat(2600);

    const finalState = await getActiveChatViewState();
    expect(finalState.messages.length).toBeGreaterThan(1);
  });
});
