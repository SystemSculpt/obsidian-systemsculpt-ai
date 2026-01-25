import fs from "node:fs/promises";
import path from "node:path";

const enabledVaults = new Set<string>();

export async function ensurePluginEnabled(pluginId: string, vaultPath: string) {
  if (enabledVaults.has(vaultPath)) {
    return;
  }
  const targetDir = path.join(vaultPath, ".obsidian", "plugins", pluginId);
  await fs.mkdir(targetDir, { recursive: true });

  const root = process.cwd();
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

  // Attempt to enable the plugin inside Obsidian
  await browser.executeObsidian(
    async ({ app }, id) => {
      const pluginsApi: any = (app as any).plugins;
      await pluginsApi?.enablePluginAndSave?.(id);
    },
    pluginId
  );
  enabledVaults.add(vaultPath);
}

export async function runCommand(command: string) {
  await browser.executeObsidianCommand(command);
}
