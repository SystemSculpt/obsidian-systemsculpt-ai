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

type CanvasFlowWorkflowDefaults = {
  promptText: string;
  imageModelId: string;
  imageCount: number;
  imageAspectRatio: string;
  inputImagePath: string;
  promptPath: string;
  canvasPath: string;
  outputPrefix: string;
  inputNodeId: string;
  promptNodeId: string;
};

type RecipeOp = {
  id: string;
  action:
    | "vault.write_logo_image"
    | "vault.write_prompt_markdown"
    | "canvas.write_connected_prompt_canvas"
    | "canvas.viewport.set"
    | "canvas.viewport.fit_nodes"
    | "ui.open_canvas"
    | "canvasflow.run_prompt"
    | "assert.generated_outputs_min"
    | "assert.mock_image_job"
    | "ui.pause_ms";
  args?: Record<string, unknown>;
};

type LoopRecipe = {
  recipeId: string;
  scenario: "canvasflow_image_generation";
  workflow: Partial<CanvasFlowWorkflowDefaults>;
  ops: RecipeOp[];
};

type TimelineEvent = {
  type: "op_start" | "op_end" | "op_error";
  opId: string;
  action: string;
  timeMs: number;
  timeSecondsFromCaptureStart: number | null;
  message?: string;
};

const DEFAULT_WORKFLOW: CanvasFlowWorkflowDefaults = {
  promptText: "Put this logo on a t-shirt on a professional female model.",
  imageModelId: "google/nano-banana-pro",
  imageCount: 2,
  imageAspectRatio: "9:16",
  inputImagePath: "E2E/systemsculpt-logo-input.png",
  promptPath: "E2E/canvasflow-logo-tshirt-prompt.md",
  canvasPath: "E2E/canvasflow-logo-tshirt.canvas",
  outputPrefix: "SystemSculpt/Attachments/Generations/E2E/Generations",
  inputNodeId: "e2e-canvasflow-logo-input-node",
  promptNodeId: "e2e-canvasflow-logo-prompt-node",
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9slt4d8AAAAASUVORK5CYII=";

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function asString(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : fallback;
}

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
    } catch {
      // fall through
    }
  }

  return TINY_PNG_BASE64;
}

function loadRecipeFromEnv(): LoopRecipe {
  const recipePath = requireEnv("SYSTEMSCULPT_E2E_LOOP_RECIPE_PATH");
  const absolutePath = path.isAbsolute(recipePath) ? recipePath : path.resolve(process.cwd(), recipePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<LoopRecipe>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Loop recipe must be a JSON object.");
  }
  if (typeof parsed.recipeId !== "string" || parsed.recipeId.trim().length === 0) {
    throw new Error("Loop recipe missing required string field: recipeId");
  }
  if (parsed.scenario !== "canvasflow_image_generation") {
    throw new Error(`Unsupported recipe scenario: ${String(parsed.scenario ?? "")}`);
  }
  if (!Array.isArray(parsed.ops) || parsed.ops.length === 0) {
    throw new Error("Loop recipe requires a non-empty ops array.");
  }

  const ops: RecipeOp[] = parsed.ops.map((op, index) => {
    if (!op || typeof op !== "object") {
      throw new Error(`ops[${index}] must be an object`);
    }
    const id = String((op as any).id ?? "").trim();
    const action = String((op as any).action ?? "").trim() as RecipeOp["action"];
    if (!id) throw new Error(`ops[${index}] missing id`);
    if (!action) throw new Error(`ops[${index}] missing action`);
    return {
      id,
      action,
      args: typeof (op as any).args === "object" && (op as any).args != null ? (op as any).args : {},
    };
  });

  return {
    recipeId: parsed.recipeId,
    scenario: "canvasflow_image_generation",
    workflow: parsed.workflow && typeof parsed.workflow === "object" ? parsed.workflow : {},
    ops,
  };
}

const recipe = loadRecipeFromEnv();
const workflow: CanvasFlowWorkflowDefaults = {
  ...DEFAULT_WORKFLOW,
  ...(recipe.workflow || {}),
};

