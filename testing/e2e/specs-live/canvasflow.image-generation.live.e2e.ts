import { expect } from "@wdio/globals";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  ensureE2EVault,
  getEnv,
  PLUGIN_ID,
  requireEnv,
  upsertVaultFile,
} from "../utils/systemsculptChat";
import {
  configureCanvasFlowImageDefaults,
  configureCanvasFlowPluginForE2E,
  runCanvasFlowPromptToCompletion,
  writeBinaryImage,
} from "../utils/canvasflow";

const INPUT_IMAGE_PATH_A = "E2E/canvasflow-input-a.png";
const INPUT_IMAGE_PATH_B = "E2E/canvasflow-input-b.png";
const PROMPT_PATH = "E2E/canvasflow-imagegen-prompt.md";
const CANVAS_PATH = "E2E/canvasflow-imagegen.canvas";
const OUTPUT_PREFIX = "SystemSculpt/Attachments/Generations/E2E/Generations";

const INPUT_NODE_ID_A = "e2e-canvasflow-input-node-a";
const INPUT_NODE_ID_B = "e2e-canvasflow-input-node-b";
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

async function readGeneratedArtifacts(): Promise<{
  imagePath: string;
  sidecarPath: string | null;
  sidecarInputImages: string[];
  nodeCount: number;
} | null> {
  return await browser.executeObsidian(
    async ({ app }, args) => {
      const { canvasPath, outputPrefix, inputNodeIds, promptNodeId } = args as {
        canvasPath: string;
        outputPrefix: string;
        inputNodeIds: string[];
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
        if (inputNodeIds.includes(node.id) || node.id === promptNodeId) return false;
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
      let sidecarInputImages: string[] = [];
      if (sidecarAbs) {
        try {
          const sidecarRaw = await app.vault.read(sidecarAbs as any);
          const sidecarJson = JSON.parse(sidecarRaw);
          sidecarInputImages = Array.isArray(sidecarJson?.input_images)
            ? sidecarJson.input_images.map((v: unknown) => String(v))
            : [];
        } catch {}
      }

      return {
        imagePath,
        sidecarPath: sidecarAbs ? sidecarPath : null,
        sidecarInputImages,
        nodeCount: nodes.length,
      };
    },
    {
      canvasPath: CANVAS_PATH,
      outputPrefix: OUTPUT_PREFIX,
      inputNodeIds: [INPUT_NODE_ID_A, INPUT_NODE_ID_B],
      promptNodeId: PROMPT_NODE_ID,
    }
  );
}

describe("CanvasFlow (live) image generation via SystemSculpt API", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = requireEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  before(async () => {
    const vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configureCanvasFlowPluginForE2E({
      pluginId: PLUGIN_ID,
      licenseKey,
      serverUrl,
      selectedModelId,
    });

    await ensureCorePluginEnabled("canvas");
    await configureCanvasFlowImageDefaults({
      pluginId: PLUGIN_ID,
      outputDir: OUTPUT_PREFIX,
      pollIntervalMs: 1500,
      modelId: "openai/gpt-5-image-mini",
      saveMetadataSidecar: true,
    });

    await writeBinaryImage(INPUT_IMAGE_PATH_A, TINY_PNG_BASE64);
    await writeBinaryImage(INPUT_IMAGE_PATH_B, TINY_PNG_BASE64);
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
              id: INPUT_NODE_ID_A,
              type: "file",
              file: INPUT_IMAGE_PATH_A,
              x: -420,
              y: 0,
              width: 320,
              height: 320,
            },
            {
              id: INPUT_NODE_ID_B,
              type: "file",
              file: INPUT_IMAGE_PATH_B,
              x: -420,
              y: 360,
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
          edges: [],
        },
        null,
        2
      )
    );
  });

  it("generates an image using API job polling and writes output + sidecar", async function () {
    this.timeout(10 * 60_000);
    await browser.setTimeout({ script: 10 * 60_000 });

    await openCanvasFile(CANVAS_PATH);
    await runCanvasFlowPromptToCompletion({
      pluginId: PLUGIN_ID,
      canvasPath: CANVAS_PATH,
      promptNodeId: PROMPT_NODE_ID,
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 1_000,
    });

    await browser.waitUntil(
      async () => {
        const artifacts = await readGeneratedArtifacts();
        return !!artifacts;
      },
      {
        timeout: 20000,
        interval: 1000,
        timeoutMsg: "CanvasFlow run completed but generated output node was not found in time.",
      }
    );

    const artifacts = await readGeneratedArtifacts();
    if (!artifacts) {
      throw new Error("Generated artifacts were not found after wait.");
    }

    expect(artifacts.imagePath).toContain(`${OUTPUT_PREFIX}/`);
    expect(artifacts.nodeCount).toBeGreaterThanOrEqual(3);
    expect(artifacts.sidecarPath).not.toBeNull();
    expect(artifacts.sidecarInputImages.length).toBe(0);
  });
});
