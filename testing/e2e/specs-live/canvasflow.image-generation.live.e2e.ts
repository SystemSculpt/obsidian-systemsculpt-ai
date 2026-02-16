import { expect } from "@wdio/globals";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  PLUGIN_ID,
  requireEnv,
  upsertVaultFile,
} from "../utils/systemsculptChat";

const INPUT_IMAGE_PATH = "E2E/canvasflow-input.png";
const PROMPT_PATH = "E2E/canvasflow-imagegen-prompt.md";
const CANVAS_PATH = "E2E/canvasflow-imagegen.canvas";
const OUTPUT_PREFIX = "E2E/Generations";

const INPUT_NODE_ID = "e2e-canvasflow-input-node";
const PROMPT_NODE_ID = "e2e-canvasflow-prompt-node";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9slt4d8AAAAASUVORK5CYII=";

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
}

async function writeBinaryImage(path: string, base64: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, { filePath, base64 }) => {
    const normalized = String(filePath || "").replace(/\\/g, "/");
    if (!normalized) throw new Error("Missing image path");

    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const parts = normalized.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error("Invalid image path");

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await app.vault.adapter.exists(current);
      if (!exists) {
        await app.vault.createFolder(current);
      }
    }

    const existing = app.vault.getAbstractFileByPath(normalized);
    if (existing) {
      await app.vault.modifyBinary(existing as any, bytes.buffer);
    } else {
      await app.vault.createBinary(normalized, bytes.buffer);
    }
  }, { filePath: path, base64 });
}

async function enableCanvasFlowEnhancementsWithImageDefaults(): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);

    await plugin.getSettingsManager().updateSettings({
      canvasFlowEnabled: true,
      imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
      imageGenerationOutputDir: "E2E/Generations",
      imageGenerationPollIntervalMs: 1500,
      imageGenerationSaveMetadataSidecar: true,
    });

    if (typeof plugin.syncCanvasFlowEnhancerFromSettings === "function") {
      await plugin.syncCanvasFlowEnhancerFromSettings();
    }
  }, { pluginId: PLUGIN_ID });
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
    { timeout: 20000, timeoutMsg: "Active leaf did not switch to Canvas view." }
  );
}

async function clickRunOnPromptNode(nodeId: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      await browser.execute((targetNodeId) => {
        const controls = document.querySelector<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${targetNodeId}"]`);
        const runButton = controls?.querySelector<HTMLButtonElement>("button.ss-canvasflow-btn-primary");
        return !!runButton;
      }, nodeId),
    { timeout: 30000, timeoutMsg: "CanvasFlow Run button not found for prompt node." }
  );

  await browser.execute((targetNodeId) => {
    const controls = document.querySelector<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${targetNodeId}"]`);
    const runButton = controls?.querySelector<HTMLButtonElement>("button.ss-canvasflow-btn-primary");
    if (!runButton) {
      throw new Error("Run button missing");
    }
    runButton.click();
  }, nodeId);
}

async function readPromptNodeStatus(nodeId: string): Promise<string> {
  return await browser.execute((targetNodeId) => {
    const controls = document.querySelector<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${targetNodeId}"]`);
    const statusEl = controls?.querySelector<HTMLElement>(".ss-canvasflow-status");
    return String(statusEl?.textContent || "").trim();
  }, nodeId);
}

