export async function writeBinaryImage(pathInVault: string, base64: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, { filePath, base64 }) => {
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
    },
    { filePath: pathInVault, base64 }
  );
}

export async function configureCanvasFlowPluginForE2E(options: {
  pluginId: string;
  licenseKey: string;
  serverUrl?: string | null;
  selectedModelId?: string | null;
}): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, args) => {
      const plugin: any = (app as any)?.plugins?.getPlugin?.(args.pluginId);
      if (!plugin) throw new Error(`Plugin not loaded: ${args.pluginId}`);
      const waitForSettingsManager = async (): Promise<any | null> => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 15000) {
          const manager = plugin.settingsManager;
          if (manager && typeof manager.updateSettings === "function") {
            return manager;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      };
      const updates: Record<string, unknown> = {
        licenseKey: args.licenseKey,
        licenseValid: true,
      };
      if (args.serverUrl) {
        updates.serverUrl = args.serverUrl;
      }
      if (args.selectedModelId) {
        updates.selectedModelId = args.selectedModelId;
      }

      const settingsManager = await waitForSettingsManager();
      if (settingsManager && typeof settingsManager.updateSettings === "function") {
        await settingsManager.updateSettings.call(settingsManager, updates);
        return;
      }

      const currentSettings =
        (plugin as any)?._internal_settings_systemsculpt_plugin && typeof (plugin as any)._internal_settings_systemsculpt_plugin === "object"
          ? (plugin as any)._internal_settings_systemsculpt_plugin
          : plugin.settings && typeof plugin.settings === "object"
            ? plugin.settings
            : {};
      (plugin as any)._internal_settings_systemsculpt_plugin = {
        ...currentSettings,
        ...updates,
      };
    },
    {
      pluginId: options.pluginId,
      licenseKey: options.licenseKey,
      serverUrl: options.serverUrl ?? null,
      selectedModelId: options.selectedModelId ?? null,
    }
  );
}

export async function configureCanvasFlowImageDefaults(options: {
  pluginId: string;
  outputDir: string;
  pollIntervalMs: number;
  modelId?: string;
  saveMetadataSidecar?: boolean;
}): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, args) => {
      const plugin: any = (app as any)?.plugins?.getPlugin?.(args.pluginId);
      if (!plugin) throw new Error(`Plugin not loaded: ${args.pluginId}`);
      const waitForSettingsManager = async (): Promise<any | null> => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 15000) {
          const manager = plugin.settingsManager;
          if (manager && typeof manager.updateSettings === "function") {
            return manager;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      };
      const updates: Record<string, unknown> = {
        canvasFlowEnabled: true,
        imageGenerationDefaultModelId: args.modelId || "openai/gpt-5-image-mini",
        imageGenerationOutputDir: args.outputDir,
        imageGenerationPollIntervalMs: args.pollIntervalMs,
        imageGenerationSaveMetadataSidecar: args.saveMetadataSidecar !== false,
      };

      const settingsManager = await waitForSettingsManager();
      if (settingsManager && typeof settingsManager.updateSettings === "function") {
        await settingsManager.updateSettings.call(settingsManager, updates);
      } else {
        const currentSettings =
          (plugin as any)?._internal_settings_systemsculpt_plugin &&
          typeof (plugin as any)._internal_settings_systemsculpt_plugin === "object"
            ? (plugin as any)._internal_settings_systemsculpt_plugin
            : plugin.settings && typeof plugin.settings === "object"
              ? plugin.settings
              : {};
        (plugin as any)._internal_settings_systemsculpt_plugin = {
          ...currentSettings,
          ...updates,
        };
      }

      if (typeof plugin.syncCanvasFlowEnhancerFromSettings === "function") {
        await plugin.syncCanvasFlowEnhancerFromSettings();
      }
    },
    {
      pluginId: options.pluginId,
      outputDir: options.outputDir,
      pollIntervalMs: options.pollIntervalMs,
      modelId: options.modelId || "openai/gpt-5-image-mini",
      saveMetadataSidecar: options.saveMetadataSidecar !== false,
    }
  );
}

export type CanvasFlowPromptRunState = {
  status: string;
  error: string | null;
  lastStatus: string;
};

