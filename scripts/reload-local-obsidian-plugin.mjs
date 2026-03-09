#!/usr/bin/env node
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const playwright = require("playwright");

function parseArgs(argv) {
  const options = {
    pluginId: String(process.env.SYSTEMSCULPT_OBSIDIAN_PLUGIN_ID || "systemsculpt-ai").trim() || "systemsculpt-ai",
    port: Number(process.env.SYSTEMSCULPT_OBSIDIAN_DEBUG_PORT || process.env.OBSIDIAN_REMOTE_DEBUG_PORT || 9222),
    quietUnavailable: false,
    quietSuccess: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plugin-id") {
      options.pluginId = String(argv[i + 1] || "").trim() || options.pluginId;
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.port = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--quiet-unavailable") {
      options.quietUnavailable = true;
      continue;
    }
    if (arg === "--quiet-success") {
      options.quietSuccess = true;
    }
  }

  return options;
}

async function fetchDebuggerMetadata(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`debug endpoint returned ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function findObsidianPage(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  return pages.find((page) => page.url().startsWith("app://obsidian.md/index.html")) || pages[0] || null;
}

async function closeStaleModelSelectionModal(page) {
  const hasOpenModelSelector = await page.evaluate(() => {
    const modalRoots = Array.from(document.querySelectorAll(".modal, .ss-modal, .modal-container"));
    return modalRoots.some((root) => {
      const text = String(root.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) {
        return false;
      }
      return text.includes("select ai model") && text.includes("choose a pi model");
    });
  });

  if (!hasOpenModelSelector) {
    return;
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150);
}

async function reloadPlugin(page, pluginId) {
  return await page.evaluate(async ({ pluginId: targetPluginId }) => {
    const plugins = globalThis.app?.plugins;
    if (!plugins) {
      return { ok: false, reason: "plugins service unavailable" };
    }

    const before = plugins.plugins?.[targetPluginId] || null;
    const beforeVersion = before?.manifest?.version ?? null;

    if (before) {
      await plugins.disablePlugin(targetPluginId);
      await plugins.enablePlugin(targetPluginId);
    } else {
      await plugins.enablePlugin(targetPluginId);
    }

    const after = plugins.plugins?.[targetPluginId] || null;
    return {
      ok: !!after,
      reason: after ? null : "plugin unavailable after reload",
      beforeVersion,
      afterVersion: after?.manifest?.version ?? null,
    };
  }, { pluginId });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let browser = null;
  try {
    const debuggerMetadata = await fetchDebuggerMetadata(options.port);
    const debuggerUrl = String(debuggerMetadata?.webSocketDebuggerUrl || "").trim();
    if (!debuggerUrl) {
      if (!options.quietUnavailable) {
        console.log(`[reload] Skipped: no debuggable Obsidian found on port ${options.port}`);
      }
      process.exit(0);
    }

    browser = await playwright.chromium.connectOverCDP(debuggerUrl);
    const page = await findObsidianPage(browser);
    if (!page) {
      if (!options.quietUnavailable) {
        console.log(`[reload] Skipped: no Obsidian renderer page found on port ${options.port}`);
      }
      process.exit(0);
    }

    await closeStaleModelSelectionModal(page);
    const result = await reloadPlugin(page, options.pluginId);
    if (!result.ok) {
      throw new Error(result.reason || "unknown reload failure");
    }

    if (!options.quietSuccess) {
      console.log(
        `[reload] Reloaded ${options.pluginId} in Obsidian on port ${options.port}` +
          (result.afterVersion ? ` (v${result.afterVersion})` : "")
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    if (options.quietUnavailable && /fetch failed|connect ECONNREFUSED|aborted|debuggable Obsidian|renderer page/i.test(message)) {
      process.exit(0);
    }
    console.error(`[reload] Failed to reload Obsidian plugin: ${message}`);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

await main();
