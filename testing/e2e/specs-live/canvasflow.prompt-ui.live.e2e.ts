import { expect } from "@wdio/globals";
import { ensurePluginEnabled } from "../utils/obsidian";
import { ensureE2EVault, PLUGIN_ID, upsertVaultFile } from "../utils/systemsculptChat";
import { CANVASFLOW_PROMPT_NODE_HEIGHT_PX, CANVASFLOW_PROMPT_NODE_WIDTH_PX } from "../../../src/services/canvasflow/CanvasFlowUiConstants";

async function ensureCorePluginEnabled(pluginId: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const internal: any = (app as any)?.internalPlugins;
    if (!internal) return;
    if (typeof internal.enablePluginAndSave === "function") {
      await internal.enablePluginAndSave(pluginId);
      return;
    }
    if (typeof internal.enablePlugin === "function") {
      await internal.enablePlugin(pluginId);
      return;
    }
  }, { pluginId });

  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(({ app }, { pluginId }) => {
        const internal: any = (app as any)?.internalPlugins;
        const enabled = internal?.enabledPlugins ?? internal?.enabled ?? null;
        if (enabled && typeof enabled.has === "function") {
          return enabled.has(pluginId);
        }
        if (Array.isArray(enabled)) {
          return enabled.includes(pluginId);
        }
        const plugin = internal?.getPluginById?.(pluginId);
        return plugin?.enabled === true;
      }, { pluginId }),
    { timeout: 20000, timeoutMsg: `Core plugin not enabled: ${pluginId}` }
  );
}

async function enableCanvasFlowEnhancements(): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    await plugin.getSettingsManager().updateSettings({ canvasFlowEnabled: true });

    // E2E runs can race plugin deferred init; force-start the enhancer if possible.
    try {
      if (typeof plugin.syncCanvasFlowEnhancerFromSettings === "function") {
        await plugin.syncCanvasFlowEnhancerFromSettings();
      } else if (typeof plugin["syncCanvasFlowEnhancerFromSettings"] === "function") {
        await plugin["syncCanvasFlowEnhancerFromSettings"]();
      }
    } catch (_) {}
  }, { pluginId: PLUGIN_ID });

  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(({ app }, { pluginId }) => {
        const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
        return plugin?.settings?.canvasFlowEnabled === true && !!plugin?.canvasFlowEnhancer;
      }, { pluginId: PLUGIN_ID }),
    { timeout: 30000, timeoutMsg: "CanvasFlow enhancer did not start after enabling setting." }
  );
}

async function openCanvasFile(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, filePath) => {
    const normalized = String(filePath).replace(/\\/g, "/");
    const file = app.vault.getAbstractFileByPath(normalized);
    if (!file) throw new Error(`File not found: ${normalized}`);
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(file as any);
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, path);

  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(({ app }) => {
        return (app.workspace as any)?.activeLeaf?.view?.getViewType?.() === "canvas";
      }),
    { timeout: 20000, timeoutMsg: "Active leaf did not switch to Canvas view after opening .canvas file." }
  );
}