export async function startCanvasFlowPromptRun(options: {
  pluginId: string;
  canvasPath: string;
  promptNodeId: string;
}): Promise<string> {
  return await browser.executeObsidian(
    ({ app }, args) => {
      const plugin: any = (app as any)?.plugins?.getPlugin?.(args.pluginId);
      if (!plugin) throw new Error(`Plugin missing: ${args.pluginId}`);

      const canvasFile = app.vault.getAbstractFileByPath(args.canvasPath);
      if (!canvasFile) throw new Error(`Canvas file not found: ${args.canvasPath}`);

      const store: Record<string, CanvasFlowPromptRunState> =
        ((app as any).__ssCanvasflowRuns = (app as any).__ssCanvasflowRuns || {});
      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      store[runId] = { status: "running", error: null, lastStatus: "" };

      const runViaPlugin = async (): Promise<void> => {
        if (typeof plugin.runCanvasFlowPromptNode === "function") {
          await plugin.runCanvasFlowPromptNode({
            canvasFile,
            promptNodeId: args.promptNodeId,
            status: (status: string) => {
              store[runId].lastStatus = String(status || "");
            },
          });
          return;
        }

        const enhancer: any = plugin.canvasFlowEnhancer;
        const runner: any = enhancer?.runner;
        if (!runner || typeof runner.runPromptNode !== "function") {
          const debug = {
            hasRunCanvasFlowPromptNode: typeof plugin.runCanvasFlowPromptNode === "function",
            hasEnhancer: !!enhancer,
            hasRunner: !!runner,
            canvasFlowEnabled: plugin?.settings?.canvasFlowEnabled === true,
            pluginKeys: Object.keys(plugin || {}).slice(0, 40),
          };
          throw new Error(`CanvasFlow runner unavailable: ${JSON.stringify(debug)}`);
        }

        await runner.runPromptNode({
          canvasFile,
          promptNodeId: args.promptNodeId,
          status: (status: string) => {
            store[runId].lastStatus = String(status || "");
          },
        });
      };

      void runViaPlugin()
        .then(() => {
          store[runId].status = "done";
        })
        .catch((error: any) => {
          store[runId].status = "error";
          store[runId].error = String(error?.message || error || "unknown error");
        });

      return runId;
    },
    {
      pluginId: options.pluginId,
      canvasPath: options.canvasPath,
      promptNodeId: options.promptNodeId,
    }
  );
}

export async function readCanvasFlowPromptRunState(runId: string): Promise<CanvasFlowPromptRunState | null> {
  return await browser.executeObsidian(({ app }, id) => {
    const store = (app as any)?.__ssCanvasflowRuns;
    if (!store || typeof store !== "object") return null;
    const state = (store as any)[id];
    if (!state || typeof state !== "object") return null;
    return {
      status: String((state as any).status || ""),
      error: (state as any).error ? String((state as any).error) : null,
      lastStatus: String((state as any).lastStatus || ""),
    };
  }, runId);
}

export async function runCanvasFlowPromptToCompletion(options: {
  pluginId: string;
  canvasPath: string;
  promptNodeId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const timeoutMs = Math.max(10_000, Math.floor(options.timeoutMs ?? 8 * 60_000));
  const pollIntervalMs = Math.max(250, Math.floor(options.pollIntervalMs ?? 750));
  const runId = await startCanvasFlowPromptRun({
    pluginId: options.pluginId,
    canvasPath: options.canvasPath,
    promptNodeId: options.promptNodeId,
  });

  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt <= timeoutMs) {
    const state = await readCanvasFlowPromptRunState(runId);
    if (!state) {
      throw new Error(`CanvasFlow run state disappeared: ${runId}`);
    }

    if (state.lastStatus) {
      lastStatus = state.lastStatus;
    }
    if (state.status === "done") {
      return;
    }
    if (state.status === "error") {
      const message = state.error?.trim() || "CanvasFlow prompt run failed.";
      throw new Error(lastStatus ? `${message} (last_status=${lastStatus})` : message);
    }

    await browser.pause(pollIntervalMs);
  }

  const suffix = lastStatus ? ` Last status: ${lastStatus}` : "";
  throw new Error(`CanvasFlow prompt run timed out after ${Math.ceil(timeoutMs / 1000)}s.${suffix}`);
}
