import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChainablePromiseElement } from "webdriverio";

type WebdriverElement = ChainablePromiseElement;

export const PLUGIN_ID = "systemsculpt-ai";

let lastValidatedKey: string | null = null;
let cachedLiveSettingsSeed: Record<string, unknown> | null = null;

const SETTINGS_SEED_BLOCKLIST = new Set([
  "licenseKey",
  "licenseValid",
  "selectedModelId",
  "vaultInstanceId",
  "lastValidated",
  "verifiedDirectories",
  "systemPrompt",
  "systemPromptType",
  "systemPromptPath",
  "postProcessingPrompt",
  "postProcessingPromptType",
  "postProcessingPromptFilePath",
  "titleGenerationPrompt",
  "titleGenerationPromptType",
  "titleGenerationPromptPath",
  "mcpServers",
  "mcpEnabledTools",
  "mcpAutoAcceptTools",
  "mcpEnabled",
  "mcpAutoAccept",
]);

function looksAbsolutePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("/") || value.startsWith("~")) return true;
  if (value.startsWith("\\\\")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

function isVaultSpecificSetting(key: string, value: unknown): boolean {
  if (SETTINGS_SEED_BLOCKLIST.has(key)) return true;
  const isPathLike = key.endsWith("Directory") || key.endsWith("Path") || key.toLowerCase().includes("folder");
  if (isPathLike && typeof value === "string") {
    return looksAbsolutePath(value.trim());
  }
  if (isPathLike) return true;
  return false;
}

function scrubLiveSettingsSeed(seed: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(seed)) {
    if (isVaultSpecificSetting(key, value)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

async function loadLiveSettingsSeed(): Promise<Record<string, unknown>> {
  if (cachedLiveSettingsSeed) return cachedLiveSettingsSeed;

  const explicitSettingsPath = getEnv("SYSTEMSCULPT_E2E_SETTINGS_JSON");
  const vaultRoot = getEnv("SYSTEMSCULPT_E2E_VAULT");
  if (!explicitSettingsPath && !vaultRoot) {
    cachedLiveSettingsSeed = {};
    return cachedLiveSettingsSeed;
  }

  const settingsPath = path.resolve(
    explicitSettingsPath || path.join(vaultRoot!, ".obsidian", "plugins", PLUGIN_ID, "data.json")
  );

  try {
    await fs.access(settingsPath);
  } catch (_) {
    cachedLiveSettingsSeed = {};
    return cachedLiveSettingsSeed;
  }

  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    cachedLiveSettingsSeed = scrubLiveSettingsSeed(parsed && typeof parsed === "object" ? parsed : {});
    return cachedLiveSettingsSeed;
  } catch (error) {
    cachedLiveSettingsSeed = {};
    return cachedLiveSettingsSeed;
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

export function getEnv(name: string): string | null {
  const value = process.env[name];
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function getE2EVaultDisplayName(): string {
  const raw = getEnv("SYSTEMSCULPT_E2E_VAULT_NAME") ?? "SystemSculpt Studio";
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : "SystemSculpt Studio";
}

function getE2EWindowMode(): "none" | "capture" | "background" {
  const mode = String(process.env.SYSTEMSCULPT_E2E_WINDOW_MODE || "")
    .trim()
    .toLowerCase();
  if (mode === "capture" || mode === "background") return mode;
  return "none";
}

async function seedBelievableVaultContent(vaultPath: string): Promise<void> {
  const seedFiles: Array<{ filePath: string; content: string }> = [
    {
      filePath: "Home.md",
      content: [
        "# Home",
        "",
        "- Current focus: ship product demos and improve conversion.",
        "- This vault is used for realistic SystemSculpt workflow testing.",
      ].join("\n"),
    },
    {
      filePath: "Projects/Revenue Sprint/Email Campaign Plan.md",
      content: [
        "# Email Campaign Plan",
        "",
        "- Goal: improve click-through without sounding promotional.",
        "- Demo asset needed: short workflow GIF inside Obsidian.",
      ].join("\n"),
    },
    {
      filePath: "Projects/Revenue Sprint/Feature Brief.md",
      content: [
        "# Feature Brief",
        "",
        "- Turn scattered notes into action-ready output.",
        "- Keep everything inside one workspace.",
      ].join("\n"),
    },
    {
      filePath: "Projects/Revenue Sprint/Customer Notes.md",
      content: [
        "# Customer Notes",
        "",
        "- Pain: context switching across apps.",
        "- Pain: hard to turn notes into final copy quickly.",
      ].join("\n"),
    },
    {
      filePath: "Areas/Marketing/Newsletter Ideas.md",
      content: [
        "# Newsletter Ideas",
        "",
        "- Show one concrete workflow per send.",
        "- End with one clear CTA.",
      ].join("\n"),
    },
    {
      filePath: "Reference/SystemSculpt/Quick Wins.md",
      content: [
        "# Quick Wins",
        "",
        "- Use @-mention to add relevant context.",
        "- Export polished output directly from chat.",
      ].join("\n"),
    },
    {
      filePath: "Journal/2026-02-12.md",
      content: [
        "# 2026-02-12",
        "",
        "- Build a realistic GIF showcase flow for monetization email.",
      ].join("\n"),
    },
  ];

  for (const seed of seedFiles) {
    const absolutePath = path.join(vaultPath, seed.filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await fs.access(absolutePath);
      continue;
    } catch (_) {}
    await fs.writeFile(absolutePath, `${seed.content.trim()}\n`);
  }
}

export async function configurePluginForLiveChat(params: {
  licenseKey: string;
  serverUrl?: string | null;
  selectedModelId: string;
  fallbackModelId?: string;
  settingsOverride?: Record<string, unknown>;
  settingsSeed?: Record<string, unknown>;
}): Promise<void> {
  const validationKey = `${params.licenseKey}::${params.serverUrl ?? ""}`;
  const shouldValidate = lastValidatedKey !== validationKey;
  const fallbackModelId = params.fallbackModelId ?? "systemsculpt@@systemsculpt/ai-agent";
  const settingsSeed = params.settingsSeed ?? await loadLiveSettingsSeed();
  const settingsOverride = params.settingsOverride ?? {};

  const attemptConfigure = async (selectedModelId: string) => {
    await browser.executeObsidian(
      async (
        { app },
        { pluginId, licenseKey, serverUrl, selectedModelId, settingsOverride, settingsSeed, shouldValidate }
      ) => {
        const pluginsApi: any = (app as any).plugins;
        const plugin = pluginsApi?.getPlugin?.(pluginId);
        if (!plugin) {
          throw new Error(`Plugin not loaded: ${pluginId}`);
        }

        const nextSettings: Record<string, unknown> = {
          ...(settingsSeed ?? {}),
          ...settingsOverride,
          licenseKey,
          selectedModelId,
          ...(serverUrl ? { serverUrl } : {})
        };
        if (shouldValidate) {
          // Force a real validation roundtrip for the provided key instead of relying on
          // any previously persisted `licenseValid` state.
          nextSettings.licenseValid = false;
        }

        await plugin.getSettingsManager().updateSettings(nextSettings);

        if (shouldValidate) {
          const valid = await plugin.aiService.validateLicense(true);
          if (!valid) {
            throw new Error("License validation failed (licenseValid=false).");
          }
        }

        let models: any[] = [];
        try {
          models = await plugin.modelService.getModels();
        } catch (_) {}
        if (!models || models.length === 0) {
          throw new Error("No models available after preload.");
        }

        try {
          await plugin.modelService.validateSelectedModel(models);
        } catch (_) {}
      },
      {
        pluginId: PLUGIN_ID,
        licenseKey: params.licenseKey,
        serverUrl: params.serverUrl ?? null,
        selectedModelId,
        settingsOverride,
        settingsSeed,
        shouldValidate,
      }
    );
  };

  try {
    await attemptConfigure(params.selectedModelId);
  } catch (error: any) {
    const message = String(error?.message || error);
    if (params.selectedModelId !== fallbackModelId) {
      try {
        await attemptConfigure(fallbackModelId);
        return;
      } catch (fallbackError: any) {
        const fallbackMessage = String(fallbackError?.message || fallbackError);
        throw new Error(
          `Failed to configure selected model (${message}). Fallback model (${fallbackModelId}) also failed: ${fallbackMessage}`
        );
      }
    }
    throw error;
  }

  if (shouldValidate) {
    lastValidatedKey = validationKey;
  }
}

let cachedVaultPath: string | null = null;

export async function ensureE2EVault(): Promise<string> {
  if (cachedVaultPath) return cachedVaultPath;

  const templateVaultPath = path.resolve(process.cwd(), "testing/e2e/fixtures/vault");
  const tmpRoot = path.resolve(process.cwd(), "testing/e2e/fixtures/.tmp-vaults");
  await fs.mkdir(tmpRoot, { recursive: true });

  const runDir = path.join(tmpRoot, `run-${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const vaultPath = path.join(runDir, getE2EVaultDisplayName());
  await fs.mkdir(runDir, { recursive: true });
  await fs.cp(templateVaultPath, vaultPath, { recursive: true });
  await seedBelievableVaultContent(vaultPath);

  // Avoid leaking secrets/stale state between runs by starting from a clean plugin data.json.
  try {
    await fs.rm(path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID, "data.json"), { force: true });
  } catch (_) {}

  await browser.reloadObsidian({ vault: vaultPath });
  await tryBackgroundObsidianWindow();
  cachedVaultPath = vaultPath;
  return vaultPath;
}

export async function readLatestBenchmarkRun(vaultPath: string): Promise<any> {
  const adapterRunsPath = ".systemsculpt/benchmarks/v2/runs";
  try {
    const result = await browser.executeObsidian(
      async ({ app }, { runsPath }) => {
        const adapter: any = app?.vault?.adapter as any;
        if (!adapter || typeof adapter.list !== "function" || typeof adapter.read !== "function") {
          throw new Error("Vault adapter unavailable");
        }
        let listing;
        try {
          listing = await adapter.list(runsPath);
        } catch {
          throw new Error(`Benchmark runs folder missing: ${runsPath}`);
        }
        const folders: string[] = Array.isArray(listing?.folders) ? listing.folders : [];
        if (!folders.length) {
          throw new Error("No benchmark runs found.");
        }
        const runDirs = folders
          .map((folder) => folder.split("/").pop())
          .filter(Boolean)
          .sort()
          .reverse();
        const runPath = `${runsPath}/${runDirs[0]}/run.json`;
        const raw = await adapter.read(runPath);
        return { raw };
      },
      { runsPath: adapterRunsPath }
    );
    return JSON.parse(result.raw);
  } catch (_) {
    const runsPath = path.join(vaultPath, ".systemsculpt", "benchmarks", "v2", "runs");
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      entries = await fs.readdir(runsPath, { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
      }>;
    } catch (error) {
      throw new Error(`Benchmark runs folder missing: ${runsPath}`);
    }

    const runDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    if (runDirs.length === 0) {
      throw new Error("No benchmark runs found.");
    }

    const runPath = path.join(runsPath, runDirs[0], "run.json");
    const raw = await fs.readFile(runPath, "utf8");
    return JSON.parse(raw);
  }
}

export async function exportBenchmarkFailureArtifacts(runId: string, caseIds: string[]): Promise<string> {
  const outputDir = path.join(process.cwd(), "testing", "e2e", "logs");
  await fs.mkdir(outputDir, { recursive: true });
  const payload = await browser.executeObsidian(
    async ({ app }, { runId, caseIds }) => {
      const adapter: any = app?.vault?.adapter as any;
      if (!adapter || typeof adapter.read !== "function") {
        return { error: "Vault adapter unavailable", runId, caseIds };
      }
      const artifacts: Record<string, any> = {};
      for (const caseId of caseIds || []) {
        const basePath = `.systemsculpt/benchmarks/v2/runs/${runId}/cases/${caseId}`;
        const readJson = async (relativePath: string) => {
          try {
            const raw = await adapter.read(relativePath);
            return JSON.parse(raw);
          } catch {
            return null;
          }
        };
        const result = await readJson(`${basePath}/result.json`);
        const transcript = await readJson(`${basePath}/transcript.json`);
        artifacts[caseId] = { result, transcript };
      }
      return { runId, artifacts };
    },
    { runId, caseIds }
  );
  const outputPath = path.join(outputDir, `bench-failures-${runId}.json`);
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2));
  return outputPath;
}

export async function openFreshChatView(): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const plugin = (app as any)?.plugins?.getPlugin?.(pluginId);
    const selectedModelId = plugin?.settings?.selectedModelId || "";
    const leaf = app.workspace.getLeaf("tab");

    const existingLeaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
    for (const existing of existingLeaves) {
      if (existing?.view) {
        (existing.view as any).__systemsculptE2EActive = false;
      }
    }

    await leaf.setViewState({
      type: "systemsculpt-chat-view",
      state: {
        chatId: "",
        selectedModelId
      }
    });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    if ((leaf as any)?.view) {
      ((leaf as any).view as any).__systemsculptE2EActive = true;
    }
  }, { pluginId: PLUGIN_ID });
}

export async function tryBackgroundObsidianWindow(): Promise<void> {
  const windowMode = getE2EWindowMode();
  if (windowMode === "none") return;

  try {
    await browser.execute((mode: "capture" | "background") => {
      try {
        const remote = (window as any)?.electron?.remote;
        const win = remote?.getCurrentWindow?.();
        if (!win) return;

        if (mode === "capture") {
          if (typeof win.isMinimized === "function" && win.isMinimized() && typeof win.restore === "function") {
            win.restore();
          }
          if (typeof win.setSkipTaskbar === "function") win.setSkipTaskbar(false);
          if (typeof win.setFocusable === "function") win.setFocusable(true);
          if (typeof win.setVisibleOnAllWorkspaces === "function") {
            win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
          }
          if (typeof win.setAlwaysOnTop === "function") {
            try {
              win.setAlwaysOnTop(true, "floating", 1);
            } catch (_) {
              win.setAlwaysOnTop(true);
            }
          }

          const screen = remote?.screen;
          const display = screen?.getPrimaryDisplay?.();
          const workArea = display?.workArea;
          if (workArea && typeof win.setBounds === "function") {
            const targetWidth = Math.max(980, Math.min(1600, Math.floor(workArea.width * 0.78)));
            const targetHeight = Math.max(720, Math.min(1280, Math.floor(workArea.height * 0.86)));
            const targetX = Math.floor(workArea.x + (workArea.width - targetWidth) / 2);
            const targetY = Math.floor(workArea.y + Math.max(24, (workArea.height - targetHeight) / 2));
            win.setBounds({ x: targetX, y: targetY, width: targetWidth, height: targetHeight }, false);
          }

          if (typeof win.moveTop === "function") win.moveTop();
          if (typeof win.show === "function") win.show();
          if (typeof win.focus === "function") win.focus();
          return;
        }

        if (typeof win.setSkipTaskbar === "function") win.setSkipTaskbar(true);
        if (typeof win.setFocusable === "function") win.setFocusable(false);
        if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(false);
        if (typeof win.setVisibleOnAllWorkspaces === "function") {
          win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
        if (typeof win.setPosition === "function") win.setPosition(-10000, -10000, false);
        if (typeof win.blur === "function") win.blur();

        const app = remote?.app;
        if (app?.dock && typeof app.dock.hide === "function") {
          app.dock.hide();
        }
      } catch (_) {}
    }, windowMode);
  } catch (_) {}
}

export async function upsertVaultFile(filePath: string, content: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, { filePath, content, pluginId }) => {
      const normalized = String(filePath).replace(/\\/g, "/");
      const lastSlash = normalized.lastIndexOf("/");
      if (lastSlash > 0) {
        const folderPath = normalized.slice(0, lastSlash);
        try {
          // @ts-ignore
          await app.vault.createFolder(folderPath);
        } catch (_) {}
      }

      const existing = app.vault.getAbstractFileByPath(normalized);
      // @ts-ignore
      if (existing && typeof app.vault.modify === "function") {
        // @ts-ignore
        await app.vault.modify(existing, content);
        if (normalized.toLowerCase().endsWith(".md")) {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            const files = app.vault.getMarkdownFiles();
            if (files.some((f: any) => f?.path === normalized)) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        return;
      }
      // @ts-ignore
      await app.vault.create(normalized, content);

      const waitForPath = async (getFiles: () => any[] | null | undefined) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const files = getFiles() ?? [];
          if (files.some((f: any) => f?.path === normalized)) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };

      // Ensure Obsidian has indexed the file into the markdown file list before the test proceeds.
      // This avoids flake where embeddings processing runs before the vault cache sees new files.
      if (normalized.toLowerCase().endsWith(".md")) {
        await waitForPath(() => app.vault.getMarkdownFiles());
      }

      // If the plugin maintains a vault file cache (used by @-mention), wait for it too.
      if (pluginId) {
        const plugin = (app as any)?.plugins?.getPlugin?.(pluginId);
        if (plugin?.vaultFileCache?.getAllFiles) {
          await waitForPath(() => plugin.vaultFileCache.getAllFiles());
        }
      }
    },
    { filePath, content, pluginId: PLUGIN_ID }
  );
}

export async function openMarkdownFile(filePath: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, filePath) => {
    const normalized = String(filePath).replace(/\\/g, "/");
    const abstractFile = app.vault.getAbstractFileByPath(normalized);
    if (!abstractFile || typeof (abstractFile as any).extension !== "string") {
      throw new Error(`File not found: ${normalized}`);
    }
    const leaf = app.workspace.getLeaf(true);
    await leaf.openFile(abstractFile as any);
  }, filePath);
}

export async function renameVaultPath(oldPath: string, newPath: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, { oldPath, newPath }) => {
      const from = String(oldPath).replace(/\\/g, "/").replace(/^\/+/, "");
      const to = String(newPath).replace(/\\/g, "/").replace(/^\/+/, "");
      const af = app.vault.getAbstractFileByPath(from);
      if (!af) throw new Error(`Path not found: ${from}`);
      // @ts-ignore
      await app.vault.rename(af, to);
    },
    { oldPath, newPath }
  );
}

export async function deleteVaultPath(path: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, path) => {
      const normalized = String(path).replace(/\\/g, "/").replace(/^\/+/, "");
      const af = app.vault.getAbstractFileByPath(normalized);
      if (!af) return;
      // @ts-ignore
      await app.vault.delete(af, true);
    },
    path
  );
}

export async function ensureVaultFolder(folderPath: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, folderPath) => {
      const normalized = String(folderPath).replace(/\\/g, "/");
      try {
        // @ts-ignore
        await app.vault.createFolder(normalized);
      } catch (_) {}
    },
    folderPath
  );
}

export async function vaultFileExists(filePath: string): Promise<boolean> {
  return await browser.executeObsidian(
    async ({ app }, filePath) => {
      const normalized = String(filePath).replace(/\\/g, "/");
      const existing = app.vault.getAbstractFileByPath(normalized);
      // @ts-ignore
      return !!existing && typeof (existing as any).extension === "string";
    },
    filePath
  );
}

export async function readVaultFile(filePath: string): Promise<string> {
  return await browser.executeObsidian(
    async ({ app }, filePath) => {
      const normalized = String(filePath).replace(/\\/g, "/");
      const existing = app.vault.getAbstractFileByPath(normalized);
      // @ts-ignore
      if (!existing) throw new Error(`File not found: ${normalized}`);
      // @ts-ignore
      return await app.vault.read(existing);
    },
    filePath
  );
}

export async function getActiveChatViewState(): Promise<{
  isGenerating: boolean;
  toolCalls: Array<{ id: string; state: string; name: string }>;
  messages: Array<{ role: string; content: unknown }>;
}> {
  return await browser.executeObsidian(async ({ app }) => {
    const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
    const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
    const activeLeaf: any = app.workspace.activeLeaf as any;
    const leaf =
      markedLeaf ||
      (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
    const view: any = leaf?.view;
    if (!view) throw new Error("No active SystemSculpt chat view found");
    const toolCalls = Array.from(view.toolCallManager?.["toolCalls"]?.values?.() ?? []).map((tc: any) => ({
      id: tc.id,
      state: tc.state,
      name: tc.request?.function?.name ?? "",
    }));
    const messages = Array.isArray(view.messages)
      ? view.messages.map((m: any) => ({ role: m.role, content: m.content }))
      : [];
    return {
      isGenerating: !!view.isGenerating,
      toolCalls,
      messages,
    };
  });
}

export function coerceMessageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const p: any = part;
        if (typeof p.text === "string") return p.text;
        if (typeof p.content === "string") return p.content;
        if (typeof p.value === "string") return p.value;
        return "";
      })
      .join("");
  }

  if (typeof content === "object") {
    const obj: any = content;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    try {
      return JSON.stringify(content);
    } catch (_) {
      return "";
    }
  }

  return String(content);
}

export function summarizeChatViewState(state: Awaited<ReturnType<typeof getActiveChatViewState>>) {
  const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
  const lastAssistantText = coerceMessageContentToText(lastAssistant?.content).trim();
  const lastAssistantPreview = lastAssistantText.slice(0, 500);
  return {
    isGenerating: state.isGenerating,
    messageCount: state.messages.length,
    lastRoles: state.messages.slice(-8).map((m) => m.role),
    toolCalls: state.toolCalls,
    lastAssistantPreview,
  };
}

export async function waitForChatComposer(params?: {
  inputTimeoutMs?: number;
}): Promise<{ input: WebdriverElement; sendButton: WebdriverElement; stopButton: WebdriverElement }> {
  const input = $("textarea.systemsculpt-chat-input");
  await input.waitForExist({ timeout: params?.inputTimeoutMs ?? 20000 });

  const sendButton = $("button.mod-send");
  await sendButton.waitForExist({ timeout: params?.inputTimeoutMs ?? 20000 });

  const stopButton = $("button.mod-stop");
  return { input, sendButton, stopButton };
}

export async function setTextareaValue(el: WebdriverElement, value: string): Promise<void> {
  await (browser as any).execute(
    (input: HTMLTextAreaElement, nextValue: string) => {
      input.value = nextValue;
      // Ensure cursor position reflects the new value so menu detection works.
      input.focus();
      const end = nextValue.length;
      input.selectionStart = end;
      input.selectionEnd = end;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    el as any,
    value
  );
}

export async function sendChatPrompt(params: {
  input: WebdriverElement;
  sendButton: WebdriverElement;
  prompt: string;
}): Promise<void> {
  await setTextareaValue(params.input, params.prompt);
  await params.sendButton.click();
}

export async function sendChatPromptDirect(prompt: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, { prompt }) => {
    const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
    const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
    const activeLeaf: any = app.workspace.activeLeaf as any;
    const leaf =
      markedLeaf ||
      (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
    const view: any = leaf?.view;
    if (!view) throw new Error("No active SystemSculpt chat view found");
    const handler: any = view.inputHandler;
    if (!handler) throw new Error("Chat input handler unavailable");
    const input: HTMLTextAreaElement | undefined = handler.input || handler.inputElement || handler.textarea;
    if (!input) throw new Error("Chat input element unavailable");
    input.value = String(prompt);
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const isReady = () => {
      try {
        const fn = handler.isChatReady ?? handler["isChatReady"];
        return typeof fn === "function" ? Boolean(fn.call(handler)) : true;
      } catch (_) {
        return false;
      }
    };

    if (!isReady()) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (isReady()) break;
      }
    }

    if (!isReady()) {
      throw new Error("Chat did not become ready for sending within timeout.");
    }

    const sendFn = handler.handleSendMessage ?? handler["handleSendMessage"];
    if (typeof sendFn !== "function") {
      throw new Error("Chat send handler not available");
    }
    await sendFn.call(handler);
  }, { prompt });
}

export async function waitForChatIdle(params?: { timeoutMs?: number }): Promise<Awaited<ReturnType<typeof getActiveChatViewState>>> {
  const deadline = Date.now() + (params?.timeoutMs ?? 120000);
  const terminalStates = new Set(["completed", "failed", "denied"]);
  while (Date.now() < deadline) {
    const state = await getActiveChatViewState();
    const hasActiveToolCalls = state.toolCalls.some((tc) => !terminalStates.has(tc.state));
    if (!state.isGenerating && !hasActiveToolCalls) {
      return state;
    }
    await browser.pause(300);
  }
  const state = await getActiveChatViewState();
  throw new Error(`Chat did not become idle within timeout.\nState: ${JSON.stringify(summarizeChatViewState(state), null, 2)}`);
}

export async function approveAllToolCallsDirect(params?: { timeoutMs?: number }): Promise<void> {
  const deadline = Date.now() + (params?.timeoutMs ?? 140000);
  while (Date.now() < deadline) {
    const result = await browser.executeObsidian(({ app }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view: any = leaf?.view;
      const manager: any = view?.toolCallManager;
      if (!view || !manager) {
        return { pending: 0, total: 0, generating: false };
      }
      const calls: any[] = Array.from(manager.toolCalls?.values?.() ?? []);
      const pending = calls.filter((c) => c?.state === "pending");
      for (const call of pending) {
        manager.approveToolCall(call.id);
      }
      const stillPending = calls.filter((c) => c?.state === "pending").length;
      return { pending: stillPending, total: calls.length, generating: !!view.isGenerating };
    });
    if (result.pending === 0 && !result.generating) {
      return;
    }
    await browser.pause(300);
  }
  throw new Error("Timed out approving tool calls.");
}

export async function waitForToolApprovalUi(params?: { timeoutMs?: number; timeoutMsg?: string }): Promise<void> {
  const approvalDeck = await $(".ss-approval-deck");
  const approvalCard = await $(".ss-approval-card");
  try {
    await browser.waitUntil(async () => (await approvalDeck.isExisting()) || (await approvalCard.isExisting()), {
      timeout: params?.timeoutMs ?? 120000,
      timeoutMsg: params?.timeoutMsg ?? "No tool approval UI appeared.",
    });
  } catch (e) {
    try {
      const state = await getActiveChatViewState();
      throw new Error(
        [
          params?.timeoutMsg ?? "No tool approval UI appeared.",
          `State: ${JSON.stringify(summarizeChatViewState(state), null, 2)}`,
          `Original error: ${(e as Error)?.message ?? String(e)}`,
        ].join("\n")
      );
    } catch (_) {
      throw e;
    }
  }
}

export async function driveToolApprovals(params: {
  mode: "approve" | "deny";
  stopButton: WebdriverElement;
  timeoutMs?: number;
}): Promise<void> {
  const terminalStates = new Set(["completed", "failed", "denied"]);
  const deadline = Date.now() + (params.timeoutMs ?? 160000);

  while (Date.now() < deadline) {
    const bulkSelector = params.mode === "approve" ? ".ss-approval-bulk-approve" : ".ss-approval-bulk-deny";
    const cardButtonSelector =
      params.mode === "approve" ? ".ss-approval-card button.ss-button--primary" : ".ss-approval-card button.ss-button--secondary";

    const bulkButton = await $(bulkSelector);
    if (await bulkButton.isExisting()) {
      await bulkButton.click();
      await browser.pause(250);
    } else {
      const firstButton = await $(cardButtonSelector);
      if (await firstButton.isExisting()) {
        await firstButton.click();
        await browser.pause(250);
      }
    }

    const state = await getActiveChatViewState();
    const allTerminal = state.toolCalls.length > 0 && state.toolCalls.every((tc) => terminalStates.has(tc.state));
    const stopVisible = await params.stopButton.isDisplayed();

    if (!stopVisible && allTerminal) {
      return;
    }

    await browser.pause(400);
  }

  const state = await getActiveChatViewState();
  throw new Error(`Tool ${params.mode} loop exceeded timeout.\nState: ${JSON.stringify(summarizeChatViewState(state), null, 2)}`);
}