async function getPromptNodeUiState(nodeId: string): Promise<{
  found: boolean;
  hasPromptClass: boolean;
  hasCard: boolean;
  cardVisible: boolean;
  hasLegacyControls: boolean;
  contentHostCount: number;
  debug: Record<string, any>;
}> {
  return await browser.executeObsidian(({ app }, { nodeId }) => {
    const plugin: any = (app as any)?.plugins?.getPlugin?.("systemsculpt-ai");
    const enhancer: any = plugin?.canvasFlowEnhancer ?? null;
    const canvasLeaves = app.workspace.getLeavesOfType?.("canvas") ?? [];

    const esc = (value: string): string => {
      try {
        const css: any = (globalThis as any)?.CSS;
        if (css && typeof css.escape === "function") return css.escape(value);
      } catch (_) {}
      return value.replaceAll('"', '\\"');
    };

    const card = document.querySelector<HTMLElement>(`.ss-canvasflow-node-card[data-ss-node-id="${esc(nodeId)}"]`);
    const nodeEl = card?.closest?.(".canvas-node") as HTMLElement | null;
    const legacyControls = document.querySelector<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${esc(nodeId)}"]`);

    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".canvas-node"));
    if (!card || !nodeEl) {
      const sample = nodes[0] || null;
      const sampleAttrs: Record<string, string> = {};
      const sampleContentAttrs: Record<string, string> = {};
      const sampleContentDatasetKeys: string[] = [];
      if (sample) {
        for (const attr of Array.from(sample.attributes)) {
          sampleAttrs[attr.name] = attr.value;
        }
        const contentEl =
          sample.querySelector<HTMLElement>(".canvas-node-content") ||
          sample.querySelector<HTMLElement>(".canvas-node-container") ||
          null;
        if (contentEl) {
          for (const attr of Array.from(contentEl.attributes)) {
            sampleContentAttrs[attr.name] = attr.value;
          }
          sampleContentDatasetKeys.push(...Object.keys((contentEl as any).dataset || {}));
        }
      }
      return {
        found: false,
        hasPromptClass: false,
        hasCard: false,
        cardVisible: false,
        hasLegacyControls: !!legacyControls,
        contentHostCount: 0,
        debug: {
          nodeCount: nodes.length,
          cardSelector: `.ss-canvasflow-node-card[data-ss-node-id="${nodeId}"]`,
          cardFound: !!card,
          nodeElFound: !!nodeEl,
          legacyControlsFound: !!legacyControls,
          activeLeafType: (app.workspace as any)?.activeLeaf?.view?.getViewType?.() ?? "unknown",
          canvasLeafCount: Array.isArray(canvasLeaves) ? canvasLeaves.length : 0,
          pluginCanvasFlowEnabled: plugin?.settings?.canvasFlowEnabled === true,
          enhancerExists: !!enhancer,
          enhancerControllerCount: enhancer?.controllers?.size ?? null,
          sampleNodeAttrs: sampleAttrs,
          sampleNodeDatasetKeys: sample ? Object.keys((sample as any).dataset || {}) : [],
          sampleContentAttrs,
          sampleContentDatasetKeys,
          sampleNodeHtml: sample ? sample.outerHTML.slice(0, 2000) : null,
        },
      };
    }

    const hasCard = !!card;
    const win = nodeEl.ownerDocument?.defaultView || window;
    const cardVisible =
      !!card &&
      win.getComputedStyle(card).display !== "none" &&
      card.getBoundingClientRect().width > 0 &&
      card.getBoundingClientRect().height > 0;
    const contentHostCount = nodeEl.querySelectorAll(".canvas-node-content, .canvas-node-container").length;
    return {
      found: true,
      hasPromptClass: nodeEl.classList.contains("ss-canvasflow-prompt-node"),
      hasCard,
      cardVisible,
      hasLegacyControls: !!legacyControls,
      contentHostCount,
      debug: {
        className: nodeEl.className,
        html: nodeEl.innerHTML.slice(0, 2000),
        canvasLeafCount: Array.isArray(canvasLeaves) ? canvasLeaves.length : 0,
        pluginCanvasFlowEnabled: plugin?.settings?.canvasFlowEnabled === true,
        enhancerExists: !!enhancer,
        enhancerControllerCount: enhancer?.controllers?.size ?? null,
      },
    };
  }, { nodeId });
}

async function getPromptNodeRect(nodeId: string): Promise<{ left: number; top: number; width: number; height: number } | null> {
  return await browser.execute((nodeId) => {
    const card = document.querySelector<HTMLElement>(`.ss-canvasflow-node-card[data-ss-node-id="${nodeId}"]`);
    let nodeEl = (card?.closest?.(".canvas-node") as HTMLElement | null) || null;
    if (!nodeEl) {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(".canvas-node.ss-canvasflow-prompt-node"));
      if (candidates.length === 1) {
        nodeEl = candidates[0];
      }
    }
    if (!nodeEl) return null;
    const rect = nodeEl.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, nodeId);
}

async function getPromptNodeComputedSize(nodeId: string): Promise<{ width: number; height: number } | null> {
  return await browser.execute((nodeId) => {
    const card = document.querySelector<HTMLElement>(`.ss-canvasflow-node-card[data-ss-node-id="${nodeId}"]`);
    let nodeEl = (card?.closest?.(".canvas-node") as HTMLElement | null) || null;
    if (!nodeEl) {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(".canvas-node.ss-canvasflow-prompt-node"));
      if (candidates.length === 1) nodeEl = candidates[0];
    }
    if (!nodeEl) return null;
    const style = (nodeEl.ownerDocument?.defaultView || window).getComputedStyle(nodeEl);
    const width = Number.parseFloat(style.width || "");
    const height = Number.parseFloat(style.height || "");
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  }, nodeId);
}

