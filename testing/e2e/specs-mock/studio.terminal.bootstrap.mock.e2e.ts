import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  PLUGIN_ID,
  requireEnv,
} from "../utils/systemsculptChat";

describe("Studio terminal runtime bootstrap (mock)", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL") ?? "http://127.0.0.1:43111/api/v1";
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
        mcpEnabled: true,
      },
    });
  });

  it("starts terminal sessions on supported desktop targets with explicit fallback messaging otherwise", async function () {
    this.timeout(180000);

    const runId = crypto.randomUUID().slice(0, 8);
    const result = await browser.executeObsidian(async ({ app }, { runId }) => {
      const plugin: any = (app as any).plugins?.getPlugin?.("systemsculpt-ai");
      if (!plugin) {
        throw new Error("SystemSculpt plugin is not loaded.");
      }

      const studio = plugin.getStudioService();
      const project = await studio.createProject({
        name: `Terminal Bootstrap E2E ${runId}`,
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