const TIMELINE_PATH = getEnv("SYSTEMSCULPT_E2E_LOOP_TIMELINE_PATH");
const CAPTURE_START_EPOCH_MS = toNumber(getEnv("SYSTEMSCULPT_LOOP_CAPTURE_START_EPOCH_MS"), NaN);
const TIMELINE_EVENTS: TimelineEvent[] = [];
const SYSTEMSCULPT_LOGO_BASE64 = loadSystemSculptLogoBase64();

function timelineTimeSecondsFromCaptureStart(timeMs: number): number | null {
  if (!Number.isFinite(CAPTURE_START_EPOCH_MS) || CAPTURE_START_EPOCH_MS <= 0) {
    return null;
  }
  return Number(((timeMs - CAPTURE_START_EPOCH_MS) / 1000).toFixed(4));
}

function pushTimelineEvent(event: Omit<TimelineEvent, "timeMs" | "timeSecondsFromCaptureStart">): void {
  const timeMs = Date.now();
  TIMELINE_EVENTS.push({
    ...event,
    timeMs,
    timeSecondsFromCaptureStart: timelineTimeSecondsFromCaptureStart(timeMs),
  });
}

function flushTimeline(status: "passed" | "failed"): void {
  if (!TIMELINE_PATH) return;
  const absolutePath = path.isAbsolute(TIMELINE_PATH) ? TIMELINE_PATH : path.resolve(process.cwd(), TIMELINE_PATH);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    JSON.stringify(
      {
        recipeId: recipe.recipeId,
        scenario: recipe.scenario,
        status,
        captureStartEpochMs: Number.isFinite(CAPTURE_START_EPOCH_MS) ? CAPTURE_START_EPOCH_MS : null,
        events: TIMELINE_EVENTS,
      },
      null,
      2,
    ),
    "utf8",
  );
}

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
    async () => await browser.executeObsidian(({ app }) => (app.workspace as any)?.activeLeaf?.view?.getViewType?.() === "canvas"),
    { timeout: 20000, timeoutMsg: "Active leaf did not switch to Canvas view." }
  );
}

type CanvasViewportSetOptions = {
  canvasPath: string;
  x: number;
  y: number;
  zoom: number;
  reopenCanvas: boolean;
};

