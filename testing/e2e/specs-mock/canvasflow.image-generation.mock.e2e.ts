import fs from "node:fs";
import path from "node:path";
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

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = getEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const INPUT_IMAGE_PATH = getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_INPUT_IMAGE_PATH") ?? "E2E/systemsculpt-logo-input.png";
const PROMPT_PATH = getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_PROMPT_PATH") ?? "E2E/canvasflow-logo-tshirt-prompt.md";
const CANVAS_PATH = getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_CANVAS_PATH") ?? "E2E/canvasflow-logo-tshirt.canvas";
const OUTPUT_PREFIX = getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_OUTPUT_PREFIX") ?? "SystemSculpt/Attachments/Generations/E2E/Generations";
const INPUT_NODE_ID = getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_INPUT_NODE_ID") ?? "e2e-canvasflow-logo-input-node";
const PROMPT_NODE_ID = getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_PROMPT_NODE_ID") ?? "e2e-canvasflow-logo-prompt-node";
const IMAGE_MODEL_ID = getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_IMAGE_MODEL_ID") ?? "google/nano-banana-pro";
const IMAGE_COUNT = getPositiveIntEnv("SYSTEMSCULPT_E2E_CANVASFLOW_IMAGE_COUNT", 2);
const IMAGE_ASPECT_RATIO = getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_IMAGE_ASPECT_RATIO") ?? "9:16";
const PROMPT_TEXT =
  getEnv("SYSTEMSCULPT_E2E_CANVASFLOW_PROMPT_TEXT") ?? "Put this logo on a t-shirt on a professional female model.";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9slt4d8AAAAASUVORK5CYII=";

function loadSystemSculptLogoBase64(): string {
  const candidates = [
    path.resolve(process.cwd(), "../systemsculpt-website/public/images/brand/logo-256.png"),
    path.resolve(process.cwd(), "../systemsculpt-website/public/images/brand/logo-512.png"),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate).toString("base64");
      }
    } catch {}
  }

  return TINY_PNG_BASE64;
}

const SYSTEMSCULPT_LOGO_BASE64 = loadSystemSculptLogoBase64();

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
    }
  }, { pluginId });
}

async function openCanvasFile(pathInVault: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, filePath) => {
    const normalized = String(filePath).replace(/\\/g, "/");
    const file = app.vault.getAbstractFileByPath(normalized);
    if (!file) throw new Error(`File not found: ${normalized}`);
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(file as any);
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, pathInVault);

  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(({ app }) => {
        return (app.workspace as any)?.activeLeaf?.view?.getViewType?.() === "canvas";
      }),
    { timeout: 20000, timeoutMsg: "Active leaf did not switch to Canvas view." }
  );
}

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
  generatedPaths: string[];
  sidecarPaths: string[];
  nodeCount: number;
} | null> {
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
      const generatedNodes = nodes.filter((node: any) => {
        if (!node || typeof node !== "object") return false;
        if (node.id === inputNodeId || node.id === promptNodeId) return false;
        const filePath = typeof node.file === "string" ? node.file : "";
        if (!filePath.startsWith(outputPrefix)) return false;
        return /\.(png|jpg|jpeg|webp)$/i.test(filePath);
      });

      if (!generatedNodes.length) {
        return null;
      }

      const generatedPaths = generatedNodes
        .map((node: any) => String(node.file || ""))
        .filter((p: string) => p.length > 0);

      const sidecarPaths = generatedPaths
        .map((p: string) => `${p}.systemsculpt.json`)
        .filter((p: string) => !!app.vault.getAbstractFileByPath(p));

      return {
        generatedPaths,
        sidecarPaths,
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

describe("CanvasFlow image generation (mock API) - logo to t-shirt workflow", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const mockPort = getEnv("SYSTEMSCULPT_E2E_MOCK_PORT") ?? "43111";
  const serverUrl = `http://127.0.0.1:${mockPort}/api/v1`;
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  before(async () => {
    const vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await ensureCorePluginEnabled("canvas");

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
      modelId: IMAGE_MODEL_ID,
      saveMetadataSidecar: true,
    });

    await writeBinaryImage(INPUT_IMAGE_PATH, SYSTEMSCULPT_LOGO_BASE64);
    await upsertVaultFile(
      PROMPT_PATH,
      [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: openrouter",
        `ss_image_model: ${IMAGE_MODEL_ID}`,
        `ss_image_count: ${IMAGE_COUNT}`,
        `ss_image_aspect_ratio: ${IMAGE_ASPECT_RATIO}`,
        "---",
        PROMPT_TEXT,
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
              x: -440,
              y: 80,
              width: 360,
              height: 360,
            },
            {
              id: PROMPT_NODE_ID,
              type: "file",
              file: PROMPT_PATH,
              x: 0,
              y: 0,
              width: 700,
              height: 780,
            },
          ],
          edges: [
            {
              id: "mock-edge-logo-to-prompt",
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

  it("runs the logo -> prompt workflow and writes at least two generated outputs", async function () {
    this.timeout(180000);

    await openCanvasFile(CANVAS_PATH);
    await browser.pause(1200);

    await runCanvasFlowPromptToCompletion({
      pluginId: PLUGIN_ID,
      canvasPath: CANVAS_PATH,
      promptNodeId: PROMPT_NODE_ID,
      timeoutMs: 120000,
      pollIntervalMs: 750,
    });

    await browser.waitUntil(
      async () => {
        const artifacts = await readGeneratedArtifacts();
        return !!artifacts && artifacts.generatedPaths.length >= IMAGE_COUNT;
      },
      {
        timeout: 20000,
        interval: 1000,
        timeoutMsg: "CanvasFlow mock run completed but expected generated output nodes were not found in time.",
      }
    );

    const result = await readGeneratedArtifacts();
    if (!result) {
      throw new Error("Generated artifacts missing after successful wait.");
    }

    const stats = await readMockServerStats(serverUrl);

    expect(result.generatedPaths.length).toBeGreaterThanOrEqual(IMAGE_COUNT);
    expect(result.sidecarPaths.length).toBeGreaterThanOrEqual(1);
    expect(result.nodeCount).toBeGreaterThanOrEqual(2 + IMAGE_COUNT);
    expect(Number(stats.imageJobLastInputImagesCount || 0)).toBe(1);
    expect(String(stats.imageJobLastModel || "")).toBe(IMAGE_MODEL_ID);
  });
});