async function readGeneratedArtifacts(): Promise<{ imagePath: string; sidecarPath: string | null; nodeCount: number } | null> {
  return await browser.executeObsidian(
    async ({ app }, args) => {
      const { canvasPath, outputPrefix, inputNodeId, promptNodeId } = args as {
        canvasPath: string;
        outputPrefix: string;
        inputNodeId: string;
        promptNodeId: string;
      };

      const file = app.vault.getAbstractFileByPath(canvasPath);
      if (!file) return null;

      let raw = "";
      try {
        raw = await app.vault.read(file as any);
      } catch {
        return null;
      }

      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }

      const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
      const generated = nodes.find((node: any) => {
        if (!node || typeof node !== "object") return false;
        if (node.id === inputNodeId || node.id === promptNodeId) return false;
        const filePath = typeof node.file === "string" ? node.file : "";
        if (!filePath.startsWith(outputPrefix)) return false;
        return /\.(png|jpg|jpeg|webp|gif)$/i.test(filePath);
      });

      if (!generated || typeof generated.file !== "string") {
        return null;
      }

      const imagePath = generated.file;
      const imageAbs = app.vault.getAbstractFileByPath(imagePath);
      if (!imageAbs) return null;

      const sidecarPath = `${imagePath}.systemsculpt.json`;
      const sidecarAbs = app.vault.getAbstractFileByPath(sidecarPath);

      return {
        imagePath,
        sidecarPath: sidecarAbs ? sidecarPath : null,
        nodeCount: nodes.length,
      };
    },
    {
      canvasPath: CANVAS_PATH,
      outputPrefix: OUTPUT_PREFIX,
      inputNodeId: INPUT_NODE_ID,
      promptNodeId: PROMPT_NODE_ID,
    }
  );
}

describe("CanvasFlow (live) image generation via SystemSculpt API", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  before(async () => {
    const vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
    });

    await ensureCorePluginEnabled("canvas");
    await enableCanvasFlowEnhancementsWithImageDefaults();

    await writeBinaryImage(INPUT_IMAGE_PATH, TINY_PNG_BASE64);
    await upsertVaultFile(
      PROMPT_PATH,
      [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: openrouter",
        "ss_image_model: openai/gpt-5-image-mini",
        "ss_image_count: 1",
        "ss_image_aspect_ratio: 1:1",
        "---",
        "Stylize this image as a clean product hero shot on a white table.",
        "",
      ].join("\n")
    );

    await upsertVaultFile(
      CANVAS_PATH,
      JSON.stringify(
        {
          nodes: [
            {
              id: INPUT_NODE_ID,
              type: "file",
              file: INPUT_IMAGE_PATH,
              x: -420,
              y: 0,
              width: 320,
              height: 320,
            },
            {
              id: PROMPT_NODE_ID,
              type: "file",
              file: PROMPT_PATH,
              x: 0,
              y: 0,
              width: 640,
              height: 720,
            },
          ],
          edges: [
            {
              id: "edge-input-to-prompt",
              fromNode: INPUT_NODE_ID,
              toNode: PROMPT_NODE_ID,
            },
          ],
        },
        null,
        2
      )
    );
  });

  it("generates an image using API job polling and writes output + sidecar", async function () {
    this.timeout(10 * 60_000);

    await openCanvasFile(CANVAS_PATH);
    await clickRunOnPromptNode(PROMPT_NODE_ID);

    let lastStatus = "";
    await browser.waitUntil(
      async () => {
        const artifacts = await readGeneratedArtifacts();
        if (artifacts) return true;

        const status = await readPromptNodeStatus(PROMPT_NODE_ID);
        if (status) {
          lastStatus = status;
          const lower = status.toLowerCase();
          if (
            lower.includes("failed") ||
            lower.includes("error") ||
            lower.includes("not enabled") ||
            lower.includes("insufficient")
          ) {
            throw new Error(`CanvasFlow run failed: ${status}`);
          }
        }

        return false;
      },
      {
        timeout: 8 * 60_000,
        interval: 2000,
        timeoutMsg: `CanvasFlow did not produce a generated output node within the timeout. last_status=${lastStatus || "(empty)"}`,
      }
    );

    const artifacts = await readGeneratedArtifacts();
    if (!artifacts) {
      throw new Error("Generated artifacts were not found after wait.");
    }

    expect(artifacts.imagePath).toContain(`${OUTPUT_PREFIX}/`);
    expect(artifacts.nodeCount).toBeGreaterThanOrEqual(3);
    expect(artifacts.sidecarPath).not.toBeNull();
  });
});