async function dispatchWheelOnPromptCard(nodeId: string, deltaY: number): Promise<void> {
  await browser.execute((args) => {
    const { nodeId, deltaY } = args as { nodeId: string; deltaY: number };
    const card = document.querySelector<HTMLElement>(`.ss-canvasflow-node-card[data-ss-node-id="${nodeId}"]`);
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const event = new WheelEvent("wheel", {
      deltaY,
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    card.dispatchEvent(event);
  }, { nodeId, deltaY });
}

async function getCanvasNodeSizeFromVault(canvasPath: string, nodeId: string): Promise<{ width: number | null; height: number | null } | null> {
  return await browser.executeObsidian(async ({ app }, { canvasPath, nodeId }) => {
    const file = app.vault.getAbstractFileByPath(String(canvasPath).replace(/\\/g, "/"));
    if (!file) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await app.vault.read(file as any);
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
    const node = nodes.find((n: any) => n && typeof n === "object" && n.id === nodeId) || null;
    if (!node) return null;
    const width = typeof node.width === "number" && Number.isFinite(node.width) ? node.width : null;
    const height = typeof node.height === "number" && Number.isFinite(node.height) ? node.height : null;
    return { width, height };
  }, { canvasPath, nodeId });
}

describe("CanvasFlow (live) prompt node UI", () => {
  const promptPath = "E2E/canvasflow-prompt.md";
  const canvasPath = "E2E/canvasflow.canvas";
  const nodeId = "e2e-prompt-node";

  before(async () => {
    const vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await ensureCorePluginEnabled("canvas");
    await enableCanvasFlowEnhancements();

    await upsertVaultFile(
      promptPath,
      [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: openrouter",
        "ss_image_model: openai/gpt-5-image-mini",
        "ss_image_count: 1",
        "ss_image_aspect_ratio: 1:1",
        "---",
        "Photorealistic test prompt.",
        "",
      ].join("\n")
    );

    await upsertVaultFile(
      canvasPath,
      JSON.stringify(
        {
          nodes: [
            {
              id: nodeId,
              type: "file",
              file: promptPath,
              x: 0,
              y: 0,
              // Intentionally non-canonical: plugin should normalize the Canvas doc to the fixed size.
              width: 900,
              height: 900,
            },
          ],
          edges: [],
        },
        null,
        2
      )
    );
  });

  it("injects custom prompt cards and keeps them stable after selection changes", async function () {
    this.timeout(180000);

    await openCanvasFile(canvasPath);

    let lastState: Awaited<ReturnType<typeof getPromptNodeUiState>> | null = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      lastState = await getPromptNodeUiState(nodeId);
      if (lastState.found && lastState.hasPromptClass && lastState.hasCard && lastState.cardVisible && !lastState.hasLegacyControls) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await browser.pause(250);
    }

    if (!lastState || !lastState.found || !lastState.hasPromptClass || !lastState.hasCard || !lastState.cardVisible || lastState.hasLegacyControls) {
      throw new Error(`Prompt node card was not injected/visible or legacy controls still exist. state=${JSON.stringify(lastState)}`);
    }

    // Fixed sizing: prompt nodes should clamp to the canonical dimensions.
    const computed = await getPromptNodeComputedSize(nodeId);
    if (!computed) {
      throw new Error("Failed to read prompt node computed size for sizing assertion.");
    }
    expect(Math.round(computed.width)).toBe(CANVASFLOW_PROMPT_NODE_WIDTH_PX);
    expect(Math.round(computed.height)).toBe(CANVASFLOW_PROMPT_NODE_HEIGHT_PX);

    // Underlying Canvas doc should also be normalized (important for edge/port positioning).
    await browser.waitUntil(
      async () => {
        const size = await getCanvasNodeSizeFromVault(canvasPath, nodeId);
        return size?.width === CANVASFLOW_PROMPT_NODE_WIDTH_PX && size?.height === CANVASFLOW_PROMPT_NODE_HEIGHT_PX;
      },
      { timeout: 15000, timeoutMsg: "Canvas doc node width/height was not normalized to canonical size." }
    );

    // Regression test: panning via trackpad scroll should still work when the cursor is over our injected UI.
    // (Previously we stopped wheel propagation and Canvas could not pan while hovering our prompt node.)
    const beforePan = await getPromptNodeRect(nodeId);
    if (!beforePan) {
      throw new Error("Failed to read prompt node rect before pan.");
    }
    await dispatchWheelOnPromptCard(nodeId, 220);
    await browser.pause(350);
    const afterPan = await getPromptNodeRect(nodeId);
    if (!afterPan) {
      throw new Error("Failed to read prompt node rect after pan.");
    }
    const panDelta = Math.abs(afterPan.top - beforePan.top) + Math.abs(afterPan.left - beforePan.left);
    if (panDelta < 2) {
      throw new Error(`Expected Canvas to pan from wheel over prompt UI, but node position didn't move. delta=${panDelta}`);
    }

    // Click the node (selection changes can trigger Canvas re-rendering).
    await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('.ss-canvasflow-node-card[data-ss-node-id="e2e-prompt-node"]');
      const nodeEl = card?.closest?.(".canvas-node") as HTMLElement | null;
      nodeEl?.click?.();
    });

    // Sample for a short window to catch the "flash then disappear" bug.
    const samples: Array<{ hasCard: boolean; hasPromptClass: boolean; cardVisible: boolean; hasLegacyControls: boolean }> = [];
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await browser.pause(250);
      // eslint-disable-next-line no-await-in-loop
      const state = await getPromptNodeUiState(nodeId);
      samples.push({
        hasCard: state.hasCard,
        hasPromptClass: state.hasPromptClass,
        cardVisible: state.cardVisible,
        hasLegacyControls: state.hasLegacyControls,
      });
    }

    const last = samples.slice(-4);
    const stable = last.every((s) => s.hasCard && s.hasPromptClass && s.cardVisible && !s.hasLegacyControls);
    if (!stable) {
      const debugState = await getPromptNodeUiState(nodeId);
      throw new Error(`CanvasFlow prompt UI not stable after selection changes. samples=${JSON.stringify(samples)} debug=${JSON.stringify(debugState.debug)}`);
    }

    expect(stable).toBe(true);
  });
});