async function setCanvasViewport(options: CanvasViewportSetOptions): Promise<void> {
  const zoom = Math.max(0.05, Math.min(4, options.zoom));

  await browser.executeObsidian(
    async ({ app }, args) => {
      const file = app.vault.getAbstractFileByPath(args.canvasPath);
      if (!file) throw new Error(`Canvas file not found: ${args.canvasPath}`);

      let raw = "";
      try {
        raw = await app.vault.read(file as any);
      } catch (error: any) {
        throw new Error(`Failed reading canvas file: ${String(error?.message || error || "unknown")}`);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (error: any) {
        throw new Error(`Failed parsing canvas JSON: ${String(error?.message || error || "unknown")}`);
      }

      if (!parsed || typeof parsed !== "object") {
        throw new Error("Canvas JSON root is not an object.");
      }

      const priorViewport =
        parsed.viewport && typeof parsed.viewport === "object" && !Array.isArray(parsed.viewport)
          ? parsed.viewport
          : {};

      parsed.viewport = {
        ...priorViewport,
        x: args.x,
        y: args.y,
        zoom: args.zoom,
      };

      await app.vault.modify(file as any, JSON.stringify(parsed, null, 2));
    },
    {
      canvasPath: options.canvasPath,
      x: options.x,
      y: options.y,
      zoom,
    },
  );

  if (options.reopenCanvas) {
    await openCanvasFile(options.canvasPath);
  }
}

type FitCanvasViewportOptions = {
  canvasPath: string;
  nodeIds?: string[];
  paddingLeftPx: number;
  paddingRightPx: number;
  paddingTopPx: number;
  paddingBottomPx: number;
  extraRightPx: number;
  viewportWidthPx?: number;
  viewportHeightPx?: number;
  zoomMultiplier: number;
  minZoom: number;
  maxZoom: number;
  reopenCanvas: boolean;
};

type CanvasViewportPixels = {
  width: number;
  height: number;
};

async function detectCanvasViewportPixels(canvasPath: string): Promise<CanvasViewportPixels | null> {
  const pixels = await browser.executeObsidian(
    async ({ app }, args) => {
      const minDim = 200;
      const targetPath = String(args.canvasPath || "").trim();

      const pickFromRoot = (root: any): { width: number; height: number } | null => {
        if (!root || typeof root.querySelector !== "function") return null;
        const selectors = [".canvas-wrapper", ".canvas-node-container", ".canvas"];
        for (const selector of selectors) {
          const el = root.querySelector(selector) as HTMLElement | null;
          if (!el || typeof el.getBoundingClientRect !== "function") continue;
          const rect = el.getBoundingClientRect();
          const width = Number(rect.width);
          const height = Number(rect.height);
          if (Number.isFinite(width) && Number.isFinite(height) && width >= minDim && height >= minDim) {
            return {
              width: Math.floor(width),
              height: Math.floor(height),
            };
          }
        }
        return null;
      };

      const leaves = Array.isArray((app.workspace as any).getLeavesOfType?.("canvas"))
        ? (app.workspace as any).getLeavesOfType("canvas")
        : [];

      let targetLeaf: any = null;
      if (targetPath.length > 0) {
        targetLeaf =
          leaves.find((leaf: any) => String(leaf?.view?.file?.path || "").trim() === targetPath) ?? null;
      }
      if (!targetLeaf) {
        targetLeaf = (app.workspace as any).activeLeaf ?? leaves[0] ?? null;
      }

      const roots: any[] = [targetLeaf?.view?.containerEl];
      if (typeof document !== "undefined") {
        roots.push(document.querySelector(".workspace-leaf.mod-active"));
        roots.push(document.body);
      }

      for (const root of roots) {
        const match = pickFromRoot(root);
        if (match) return match;
      }

      return null;
    },
    { canvasPath },
  );

  if (!pixels || typeof pixels !== "object") return null;
  const width = Number((pixels as any).width);
  const height = Number((pixels as any).height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200) {
    return null;
  }
  return {
    width: Math.floor(width),
    height: Math.floor(height),
  };
}

async function fitCanvasViewportToNodes(options: FitCanvasViewportOptions): Promise<void> {
  const zoomMultiplier = Math.max(0.05, Math.min(2, options.zoomMultiplier));
  const minZoom = Math.max(0.05, Math.min(4, options.minZoom));
  const maxZoom = Math.max(minZoom, Math.min(4, options.maxZoom));
  let viewportWidthPx =
    Number.isFinite(options.viewportWidthPx) && Number(options.viewportWidthPx) > 0
      ? Math.max(320, Number(options.viewportWidthPx))
      : Number.NaN;
  let viewportHeightPx =
    Number.isFinite(options.viewportHeightPx) && Number(options.viewportHeightPx) > 0
      ? Math.max(240, Number(options.viewportHeightPx))
      : Number.NaN;

  if (!Number.isFinite(viewportWidthPx) || !Number.isFinite(viewportHeightPx)) {
    const detected = await detectCanvasViewportPixels(options.canvasPath);
    if (detected) {
      if (!Number.isFinite(viewportWidthPx)) {
        viewportWidthPx = Math.max(320, detected.width);
      }
      if (!Number.isFinite(viewportHeightPx)) {
        viewportHeightPx = Math.max(240, detected.height);
      }
    }
  }

  if (!Number.isFinite(viewportWidthPx)) {
    viewportWidthPx = 960;
  }
  if (!Number.isFinite(viewportHeightPx)) {
    viewportHeightPx = 600;
  }

  const result = await browser.executeObsidian(
    async ({ app }, args) => {
      const file = app.vault.getAbstractFileByPath(args.canvasPath);
      if (!file) throw new Error(`Canvas file not found: ${args.canvasPath}`);

      const raw = await app.vault.read(file as any);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Canvas JSON root is not an object.");
      }

      const nodes = Array.isArray((parsed as any).nodes) ? (parsed as any).nodes : [];
      const requestedNodeIds = Array.isArray(args.nodeIds)
        ? args.nodeIds.map((id: unknown) => String(id || "").trim()).filter(Boolean)
        : [];
      const requestedSet = requestedNodeIds.length > 0 ? new Set(requestedNodeIds) : null;

      const targetNodes = nodes.filter((node: any) => {
        if (!node || typeof node !== "object") return false;
        if (requestedSet && !requestedSet.has(String(node.id || "").trim())) return false;
        return true;
      });

      if (targetNodes.length === 0) {
        throw new Error(
          requestedSet
            ? `No canvas nodes matched requested nodeIds (${requestedNodeIds.join(", ")}).`
            : "Canvas has no nodes to fit viewport to.",
        );
      }

      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;

      for (const node of targetNodes) {
        const x = Number.isFinite(node?.x) ? Number(node.x) : 0;
        const y = Number.isFinite(node?.y) ? Number(node.y) : 0;
        const width = Number.isFinite(node?.width) && Number(node.width) > 0 ? Number(node.width) : 320;
        const height = Number.isFinite(node?.height) && Number(node.height) > 0 ? Number(node.height) : 240;

        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + width);
        bottom = Math.max(bottom, y + height);
      }

      if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
        throw new Error("Computed non-finite node bounds while fitting viewport.");
      }

      const paddedLeft = left - args.paddingLeftPx;
      const paddedTop = top - args.paddingTopPx;
      const paddedRight = right + args.paddingRightPx + args.extraRightPx;
      const paddedBottom = bottom + args.paddingBottomPx;

      const width = Math.max(1, paddedRight - paddedLeft);
      const height = Math.max(1, paddedBottom - paddedTop);

      const zoomX = args.viewportWidthPx / width;
      const zoomY = args.viewportHeightPx / height;
      let zoom = Math.min(zoomX, zoomY, args.maxZoom);
      if (!Number.isFinite(zoom) || zoom <= 0) {
        zoom = args.maxZoom;
      }
      zoom *= args.zoomMultiplier;
      if (!Number.isFinite(zoom) || zoom <= 0) {
        zoom = args.maxZoom;
      }
      zoom = Math.min(zoom, args.maxZoom);
      zoom = Math.max(args.minZoom, zoom);

      const centerX = paddedLeft + width / 2;
      const centerY = paddedTop + height / 2;

      const priorViewport =
        (parsed as any).viewport && typeof (parsed as any).viewport === "object" && !Array.isArray((parsed as any).viewport)
          ? (parsed as any).viewport
          : {};

      (parsed as any).viewport = {
        ...priorViewport,
        x: centerX,
        y: centerY,
        zoom,
      };

      await app.vault.modify(file as any, JSON.stringify(parsed, null, 2));

      return { centerX, centerY, zoom, nodeCount: targetNodes.length, width, height };
    },
    {
      canvasPath: options.canvasPath,
      nodeIds: options.nodeIds ?? [],
      paddingLeftPx: options.paddingLeftPx,
      paddingRightPx: options.paddingRightPx,
      paddingTopPx: options.paddingTopPx,
      paddingBottomPx: options.paddingBottomPx,
      extraRightPx: options.extraRightPx,
      viewportWidthPx,
      viewportHeightPx,
      zoomMultiplier,
      minZoom,
      maxZoom,
    },
  );

  if (!result || typeof result !== "object") {
    throw new Error("Viewport fit operation did not return fit metadata.");
  }

  if (options.reopenCanvas) {
    await openCanvasFile(options.canvasPath);
  }
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
      canvasPath: workflow.canvasPath,
      outputPrefix: workflow.outputPrefix,
      inputNodeId: workflow.inputNodeId,
      promptNodeId: workflow.promptNodeId,
    }
  );
}

