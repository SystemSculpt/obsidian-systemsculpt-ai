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

const INPUT_IMAGE_PATH = "E2E/canvasflow-mock-input.png";
const PROMPT_PATH = "E2E/canvasflow-mock-prompt.md";
const CANVAS_PATH = "E2E/canvasflow-mock.canvas";
const OUTPUT_PREFIX = "E2E/Generations";
const PROMPT_NODE_ID = "e2e-canvasflow-mock-prompt-node";
const INPUT_NODE_ID = "e2e-canvasflow-mock-input-node";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9slt4d8AAAAASUVORK5CYII=";

async function writeBinaryImage(path: string, base64: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, { filePath, base64 }) => {
      const normalized = String(filePath || "").replace(/\\/g, "/");
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

      const parts = normalized.split("/").filter(Boolean);
      const fileName = parts.pop();
      if (!fileName) throw new Error("Invalid image path");

      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const exists = await app.vault.adapter.exists(current);
        if (!exists) await app.vault.createFolder(current);
      }

      const existing = app.vault.getAbstractFileByPath(normalized);
      if (existing) {
        await app.vault.modifyBinary(existing as any, bytes.buffer);
      } else {
        await app.vault.createBinary(normalized, bytes.buffer);
      }
    },
    { filePath: path, base64 }
  );
}

async function enableCanvasFlowWithImageDefaults(): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);

    await plugin.getSettingsManager().updateSettings({
      canvasFlowEnabled: true,
      imageGenerationDefaultModelId: "openai/gpt-5-image-mini",
      imageGenerationOutputDir: "E2E/Generations",
      imageGenerationPollIntervalMs: 400,
      imageGenerationSaveMetadataSidecar: true,
    });

    if (typeof plugin.syncCanvasFlowEnhancerFromSettings === "function") {
      await plugin.syncCanvasFlowEnhancerFromSettings();
    }
  }, { pluginId: PLUGIN_ID });
}

describe("CanvasFlow image generation (mock API)", () => {
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

    await enableCanvasFlowWithImageDefaults();

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
              id: INPUT_NODE_ID,
              type: "file",
              file: INPUT_IMAGE_PATH,
              x: 0,
              y: 0,
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
              id: "mock-edge-input-to-prompt",
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

  it("runs CanvasFlow runner and writes generated image node + sidecar", async function () {
    this.timeout(120000);

    const result = await browser.executeObsidian(
      async ({ app }, { pluginId, canvasPath, promptNodeId, outputPrefix }) => {
        const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
        if (!plugin) throw new Error("Plugin missing");

        const canvasFile = app.vault.getAbstractFileByPath(canvasPath);
        if (!canvasFile) throw new Error(`Canvas file not found: ${canvasPath}`);

        const enhancer: any = plugin.canvasFlowEnhancer;
        const runner: any = enhancer?.runner;
        if (!runner || typeof runner.runPromptNode !== "function") {
          throw new Error("CanvasFlow runner unavailable");
        }

        await runner.runPromptNode({
          canvasFile,
          promptNodeId,
        });

        const raw = await app.vault.read(canvasFile as any);
        const parsed = JSON.parse(raw);
        const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
        const generated = nodes.find((node: any) => {
          if (!node || typeof node !== "object") return false;
          const file = typeof node.file === "string" ? node.file : "";
          return file.startsWith(`${outputPrefix}/`) && /\.(png|jpg|jpeg|webp|gif)$/i.test(file);
        });

        if (!generated || typeof generated.file !== "string") {
          throw new Error("Generated image node not found in canvas document.");
        }

        const imagePath = generated.file;
        const imageAbs = app.vault.getAbstractFileByPath(imagePath);
        if (!imageAbs) {
          throw new Error(`Generated image file missing: ${imagePath}`);
        }

        const sidecarPath = `${imagePath}.systemsculpt.json`;
        const sidecarAbs = app.vault.getAbstractFileByPath(sidecarPath);
        if (!sidecarAbs) {
          throw new Error(`Sidecar missing: ${sidecarPath}`);
        }

        return {
          imagePath,
          sidecarPath,
          nodeCount: nodes.length,
        };
      },
      {
        pluginId: PLUGIN_ID,
        canvasPath: CANVAS_PATH,
        promptNodeId: PROMPT_NODE_ID,
        outputPrefix: OUTPUT_PREFIX,
      }
    );

    expect(result.imagePath).toContain(`${OUTPUT_PREFIX}/`);
    expect(result.sidecarPath).toContain(".systemsculpt.json");
    expect(result.nodeCount).toBeGreaterThanOrEqual(3);
  });
});
