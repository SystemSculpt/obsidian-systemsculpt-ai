import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePluginEnabled } from "../utils/obsidian";
import { ensureE2EVault, openFreshChatView, PLUGIN_ID } from "../utils/systemsculptChat";

type DomSnapshot = {
  assistantCount: number;
  assistantIds: string[];
  groupCount: number;
  activityDrawerCount: number;
};

describe("ChatView (live) streaming containerization", () => {
  let vaultPath: string;

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
  });

  it("keeps a single assistant container through tool continuations", async function () {
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
              id: `call_${nonce}abcd`,
              type: "function",
              function: {
                name: "mcp-filesystem_list_items",
                arguments: JSON.stringify({ path: "E2E" }),
              },
            },
          };
          return;
        }

        // Continuation: keep streaming long enough to observe container churn.
        yield { type: "content", text: `Chunk 1 ${nonce}\n` };
        await wait(250);
        yield { type: "content", text: `Chunk 2 ${nonce}\n` };
        await wait(250);
        yield { type: "content", text: `Chunk 3 ${nonce}\n` };
        await wait(250);
        yield { type: "content", text: `Done ${nonce}` };
      };

      // Start a synthetic turn without provider/license dependencies.
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
    const samples: Array<{ t: number; dom: DomSnapshot }> = [];

    const snapshotDom = async (): Promise<DomSnapshot> =>
      await browser.execute(() => {
        const assistants = Array.from(
          document.querySelectorAll<HTMLElement>(".systemsculpt-message.systemsculpt-assistant-message")
        );
        return {
          assistantCount: assistants.length,
          assistantIds: assistants.map((el) => el.dataset.messageId || el.getAttribute("data-message-id") || ""),
          groupCount: document.querySelectorAll(".systemsculpt-message-group").length,
          activityDrawerCount: document.querySelectorAll(".systemsculpt-activity-drawer").length,
        };
      });

    await browser.waitUntil(
      async () => {
        const dom = await snapshotDom();
        samples.push({ t: Date.now() - start, dom });

        const isGenerating = await browser.executeObsidian(({ app }) => {
          const view: any = app.workspace.getLeavesOfType("systemsculpt-chat-view")[0]?.view;
          return !!view?.isGenerating;
        });
        return !isGenerating;
      },
      { timeout: 60000, timeoutMsg: "Synthetic streaming turn did not complete." }
    );

    // One more sample after completion.
    samples.push({ t: Date.now() - start, dom: await snapshotDom() });

    // Best-effort restore (keep test isolation even on failure).
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

    const maxAssistantCount = samples.reduce((acc, s) => Math.max(acc, s.dom.assistantCount), 0);
    const uniqueAssistantIds = new Set(samples.flatMap((s) => s.dom.assistantIds).filter((id) => id));

    const output = {
      generatedAt: new Date().toISOString(),
      nonce,
      maxAssistantCount,
      uniqueAssistantIds: Array.from(uniqueAssistantIds),
      samples,
    };

    const outputPath = path.join(process.cwd(), "testing", "e2e", "logs", `streaming-containerization-${Date.now()}.json`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`[e2e] streaming containerization metrics written: ${outputPath}`);

    // Expect a single assistant message element throughout tool continuations.
    expect(maxAssistantCount).toBe(1);
    expect(uniqueAssistantIds.size).toBe(1);
  });
});