async function executeOp(op: RecipeOp, serverUrl: string): Promise<void> {
  const args = op.args || {};

  switch (op.action) {
    case "vault.write_logo_image": {
      const imagePath = asString(args.path, workflow.inputImagePath);
      await writeBinaryImage(imagePath, SYSTEMSCULPT_LOGO_BASE64);
      return;
    }

    case "vault.write_prompt_markdown": {
      const promptPath = asString(args.path, workflow.promptPath);
      const promptText = asString(args.promptText, workflow.promptText);
      const imageModelId = asString(args.imageModelId, workflow.imageModelId);
      const imageCount = Math.max(1, Math.floor(toNumber(args.imageCount, workflow.imageCount)));
      const imageAspectRatio = asString(args.imageAspectRatio, workflow.imageAspectRatio);

      await upsertVaultFile(
        promptPath,
        [
          "---",
          "ss_flow_kind: prompt",
          "ss_flow_backend: openrouter",
          `ss_image_model: ${imageModelId}`,
          `ss_image_count: ${imageCount}`,
          `ss_image_aspect_ratio: ${imageAspectRatio}`,
          "---",
          promptText,
          "",
        ].join("\n"),
      );
      return;
    }

    case "canvas.write_connected_prompt_canvas": {
      const canvasPath = asString(args.canvasPath, workflow.canvasPath);
      const promptPath = asString(args.promptPath, workflow.promptPath);
      const inputImagePath = asString(args.inputImagePath, workflow.inputImagePath);
      const inputNodeId = asString(args.inputNodeId, workflow.inputNodeId);
      const promptNodeId = asString(args.promptNodeId, workflow.promptNodeId);
      const inputX = toNumber(args.inputX, -440);
      const inputY = toNumber(args.inputY, 80);
      const inputWidth = toNumber(args.inputWidth, 360);
      const inputHeight = toNumber(args.inputHeight, 360);
      const promptX = toNumber(args.promptX, 0);
      const promptY = toNumber(args.promptY, 0);
      const promptWidth = toNumber(args.promptWidth, 700);
      const promptHeight = toNumber(args.promptHeight, 780);

      await upsertVaultFile(
        canvasPath,
        JSON.stringify(
          {
            nodes: [
              {
                id: inputNodeId,
                type: "file",
                file: inputImagePath,
                x: inputX,
                y: inputY,
                width: inputWidth,
                height: inputHeight,
              },
              {
                id: promptNodeId,
                type: "file",
                file: promptPath,
                x: promptX,
                y: promptY,
                width: promptWidth,
                height: promptHeight,
              },
            ],
            viewport: {
              x: 210,
              y: 390,
              zoom: 0.78,
            },
            edges: [
              {
                id: `${inputNodeId}-to-${promptNodeId}`,
                fromNode: inputNodeId,
                toNode: promptNodeId,
              },
            ],
          },
          null,
          2,
        ),
      );
      return;
    }

    case "canvas.viewport.set": {
      const canvasPath = asString(args.canvasPath, workflow.canvasPath);
      const x = toNumber(args.x, 0);
      const y = toNumber(args.y, 0);
      const zoom = Math.max(0.05, Math.min(4, toNumber(args.zoom, 0.7)));
      const reopenCanvas = Boolean(args.reopenCanvas ?? true);

      await setCanvasViewport({
        canvasPath,
        x,
        y,
        zoom,
        reopenCanvas,
      });
      return;
    }

    case "canvas.viewport.fit_nodes": {
      const canvasPath = asString(args.canvasPath, workflow.canvasPath);
      const nodeIds = Array.isArray(args.nodeIds)
        ? args.nodeIds.map((id) => String(id ?? "").trim()).filter(Boolean)
        : undefined;
      const paddingPx = Math.max(0, toNumber(args.paddingPx, 140));
      const paddingLeftPx = Math.max(0, toNumber(args.paddingLeftPx, paddingPx));
      const paddingRightPx = Math.max(0, toNumber(args.paddingRightPx, paddingPx));
      const paddingTopPx = Math.max(0, toNumber(args.paddingTopPx, paddingPx));
      const paddingBottomPx = Math.max(0, toNumber(args.paddingBottomPx, paddingPx));
      const extraRightPx = Math.max(0, toNumber(args.extraRightPx, 0));
      const viewportWidthPx =
        args.viewportWidthPx == null ? undefined : Math.max(320, Math.floor(toNumber(args.viewportWidthPx, 960)));
      const viewportHeightPx =
        args.viewportHeightPx == null ? undefined : Math.max(240, Math.floor(toNumber(args.viewportHeightPx, 600)));
      const zoomMultiplier = Math.max(0.05, Math.min(2, toNumber(args.zoomMultiplier, 1)));
      const minZoom = Math.max(0.05, Math.min(4, toNumber(args.minZoom, 0.2)));
      const maxZoom = Math.max(minZoom, Math.min(4, toNumber(args.maxZoom, 1)));
      const reopenCanvas = Boolean(args.reopenCanvas ?? true);

      await fitCanvasViewportToNodes({
        canvasPath,
        nodeIds,
        paddingLeftPx,
        paddingRightPx,
        paddingTopPx,
        paddingBottomPx,
        extraRightPx,
        viewportWidthPx,
        viewportHeightPx,
        zoomMultiplier,
        minZoom,
        maxZoom,
        reopenCanvas,
      });
      return;
    }

    case "ui.open_canvas": {
      const canvasPath = asString(args.canvasPath, workflow.canvasPath);
      await openCanvasFile(canvasPath);
      return;
    }

    case "canvasflow.run_prompt": {
      const promptNodeId = asString(args.promptNodeId, workflow.promptNodeId);
      const canvasPath = asString(args.canvasPath, workflow.canvasPath);
      const timeoutMs = Math.max(10_000, Math.floor(toNumber(args.timeoutMs, 120_000)));
      const pollIntervalMs = Math.max(250, Math.floor(toNumber(args.pollIntervalMs, 750)));

      await runCanvasFlowPromptToCompletion({
        pluginId: PLUGIN_ID,
        canvasPath,
        promptNodeId,
        timeoutMs,
        pollIntervalMs,
      });
      return;
    }

    case "assert.generated_outputs_min": {
      const minCount = Math.max(1, Math.floor(toNumber(args.minCount, workflow.imageCount)));
      const timeoutMs = Math.max(5000, Math.floor(toNumber(args.timeoutMs, 20_000)));
      const pollIntervalMs = Math.max(250, Math.floor(toNumber(args.pollIntervalMs, 1000)));

      await browser.waitUntil(
        async () => {
          const artifacts = await readGeneratedArtifacts();
          return !!artifacts && artifacts.generatedPaths.length >= minCount;
        },
        {
          timeout: timeoutMs,
          interval: pollIntervalMs,
          timeoutMsg: `Expected at least ${minCount} generated output image(s).`,
        },
      );

      const artifacts = await readGeneratedArtifacts();
      if (!artifacts) {
        throw new Error("Generated artifacts missing after output assertion wait.");
      }
      expect(artifacts.generatedPaths.length).toBeGreaterThanOrEqual(minCount);
      return;
    }

    case "assert.mock_image_job": {
      const expectedModelId = asString(args.imageModelId, workflow.imageModelId);
      const expectedInputImagesCount = Math.max(0, Math.floor(toNumber(args.inputImagesCount, 1)));
      const stats = await readMockServerStats(serverUrl);

      expect(String(stats.imageJobLastModel || "")).toBe(expectedModelId);
      expect(Number(stats.imageJobLastInputImagesCount || 0)).toBe(expectedInputImagesCount);
      return;
    }

    case "ui.pause_ms": {
      const ms = Math.max(0, Math.floor(toNumber(args.ms, 0)));
      if (ms > 0) {
        await browser.pause(ms);
      }
      return;
    }

    default:
      throw new Error(`Unsupported operation action: ${op.action}`);
  }
}

describe("CanvasFlow loop recipe runner (mock API)", () => {
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
      outputDir: workflow.outputPrefix,
      pollIntervalMs: 400,
      modelId: workflow.imageModelId,
      saveMetadataSidecar: true,
    });
  });

  it("runs recipe operations deterministically", async function () {
    this.timeout(300000);

    for (const op of recipe.ops) {
      pushTimelineEvent({ type: "op_start", opId: op.id, action: op.action });
      try {
        await executeOp(op, serverUrl);
        pushTimelineEvent({ type: "op_end", opId: op.id, action: op.action });
      } catch (error: any) {
        const message = String(error?.message || error || "unknown error");
        pushTimelineEvent({ type: "op_error", opId: op.id, action: op.action, message });
        flushTimeline("failed");
        throw new Error(`Operation failed (id=${op.id}, action=${op.action}): ${message}`);
      }
    }

    flushTimeline("passed");
  });
});
