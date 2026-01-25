import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePluginEnabled } from "../utils/obsidian";
import { ensureE2EVault, openFreshChatView, PLUGIN_ID } from "../utils/systemsculptChat";

type ApprovalDomSnapshot = {
  assistantCount: number;
  drawerCollapsed: boolean;
  statusText: string;
  approvalDeckVisible: boolean;
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

    const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 10);

    await browser.executeObsidian(({ app }, { nonce }) => {
      const leaf = app.workspace.getLeavesOfType("systemsculpt-chat-view")[0];
      const view: any = leaf?.view;
      if (!view) throw new Error("Chat view missing");

      const aiService: any = view.aiService;
      if (!aiService?.streamMessage) throw new Error("aiService.streamMessage missing");

      const w = window as any;
      if (!w.__ssE2EOriginalStreamMessage) {
        w.__ssE2EOriginalStreamMessage = aiService.streamMessage.bind(aiService);
      }
      w.__ssE2EStreamInvocation = 0;

      aiService.streamMessage = async function* () {
        w.__ssE2EStreamInvocation += 1;
        const invocation = w.__ssE2EStreamInvocation;
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

        if (invocation === 1) {
          yield { type: "reasoning", text: `Reasoning ${nonce}\n` };
          await wait(50);
          yield {
            type: "tool-call",
            phase: "final",
            call: {
              id: `call_${nonce}_write`,
              type: "function",
              function: {
                name: "mcp-filesystem_write",
                arguments: JSON.stringify({ path: `E2E/${nonce}.txt`, content: "hello" }),
              },
            },
          };
          return;
        }

        yield { type: "content", text: `Done ${nonce}` };
      };

      const handler: any = view.inputHandler;
      const orchestrator: any = handler?.orchestrator;
      const lifecycle: any = handler?.turnLifecycle;
      if (!orchestrator?.runTurn) throw new Error("ChatTurnOrchestrator missing");
      if (!lifecycle?.runTurn) throw new Error("ChatTurnLifecycleController missing");

      void lifecycle.runTurn((signal: AbortSignal) =>
        orchestrator.runTurn({
          includeContextFiles: false,
          signal,
        })
      );
    }, { nonce });

    const start = Date.now();
    const samples: Array<{ t: number; dom: ApprovalDomSnapshot }> = [];

    const snapshotDom = async (): Promise<ApprovalDomSnapshot> =>
      await browser.execute(() => {
        const drawer = document.querySelector<HTMLElement>(".systemsculpt-activity-drawer");
        const status = drawer?.querySelector<HTMLElement>(".systemsculpt-activity-drawer-status");
        const deck = document.querySelector<HTMLElement>(".ss-approval-deck");

        const assistants = Array.from(
          document.querySelectorAll<HTMLElement>(".systemsculpt-message.systemsculpt-assistant-message")
        );

        const deckVisible = !!deck && window.getComputedStyle(deck).display !== "none";

        return {
          assistantCount: assistants.length,
          drawerCollapsed: !!drawer?.classList.contains("is-collapsed"),
          statusText: status?.textContent ?? "",
          approvalDeckVisible: deckVisible,
        };
      });

    const restoreStream = async () => {
      await browser.executeObsidian(({ app }) => {
        const view: any = app.workspace.getLeavesOfType("systemsculpt-chat-view")[0]?.view;
        const aiService: any = view?.aiService;
        const w = window as any;
        if (aiService && w.__ssE2EOriginalStreamMessage) {
          aiService.streamMessage = w.__ssE2EOriginalStreamMessage;
        }
        delete w.__ssE2EOriginalStreamMessage;
        delete w.__ssE2EStreamInvocation;
      });
    };

    try {
      await browser.waitUntil(
        async () => {
          const dom = await snapshotDom();
          samples.push({ t: Date.now() - start, dom });
          return dom.approvalDeckVisible;
        },
        { timeout: 30000, timeoutMsg: "Approval deck did not appear." }
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

      const relevant = samples.filter((s) => s.dom.approvalDeckVisible);
      expect(relevant.length).toBeGreaterThan(0);

      for (const sample of relevant) {
        expect(sample.dom.drawerCollapsed).toBe(false);
      }

      expect(relevant[relevant.length - 1].dom.statusText.toLowerCase()).toContain("approval");

      // Deny to let the turn finish and keep test isolation.
      await browser.waitUntil(async () => (await $("button=Deny").isExisting()), { timeout: 20000 });
      await $("button=Deny").click();

      await browser.waitUntil(
        async () => {
          const isGenerating = await browser.executeObsidian(({ app }) => {
            const view: any = app.workspace.getLeavesOfType("systemsculpt-chat-view")[0]?.view;
            return !!view?.isGenerating;
          });
          return !isGenerating;
        },
        { timeout: 60000, timeoutMsg: "Turn did not complete after denying tool call." }
      );

      const maxAssistantCount = samples.reduce((acc, s) => Math.max(acc, s.dom.assistantCount), 0);
      expect(maxAssistantCount).toBe(1);
    } finally {
      await restoreStream();
    }
  });
});
