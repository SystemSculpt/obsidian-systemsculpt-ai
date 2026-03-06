import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePluginEnabled, getActiveVaultBasePath } from "../utils/obsidian";
import { openSystemSculptSettingsTab } from "../utils/systemsculptSettings";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  PLUGIN_ID,
  requireEnv,
} from "../utils/systemsculptChat";

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

describe("Desktop fresh-install bootstrap (mock)", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL") ?? "http://127.0.0.1:43111/api/v1";
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  let vaultPath: string;
  let pluginInstallDir: string;
  let piEntryPath: string;
  let nodePtyRoot: string;
  let hadBundledPiBeforeBootstrap = false;
  let hadNodePtyBeforeBootstrap = false;

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    const activeVaultPath = await getActiveVaultBasePath();
    pluginInstallDir = path.join(activeVaultPath || vaultPath, ".obsidian", "plugins", PLUGIN_ID);
    piEntryPath = path.join(
      pluginInstallDir,
      "node_modules",
      "@mariozechner",
      "pi-coding-agent",
      "dist",
      "index.js"
    );
    nodePtyRoot = path.join(pluginInstallDir, "node_modules", "node-pty");
    hadBundledPiBeforeBootstrap = await pathExists(piEntryPath);
    hadNodePtyBeforeBootstrap = await pathExists(nodePtyRoot);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      skipModelWarmup: true,
      settingsOverride: {
        mcpEnabled: true,
      },
    });
  });

  it("bootstraps the bundled Pi runtime when a fresh desktop install opens setup", async function () {
    this.timeout(180000);

    expect(hadBundledPiBeforeBootstrap).toBe(false);

    await openSystemSculptSettingsTab("overview");

    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const panel = document.querySelector(
            '.systemsculpt-tab-content.is-active[data-tab="overview"]'
          ) as HTMLElement | null;
          if (!panel) {
            return false;
          }

          const panelText = panel.textContent || "";
          const providerRows = panel.querySelectorAll(".ss-setup-pi-auth-list .setting-item").length;
          const hasRawBootstrapError = panelText.includes(
            "Unable to resolve the SystemSculpt plugin installation directory"
          );
          const hasUnavailableBanner = panelText.includes("Pi auth is unavailable right now");

          return providerRows > 0 && !hasRawBootstrapError && !hasUnavailableBanner;
        }),
      {
        timeout: 120000,
        interval: 500,
        timeoutMsg: "Setup did not finish loading Pi provider rows for a fresh desktop install.",
      }
    );

    await browser.waitUntil(
      async () => await pathExists(piEntryPath),
      {
        timeout: 120000,
        interval: 500,
        timeoutMsg: "Bundled Pi runtime was not installed into the plugin directory.",
      }
    );
  });

  it("bootstraps node-pty from release assets when terminal sessions start on desktop", async function () {
    this.timeout(180000);

    expect(hadNodePtyBeforeBootstrap).toBe(false);

    const runId = crypto.randomUUID().slice(0, 8);
    const result = await browser.executeObsidian(async ({ app }, { runId }) => {
      const plugin: any = (app as any).plugins?.getPlugin?.("systemsculpt-ai");
      if (!plugin) {
        throw new Error("SystemSculpt plugin is not loaded.");
      }

      const studio = plugin.getStudioService();
      const project = await studio.createProject({
        name: `Fresh Install Terminal Bootstrap ${runId}`,
      });
      const projectPath = studio.getCurrentProjectPath();
      if (!projectPath) {
        throw new Error("Studio project path was not available after project creation.");
      }

      const terminalNodeId = `terminal_${runId}`;
      const hasTerminalNode = project.graph.nodes.some((node: any) => node?.kind === "studio.terminal");
      if (!hasTerminalNode) {
        project.graph.nodes.push({
          id: terminalNodeId,
          kind: "studio.terminal",
          version: "1.0.0",
          title: "Terminal",
          position: { x: 760, y: 160 },
          config: {
            cwd: "",
            shellProfile: "auto",
            scrollback: 4000,
            width: 640,
            height: 420,
          },
          continueOnError: false,
          disabled: false,
        });
        await studio.saveProject(projectPath, project);
      }

      await plugin.getViewManager().activateSystemSculptStudioView(projectPath);
      const snapshot = await studio.ensureTerminalSession({
        projectPath,
        nodeId: hasTerminalNode
          ? String(project.graph.nodes.find((node: any) => node?.kind === "studio.terminal")?.id || terminalNodeId)
          : terminalNodeId,
        cwd: "",
        shellProfile: "auto",
      });

      if (snapshot.status === "running") {
        await studio.stopTerminalSession({
          projectPath,
          nodeId: snapshot.nodeId,
        });
      }

      return {
        status: snapshot.status,
        errorMessage: snapshot.errorMessage,
        platform: process.platform,
      };
    }, { runId });

    await browser.waitUntil(
      async () => await pathExists(path.join(nodePtyRoot, "package.json")),
      {
        timeout: 120000,
        interval: 500,
        timeoutMsg: "node-pty runtime was not installed into the plugin directory.",
      }
    );

    if (result.platform === "darwin" || result.platform === "win32") {
      expect(result.status).toBe("running");
      return;
    }

    if (result.platform === "linux") {
      expect(result.status).toBe("failed");
      expect(String(result.errorMessage || "")).toContain("Linux desktop builds");
      return;
    }

    expect(["running", "failed"]).toContain(result.status);
  });
});
