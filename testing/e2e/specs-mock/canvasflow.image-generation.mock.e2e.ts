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

const INPUT_IMAGE_PATH_A = "E2E/canvasflow-mock-input-a.png";
const INPUT_IMAGE_PATH_B = "E2E/canvasflow-mock-input-b.png";
const PROMPT_PATH = "E2E/canvasflow-mock-prompt.md";
const CANVAS_PATH = "E2E/canvasflow-mock.canvas";
const OUTPUT_PREFIX = "SystemSculpt/Attachments/Generations/E2E/Generations";
const PROMPT_NODE_ID = "e2e-canvasflow-mock-prompt-node";
const INPUT_NODE_ID_A = "e2e-canvasflow-mock-input-node-a";
const INPUT_NODE_ID_B = "e2e-canvasflow-mock-input-node-b";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9slt4d8AAAAASUVORK5CYII=";

async function readMockServerStats(serverUrl: string | null | undefined): Promise<Record<string, unknown>> {
  const fallback = "http://127.0.0.1:43111/api/v1";
  const base = String(serverUrl || fallback).trim() || fallback;
  const parsed = new URL(base);
  const url = `${parsed.origin}/_e2e/stats`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to read mock stats: HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function readGeneratedArtifacts(): Promise<{
  imagePath: string;
  sidecarPath: string;
  sidecarInputImages: string[];
  nodeCount: number;
} | null> {
  return await browser.executeObsidian(
    async ({ app }, { canvasPath, outputPrefix }) => {
      const canvasFile = app.vault.getAbstractFileByPath(canvasPath);
      if (!canvasFile) return null;

      const raw = await app.vault.read(canvasFile as any);
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
      const generated = nodes.find((node: any) => {
        if (!node || typeof node !== "object") return false;
        const file = typeof node.file === "string" ? node.file : "";
        return file.startsWith(`${outputPrefix}/`) && /\.(png|jpg|jpeg|webp|gif)$/i.test(file);
      });

      if (!generated || typeof generated.file !== "string") {
        return null;
      }

      const imagePath = generated.file;
      const imageAbs = app.vault.getAbstractFileByPath(imagePath);
      if (!imageAbs) return null;

      const sidecarPath = `${imagePath}.systemsculpt.json`;
      const sidecarAbs = app.vault.getAbstractFileByPath(sidecarPath);
      if (!sidecarAbs) return null;

      const sidecarRaw = await app.vault.read(sidecarAbs as any);
      const sidecarJson = JSON.parse(sidecarRaw);
      const sidecarInputImages = Array.isArray(sidecarJson?.input_images) ? sidecarJson.input_images : [];

      return {
        imagePath,
        sidecarPath,
        sidecarInputImages,
        nodeCount: nodes.length,
      };
    },
    {
      canvasPath: CANVAS_PATH,
      outputPrefix: OUTPUT_PREFIX,
    }
  );
}

describe("CanvasFlow image generation (mock API)", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const mockPort = getEnv("SYSTEMSCULPT_E2E_MOCK_PORT") ?? "43111";
  const serverUrl = `http://127.0.0.1:${mockPort}/api/v1`;
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

    await configureCanvasFlowImageDefaults({
      pluginId: PLUGIN_ID,
      outputDir: OUTPUT_PREFIX,
      pollIntervalMs: 400,
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
        "Make a crisp product photo variant.",
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
              x: 0,
              y: 0,
              width: 320,
              height: 320,
            },
            {
              id: INPUT_NODE_ID_B,
              type: "file",
              file: INPUT_IMAGE_PATH_B,
              x: 0,
              y: 360,
              width: 320,
              height: 320,
            },
            {
              id: PROMPT_NODE_ID,
              type: "file",
              file: PROMPT_PATH,
              x: 420,
              y: 0,
              width: 640,
              height: 720,
            },
          ],
          edges: [
            {
              id: "mock-edge-input-a-to-prompt",
              fromNode: INPUT_NODE_ID_A,
              toNode: PROMPT_NODE_ID,
            },
            {
              id: "mock-edge-input-b-to-prompt",
              fromNode: INPUT_NODE_ID_B,
              toNode: PROMPT_NODE_ID,
            },
          ],
        },
        null,
        2
      )
    );
  });

  it("runs CanvasFlow runner and writes generated image node + sidecar", async function () {
    this.timeout(120000);

    await runCanvasFlowPromptToCompletion({
      pluginId: PLUGIN_ID,
      canvasPath: CANVAS_PATH,
      promptNodeId: PROMPT_NODE_ID,
    });

    await browser.waitUntil(
      async () => {
        const artifacts = await readGeneratedArtifacts();
        if (artifacts) return true;
        return false;
      },
      {
        timeout: 15000,
        interval: 1000,
        timeoutMsg: "CanvasFlow mock run completed but generated artifacts were not found in time.",
      }
    );

    const result = await readGeneratedArtifacts();
    if (!result) {
      throw new Error("Generated artifacts missing after successful wait.");
    }

    const stats = await readMockServerStats(serverUrl);

    expect(result.imagePath).toContain(`${OUTPUT_PREFIX}/`);
    expect(result.sidecarPath).toContain(".systemsculpt.json");
    expect(result.sidecarInputImages).toContain(INPUT_IMAGE_PATH_A);
    expect(result.sidecarInputImages).toContain(INPUT_IMAGE_PATH_B);
    expect(result.sidecarInputImages.length).toBe(2);
    expect(result.nodeCount).toBeGreaterThanOrEqual(3);
    expect(Number(stats.imageJobLastInputImagesCount || 0)).toBe(2);
  });
});
