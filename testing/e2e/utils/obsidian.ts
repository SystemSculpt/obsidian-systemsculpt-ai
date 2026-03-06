import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const enabledVaults = new Set<string>();
const BASE_RELEASE_FILES = ["manifest.json", "main.js", "studio-terminal-sidecar.cjs"];
const OPTIONAL_RELEASE_FILES = ["styles.css"];
const DEV_RUNTIME_PATHS = ["node_modules/node-pty"];

export type PluginInstallMode = "synced-dev" | "release-assets";

function getRepoRoot(): string {
  // This file lives at `testing/e2e/utils/obsidian.ts`.
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, "..", "..", "..");
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dir = path.dirname(__filename);
  return path.resolve(__dir, "..", "..", "..");
}

export async function getActiveVaultBasePath(): Promise<string> {
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
  const installMode = resolvePluginInstallMode();
  const cacheKey = `${activeVaultPath || vaultPath}::${pluginId}::${installMode}`;
  if (enabledVaults.has(cacheKey)) return;

  const targetVault = activeVaultPath || vaultPath;
  const targetDir = path.join(targetVault, ".obsidian", "plugins", pluginId);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  const root = getRepoRoot();
  for (const file of BASE_RELEASE_FILES) {
    const src = path.join(root, file);
    const dest = path.join(targetDir, file);
    await fs.copyFile(src, dest);
  }

  for (const file of OPTIONAL_RELEASE_FILES) {
    const src = path.join(root, file);
    const dest = path.join(targetDir, file);
    try {
      await fs.copyFile(src, dest);
    } catch (_) {
      // ignore missing optional files (e.g., styles.css during early dev)
    }
  }

  if (installMode === "synced-dev") {
    for (const relativePath of DEV_RUNTIME_PATHS) {
      const src = path.join(root, relativePath);
      const dest = path.join(targetDir, relativePath);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.cp(src, dest, { recursive: true });
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
      // Some Obsidian builds resolve this promise only after plugin startup.
      // Fire-and-poll is more reliable than awaiting directly.
      void pluginsApi.enablePluginAndSave(id);
      return;
    }
    if (typeof pluginsApi.enablePlugin === "function") {
      void pluginsApi.enablePlugin(id);
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

function resolvePluginInstallMode(): PluginInstallMode {
  const normalized = String(process.env.SYSTEMSCULPT_E2E_PLUGIN_INSTALL_MODE || "")
    .trim()
    .toLowerCase();
  if (normalized === "release-assets" || normalized === "fresh-desktop") {
    return "release-assets";
  }
  return "synced-dev";
}

export async function runCommand(command: string) {
  await browser.executeObsidianCommand(command);
}
