import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const enabledVaults = new Set<string>();

function getRepoRoot(): string {
  // This file lives at `testing/e2e/utils/obsidian.ts`.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..", "..");
}

async function getActiveVaultBasePath(): Promise<string> {
  const basePath = await browser.executeObsidian(({ app }) => {
    const adapter: any = (app as any)?.vault?.adapter;
    const candidate =
      typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : adapter?.basePath;
    return typeof candidate === "string" ? candidate : "";
  });
  return String(basePath || "").trim();
}

export async function ensurePluginEnabled(pluginId: string, vaultPath: string) {
  // NOTE: WDIO Obsidian Service opens a *copy* of the requested vault. The `vaultPath`
  // passed in from helpers is a template path, not necessarily the active vault on disk.
  // Always resolve the base path from the running Obsidian instance.
  const activeVaultPath = await getActiveVaultBasePath();
  const cacheKey = `${activeVaultPath || vaultPath}::${pluginId}`;
  if (enabledVaults.has(cacheKey)) return;

  const targetVault = activeVaultPath || vaultPath;
  const targetDir = path.join(targetVault, ".obsidian", "plugins", pluginId);
  await fs.mkdir(targetDir, { recursive: true });

  const root = getRepoRoot();
  const filesToCopy = ["manifest.json", "main.js", "styles.css"];
  for (const file of filesToCopy) {
    const src = path.join(root, file);
    const dest = path.join(targetDir, file);
    try {
      await fs.copyFile(src, dest);
    } catch (_) {
      // ignore missing optional files (e.g., styles.css during early dev)
    }
  }

  // Ensure Obsidian sees the plugin manifest, then enable it.
  await browser.executeObsidian(async ({ app }, id) => {
    const pluginsApi: any = (app as any).plugins;
    if (!pluginsApi) throw new Error("Obsidian plugins API unavailable");

    try {
      if (typeof pluginsApi.loadManifests === "function") {
        await pluginsApi.loadManifests();
      }
      if (typeof pluginsApi.loadPlugins === "function") {
        await pluginsApi.loadPlugins();
      }
    } catch (_) {
      // best-effort: some versions don't expose these helpers
    }

    if (typeof pluginsApi.enablePluginAndSave === "function") {
      await pluginsApi.enablePluginAndSave(id);
      return;
    }
    if (typeof pluginsApi.enablePlugin === "function") {
      await pluginsApi.enablePlugin(id);
      return;
    }

    throw new Error("No plugin enable function available on Obsidian plugins API");
  }, pluginId);

  // Enabling is async inside Obsidian; wait until the plugin instance is actually loaded.
  try {
    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }, id) => {
          const pluginsApi: any = (app as any).plugins;
          return !!pluginsApi?.getPlugin?.(id);
        }, pluginId),
      {
        timeout: 60000,
        interval: 500,
        timeoutMsg: `Timed out waiting for plugin to load after enabling: ${pluginId}`,
      }
    );
  } catch (error) {
    const debug = await browser.executeObsidian(({ app }, id) => {
      const pluginsApi: any = (app as any).plugins;
      const adapter: any = (app as any)?.vault?.adapter;
      const basePath =
        typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : adapter?.basePath;

      const manifests =
        pluginsApi?.manifests && typeof pluginsApi.manifests === "object" ? pluginsApi.manifests : {};
      const hasManifest = !!(manifests as any)?.[id];

      const enabled = pluginsApi?.enabledPlugins;
      const enabledList = enabled
        ? Array.isArray(enabled)
          ? enabled
          : typeof (enabled as any)?.values === "function"
            ? Array.from((enabled as any).values())
            : typeof enabled === "object"
              ? Object.keys(enabled as any)
              : []
        : [];

      const loadedPlugins =
        pluginsApi?.plugins && typeof pluginsApi.plugins === "object" ? pluginsApi.plugins : {};
      const loadedPluginIds = Object.keys(loadedPlugins as any);

      return {
        vaultBasePath: typeof basePath === "string" ? basePath : null,
        hasManifest,
        enabledPluginIds: enabledList,
        loadedPluginIds,
        pluginsApiKeys: pluginsApi ? Object.keys(pluginsApi).slice(0, 50) : [],
      };
    }, pluginId);

    throw new Error(
      `Timed out waiting for plugin to load after enabling: ${pluginId}. Debug: ${JSON.stringify(debug)}`
    );
  }

  enabledVaults.add(cacheKey);
}

export async function runCommand(command: string) {
  await browser.executeObsidianCommand(command);
}

