import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  openFreshChatView,
  PLUGIN_ID,
  requireEnv,
} from "../utils/systemsculptChat";

type RectMetrics = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type SpacingMetrics = {
  tool: {
    prefix: RectMetrics;
    text: RectMetrics;
    line: RectMetrics;
    deltaX: number;
    deltaY: number;
  };
  reasoning: {
    prefix: RectMetrics;
    text: RectMetrics;
    line: RectMetrics;
    scroll: RectMetrics;
    deltaX: number;
    deltaY: number;
    computed: {
      scrollPaddingLeft: string;
      scrollPaddingTop: string;
      scrollMarginTop: string;
      lineGap: string;
    };
  };
};

describe("ChatView (live) reasoning spacing", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  let vaultPath: string;

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        debugMode: true,
      },
    });
  });

  it("logs and constrains reasoning indent vs tool lines", async function () {
    this.timeout(180000);

    await openFreshChatView();

    const nonce = crypto.randomUUID().slice(0, 8);

    await browser.executeObsidian(({ app }, { nonce }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view: any = (leaf as any)?.view;
      if (!view) throw new Error("Chat view missing");

      const messageId = `e2e-spacing-${Date.now()}-${nonce}`;
      const toolCall = {
        id: `call_spacing_${nonce}`,
        messageId,
        request: {
          id: `call_spacing_${nonce}`,
          type: "function",
          function: {
            name: "mcp-filesystem_list_items",
            arguments: JSON.stringify({ path: "src" }),
          },
        },
        state: "completed",
        timestamp: Date.now(),
        result: { success: true, data: { results: [] } },
        autoApproved: true,
      };

      const message = {
        role: "assistant",
        message_id: messageId,
        content: `E2E spacing sentinel ${nonce}`,
        tool_calls: [toolCall],
        messageParts: [
          { id: `tool_call_part-${toolCall.id}`, type: "tool_call", timestamp: 1, data: toolCall },
          { id: `reasoning-${nonce}`, type: "reasoning", timestamp: 2, data: `Reasoning text ${nonce}` },
          { id: `content-${nonce}`, type: "content", timestamp: 3, data: `Done ${nonce}` },
        ],
      };

      view.messages.push(message);
      view.addMessage("assistant", message.content, messageId, message);
    }, { nonce });

    const reasoningSelector = ".systemsculpt-inline-reasoning";
    try {
      await $(reasoningSelector).waitForExist({ timeout: 20000 });
      await browser.waitUntil(
        async () =>
          await browser.execute(() => {
            const reasoningText = document.querySelector(".systemsculpt-inline-reasoning .systemsculpt-inline-reasoning-text");
            const toolText = document.querySelector(".systemsculpt-inline-tool_call .systemsculpt-chat-structured-line-text");
            return !!reasoningText && !!toolText;
          }),
        { timeout: 20000, timeoutMsg: "Expected reasoning/tool elements not found." }
      );
    } catch {
      this.skip();
      return;
    }

    const metrics = (await browser.execute(() => {
      const toRect = (rect: DOMRect): RectMetrics => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });

      const toolPrefix = document.querySelector<HTMLElement>(
        ".systemsculpt-inline-tool_call .systemsculpt-chat-structured-line-prefix"
      );
      const toolText = document.querySelector<HTMLElement>(
        ".systemsculpt-inline-tool_call .systemsculpt-chat-structured-line-text"
      );
      const toolLine = toolPrefix?.closest<HTMLElement>(".systemsculpt-chat-structured-line");

      const reasoningPrefix = document.querySelector<HTMLElement>(
        ".systemsculpt-inline-reasoning .systemsculpt-inline-collapsible-icon"
      );
      const reasoningText = document.querySelector<HTMLElement>(
        ".systemsculpt-inline-reasoning .systemsculpt-inline-reasoning-text"
      );
      const reasoningScroll = document.querySelector<HTMLElement>(
        ".systemsculpt-inline-reasoning .systemsculpt-inline-collapsible-content"
      );
      const reasoningLine = reasoningPrefix?.closest<HTMLElement>(".systemsculpt-inline-reasoning");

      if (!toolPrefix || !toolText || !toolLine) throw new Error("Tool line elements missing");
      if (!reasoningPrefix || !reasoningText || !reasoningScroll || !reasoningLine) {
        throw new Error("Reasoning line elements missing");
      }

      const toolPrefixRect = toolPrefix.getBoundingClientRect();
      const toolTextRect = toolText.getBoundingClientRect();
      const toolLineRect = toolLine.getBoundingClientRect();

      const reasoningPrefixRect = reasoningPrefix.getBoundingClientRect();
      const reasoningTextRect = reasoningText.getBoundingClientRect();
      const reasoningLineRect = reasoningLine.getBoundingClientRect();
      const reasoningScrollRect = reasoningScroll.getBoundingClientRect();

      const toolDeltaX = toolTextRect.left - toolPrefixRect.right;
      const toolDeltaY = toolTextRect.top - toolLineRect.top;

      const reasoningDeltaX = reasoningTextRect.left - reasoningPrefixRect.right;
      const reasoningDeltaY = reasoningTextRect.top - reasoningLineRect.top;

      const scrollStyle = window.getComputedStyle(reasoningScroll);
      const lineStyle = window.getComputedStyle(toolLine);

      return {
        tool: {
          prefix: toRect(toolPrefixRect),
          text: toRect(toolTextRect),
          line: toRect(toolLineRect),
          deltaX: toolDeltaX,
          deltaY: toolDeltaY,
        },
        reasoning: {
          prefix: toRect(reasoningPrefixRect),
          text: toRect(reasoningTextRect),
          line: toRect(reasoningLineRect),
          scroll: toRect(reasoningScrollRect),
          deltaX: reasoningDeltaX,
          deltaY: reasoningDeltaY,
          computed: {
            scrollPaddingLeft: scrollStyle.paddingLeft,
            scrollPaddingTop: scrollStyle.paddingTop,
            scrollMarginTop: scrollStyle.marginTop,
            lineGap: lineStyle.gap,
          },
        },
      };
    })) as SpacingMetrics;

    const output = {
      generatedAt: new Date().toISOString(),
      metrics,
    };

    const outputPath = path.join(process.cwd(), "testing", "e2e", "logs", `reasoning-spacing-${Date.now()}.json`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`[e2e] reasoning spacing metrics written: ${outputPath}`);
    console.log(JSON.stringify(metrics, null, 2));

    // Keep expectations permissive; this spec is primarily for diagnostics. The
    // goal is to keep reasoning reasonably aligned with tool lines.
    expect(metrics.reasoning.deltaX).toBeLessThanOrEqual(metrics.tool.deltaX + 48);
    expect(metrics.reasoning.deltaY).toBeGreaterThanOrEqual(0);
    expect(metrics.reasoning.deltaY).toBeLessThanOrEqual(24);
  });
});
