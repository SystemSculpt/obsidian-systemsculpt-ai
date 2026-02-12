import { PLUGIN_ID } from "./systemsculptChat";

export type EmbeddingsStats = {
  total: number;
  processed: number;
  present: number;
  needsProcessing: number;
  failed: number;
};

export type EmbeddingsRunResult = {
  status: "complete" | "aborted" | "cooldown";
  processed: number;
  message?: string;
  retryAt?: number;
  partialSuccess?: boolean;
  failure?: { code: string; message: string; status?: number };
};

export type EmbeddingsNamespaceStats = {
  namespace: string;
  provider: string;
  model: string;
  schema: number;
  dimension: number;
  vectors: number;
  files: number;
};

export type EmbeddingsSearchResult = {
  path: string;
  score: number;
  chunkId?: number;
  metadata: {
    title: string;
    excerpt: string;
    lastModified: number;
    sectionTitle?: string;
    lexicalScore?: number;
  };
};

export async function clearEmbeddings(): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const pluginsApi: any = (app as any).plugins;
    const plugin = pluginsApi?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    const manager = plugin.getOrCreateEmbeddingsManager();
    await manager.awaitReady();
    try {
      manager.syncFromSettings?.();
    } catch (_) {}

    // Ensure vault indexing has begun before processing.
    const waitUntil = Date.now() + 5000;
    while (Date.now() < waitUntil) {
      const files = app.vault.getMarkdownFiles();
      if (files.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await manager.clearAll();
  }, { pluginId: PLUGIN_ID });
}

export async function processVaultEmbeddings(params?: { clearFirst?: boolean }): Promise<{
  run: EmbeddingsRunResult;
  stats: EmbeddingsStats;
  namespaces: EmbeddingsNamespaceStats[];
  currentNamespace: { provider: string; model: string; schema: number };
}> {
  return await browser.executeObsidian(async ({ app }, { pluginId, clearFirst }) => {
    const pluginsApi: any = (app as any).plugins;
    const plugin = pluginsApi?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    const manager = plugin.getOrCreateEmbeddingsManager();
    await manager.awaitReady();

    if (clearFirst) {
      await manager.clearAll();
    }

    const run = await manager.processVault();
    try {
      plugin.vaultFileCache?.invalidateCache?.();
    } catch (_) {}
    const stats = manager.getStats();
    const namespaces = await manager.getNamespaceStats();
    const currentNamespace = manager.getCurrentNamespaceDescriptor();

    const runOut: any = { ...run };
    if (runOut.failure?.error?.code) {
      runOut.failure = { code: runOut.failure.error.code, message: runOut.failure.error.message, status: runOut.failure.status };
    } else if (runOut.failure?.code) {
      runOut.failure = { code: runOut.failure.code, message: runOut.failure.message, status: runOut.failure.status };
    }

    return {
      run: runOut,
      stats,
      namespaces,
      currentNamespace,
    };
  }, { pluginId: PLUGIN_ID, clearFirst: params?.clearFirst ?? false });
}

export async function getEmbeddingsStats(): Promise<EmbeddingsStats> {
  return await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const pluginsApi: any = (app as any).plugins;
    const plugin = pluginsApi?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    const manager = plugin.getOrCreateEmbeddingsManager();
    await manager.awaitReady();
    return manager.getStats();
  }, { pluginId: PLUGIN_ID });
}

export async function hasEmbeddingsForPaths(paths: string[]): Promise<Record<string, boolean>> {
  return await browser.executeObsidian(async ({ app }, { pluginId, paths }) => {
    const pluginsApi: any = (app as any).plugins;
    const plugin = pluginsApi?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    const manager = plugin.getOrCreateEmbeddingsManager();
    await manager.awaitReady();
    const out: Record<string, boolean> = {};
    for (const p of paths) {
      out[p] = !!manager.hasVector(p);
    }
    return out;
  }, { pluginId: PLUGIN_ID, paths });
}

export async function findSimilarByFile(filePath: string, limit: number = 15): Promise<EmbeddingsSearchResult[]> {
  return await browser.executeObsidian(async ({ app }, { pluginId, filePath, limit }) => {
    const pluginsApi: any = (app as any).plugins;
    const plugin = pluginsApi?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    const manager = plugin.getOrCreateEmbeddingsManager();
    await manager.awaitReady();
    return await manager.findSimilar(filePath, limit);
  }, { pluginId: PLUGIN_ID, filePath, limit });
}

export async function searchSimilarByText(query: string, limit: number = 20): Promise<EmbeddingsSearchResult[]> {
  return await browser.executeObsidian(async ({ app }, { pluginId, query, limit }) => {
    const pluginsApi: any = (app as any).plugins;
    const plugin = pluginsApi?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    const manager = plugin.getOrCreateEmbeddingsManager();
    await manager.awaitReady();
    return await manager.searchSimilar(query, limit);
  }, { pluginId: PLUGIN_ID, query, limit });
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

export async function openSimilarNotesView(): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const pluginsApi: any = (app as any).plugins;
    const plugin = pluginsApi?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    await plugin.getViewManager().activateEmbeddingsView();
  }, { pluginId: PLUGIN_ID });
}

export async function getSimilarNotesViewState(): Promise<{
  activeLeafViewType: string | null;
  isVisible: boolean;
  currentFilePath: string | null;
  currentChatId: string | null;
  lastSearchContent: string;
  pendingSearch: { type: "file"; path: string } | { type: "chat"; chatId: string } | null;
  currentResultsPaths: string[];
  renderedLinkHrefs: string[];
  totalEmbeddingsViewElements: number;
  documentLinkHrefs: string[];
  leafCount: number;
}> {
  return await browser.executeObsidian(async ({ app }) => {
    const leaves = app.workspace.getLeavesOfType("systemsculpt-embeddings-view");
    const leaf = leaves[0];
    const view: any = leaf?.view;
    if (!view) {
      throw new Error("No Similar Notes view found");
    }

    const activeLeafViewType =
      typeof app.workspace.activeLeaf?.view?.getViewType === "function" ? app.workspace.activeLeaf.view.getViewType() : null;

    let isVisible = true;
    try {
      isVisible = typeof view.isViewVisible === "function" ? !!view.isViewVisible() : true;
    } catch (_) {
      isVisible = true;
    }

    const currentFilePath = typeof view.currentFile?.path === "string" ? view.currentFile.path : null;
    const currentChatId = typeof view.currentChatView?.chatId === "string" ? view.currentChatView.chatId : null;
    const lastSearchContent = typeof view.lastSearchContent === "string" ? view.lastSearchContent : "";

    let pendingSearch: any = null;
    if (view.pendingSearch?.type === "file" && typeof view.pendingSearch?.file?.path === "string") {
      pendingSearch = { type: "file", path: view.pendingSearch.file.path };
    } else if (view.pendingSearch?.type === "chat" && typeof view.pendingSearch?.chatView?.chatId === "string") {
      pendingSearch = { type: "chat", chatId: view.pendingSearch.chatView.chatId };
    }

    const currentResultsPaths = Array.isArray(view.currentResults)
      ? view.currentResults.map((r: any) => r?.path).filter((p: any) => typeof p === "string")
      : [];

    const renderedLinkHrefs: string[] = Array.from(view.containerEl?.querySelectorAll?.("a.internal-link") ?? [])
      .map((a: any) => (typeof a?.getAttribute === "function" ? a.getAttribute("href") : null))
      .filter((h: any) => typeof h === "string");

    const totalEmbeddingsViewElements = document.querySelectorAll(".systemsculpt-embeddings-view").length;
    const documentLinkHrefs: string[] = Array.from(document.querySelectorAll(".systemsculpt-embeddings-view a.internal-link"))
      .map((a: any) => (typeof a?.getAttribute === "function" ? a.getAttribute("href") : null))
      .filter((h: any) => typeof h === "string");

    return {
      activeLeafViewType,
      isVisible,
      currentFilePath,
      currentChatId,
      lastSearchContent,
      pendingSearch,
      currentResultsPaths,
      renderedLinkHrefs,
      totalEmbeddingsViewElements,
      documentLinkHrefs,
      leafCount: leaves.length,
    };
  });
}

export async function startEmbeddingsProcessingFromView(): Promise<void> {
  const result = await browser.executeObsidian(async ({ app }) => {
    const leaves = app.workspace.getLeavesOfType("systemsculpt-embeddings-view");
    const leaf = leaves[0];
    const view: any = leaf?.view;
    if (!view) {
      return { ok: false, reason: "No Similar Notes view found" };
    }

    const root = view.containerEl as HTMLElement | undefined;
    if (!root) {
      return { ok: false, reason: "Embeddings view container missing" };
    }

    const ctaButton = root.querySelector(".embeddings-view-processing .mod-cta") as HTMLButtonElement | null;
    if (!ctaButton) {
      return { ok: false, reason: "Start Processing button not found" };
    }

    ctaButton.click();
    return { ok: true };
  });

  if (!result?.ok) {
    throw new Error(`Unable to start embeddings processing from view: ${result?.reason || "unknown error"}`);
  }
}

export async function waitForEmbeddingsProgressUi(params?: { timeoutMs?: number }): Promise<void> {
  await browser.waitUntil(
    async () =>
      await browser.execute(() => {
        const progressEl = document.querySelector(".embeddings-view-processing .processing-progress");
        const barEl = document.querySelector(".embeddings-view-processing .systemsculpt-progress-fill");
        return !!progressEl || !!barEl;
      }),
    {
      timeout: params?.timeoutMs ?? 30000,
      interval: 120,
      timeoutMsg: "Embeddings processing UI did not appear in time.",
    }
  );
}

export async function waitForEmbeddingsProcessingToComplete(params?: {
  timeoutMs?: number;
  minPresent?: number;
}): Promise<EmbeddingsStats> {
  const minPresent = params?.minPresent ?? 1;

  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(
        async ({ app }, { pluginId, minPresent }) => {
          const pluginsApi: any = (app as any).plugins;
          const plugin = pluginsApi?.getPlugin?.(pluginId);
          if (!plugin) return false;

          const manager = plugin.getOrCreateEmbeddingsManager?.();
          if (!manager) return false;

          try {
            await manager.awaitReady?.();
          } catch (_) {
            return false;
          }

          const processing =
            typeof manager.isCurrentlyProcessing === "function" ? !!manager.isCurrentlyProcessing() : false;
          const stats = typeof manager.getStats === "function" ? manager.getStats() : null;
          const present = Number(stats?.present ?? 0);

          return !processing && present >= minPresent;
        },
        { pluginId: PLUGIN_ID, minPresent }
      ),
    {
      timeout: params?.timeoutMs ?? 240000,
      interval: 300,
      timeoutMsg: `Embeddings processing did not complete with minPresent=${minPresent}`,
    }
  );

  return await getEmbeddingsStats();
}
