import { normalizePath, TFile, TFolder, type TAbstractFile, type Vault } from "obsidian";
import type { StudioJsonValue, StudioNodeInstance, StudioNodeOutputMap, StudioProjectV1 } from "../../studio/types";
import { deriveStudioNoteTitleFromPath, ensureStudioNoteConfigItems, parseStudioNoteItems, readAllStudioNotePaths, readEnabledStudioNoteItems, serializeStudioNoteItems, type StudioNoteConfigItem } from "../../studio/StudioNoteConfig";
import type { StudioRunPresentationState } from "./StudioRunPresentationState";

export function isStudioMarkdownFile(file: TAbstractFile | null | undefined): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "md";
}

/** Linked-note previews and reference maintenance share one vault-aware owner. */
export class StudioVaultNotes {
  constructor(
    private readonly vault: Pick<Vault, "getAbstractFileByPath" | "cachedRead">,
    private readonly presentation: Pick<StudioRunPresentationState, "primeNodeOutput">
  ) {}

  affectedNodeIds(project: StudioProjectV1, file: TAbstractFile): Set<string> {
    const path = normalizePath(file.path);
    const matches = file instanceof TFolder
      ? (candidate: string) => candidate.startsWith(`${path}/`)
      : isStudioMarkdownFile(file) ? (candidate: string) => candidate === path : () => false;
    return new Set(project.graph.nodes.filter(node =>
      node.kind === "studio.note" && this.readAllNotePathsFromConfig(node).some(matches)
    ).map(node => node.id));
  }

  async renameReferences(project: StudioProjectV1, file: TAbstractFile, previousPath: string): Promise<boolean> {
    const markdown = isStudioMarkdownFile(file);
    if (!markdown && !(file instanceof TFolder)) return false;
    let nextChanged = false;
    const changedNodeIds = new Set<string>();
    const prefix = `${previousPath}/`;
    for (const node of project.graph.nodes) {
      if (node.kind !== "studio.note") continue;
      if (this.normalizeNoteNodeConfig(node)) nextChanged = true;
      const existingItems = parseStudioNoteItems(node.config.notes);
      const remappedItems = existingItems.map(item => ({
        ...item,
        path: markdown
          ? item.path === previousPath ? normalizePath(file.path) : item.path
          : item.path.startsWith(prefix) ? normalizePath(`${file.path}/${item.path.slice(prefix.length)}`) : item.path,
      }));
      if (JSON.stringify(existingItems) === JSON.stringify(remappedItems)) continue;
      node.config.notes = serializeStudioNoteItems(remappedItems);
      if (markdown && (!node.title || node.title === "Note" || node.title === deriveStudioNoteTitleFromPath(previousPath))) {
        node.title = file.basename || node.title;
      }
      nextChanged = true;
      changedNodeIds.add(node.id);
    }

    if (changedNodeIds.size > 0) {
      const hydrated = await this.refresh(project, {
        onlyNodeIds: changedNodeIds,
      });
      nextChanged = nextChanged || hydrated;
    }
    return nextChanged;
  }

  badge(node: StudioNodeInstance): { text: string; tone: "warning"; title: string } | null {
    if (node.kind !== "studio.note") {
      return null;
    }
    const enabledItems = this.readEnabledNoteItemsFromConfig(node);
    if (enabledItems.length === 0) {
      return {
        text: "Broken link",
        tone: "warning",
        title: "No enabled markdown notes selected.",
      };
    }

    let firstIssue: string | null = null;
    let issueCount = 0;
    for (const item of enabledItems) {
      const normalizedPath = normalizePath(item.path);
      const abstract = this.vault.getAbstractFileByPath(normalizedPath);
      if (isStudioMarkdownFile(abstract)) {
        continue;
      }
      issueCount += 1;
      if (firstIssue) {
        continue;
      }
      if (abstract instanceof TFolder) {
        firstIssue = `Vault path "${normalizedPath}" points to a folder. Note nodes require a markdown file.`;
      } else if (abstract instanceof TFile) {
        firstIssue = `Vault path "${normalizedPath}" is not a markdown file.`;
      } else {
        firstIssue = `Vault note "${normalizedPath}" was not found.`;
      }
    }

    if (issueCount === 0) {
      return null;
    }
    if (issueCount === 1 && firstIssue) {
      return {
        text: "Broken link",
        tone: "warning",
        title: firstIssue,
      };
    }
    return {
      text: "Broken link",
      tone: "warning",
      title:
        firstIssue && firstIssue.length > 0
          ? `${issueCount} of ${enabledItems.length} enabled notes are unavailable. ${firstIssue}`
          : `${issueCount} of ${enabledItems.length} enabled notes are unavailable.`,
    };
  }

  private readAllNotePathsFromConfig(node: Pick<StudioNodeInstance, "config">): string[] {
    const output: string[] = [];
    const seen = new Set<string>();
    for (const path of readAllStudioNotePaths(node.config)) {
      const normalized = path ? normalizePath(path) : "";
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  }

  private readEnabledNoteItemsFromConfig(node: Pick<StudioNodeInstance, "config">): StudioNoteConfigItem[] {
    return readEnabledStudioNoteItems(node.config)
      .map((item) => ({
        path: item.path ? normalizePath(item.path) : "",
        enabled: item.enabled !== false,
      }))
      .filter((item) => item.path.length > 0);
  }

  private normalizeNoteNodeConfig(node: StudioNodeInstance): boolean {
    let changed = false;
    let nextConfig: Record<string, StudioJsonValue> = node.config;
    const canonicalized = ensureStudioNoteConfigItems(nextConfig);
    if (canonicalized.changed) {
      nextConfig = canonicalized.nextConfig;
      changed = true;
    }

    const normalizedItems = parseStudioNoteItems(nextConfig.notes).map((item) => ({
      path: item.path ? normalizePath(item.path) : "",
      enabled: item.enabled !== false,
    }));
    const serializedItems = serializeStudioNoteItems(normalizedItems);
    if (JSON.stringify(nextConfig.notes) !== JSON.stringify(serializedItems)) {
      nextConfig = {
        ...nextConfig,
        notes: serializedItems,
      };
      changed = true;
    }

    if (changed) {
      node.config = nextConfig;
    }
    return changed;
  }

  async refresh(
    project: StudioProjectV1,
    options?: {
      onlyNodeIds?: Set<string>;
    }
  ): Promise<boolean> {
    let configChanged = false;
    const onlyNodeIds = options?.onlyNodeIds;

    for (const node of project.graph.nodes) {
      if (node.kind !== "studio.note") {
        continue;
      }
      if (onlyNodeIds && !onlyNodeIds.has(node.id)) {
        continue;
      }

      if (this.normalizeNoteNodeConfig(node)) {
        configChanged = true;
      }

      const enabledItems = this.readEnabledNoteItemsFromConfig(node);
      if (enabledItems.length === 0) {
        this.presentation.primeNodeOutput(
          node.id,
          {
            text: "",
            path: "",
            title: "",
          },
          { message: "No enabled notes selected" }
        );
        continue;
      }

      const loadedEntries: Array<{ text: string; path: string; title: string }> = [];
      let failedCount = 0;
      for (const item of enabledItems) {
        const abstract = this.vault.getAbstractFileByPath(item.path);
        if (!isStudioMarkdownFile(abstract)) {
          failedCount += 1;
          continue;
        }

        try {
          const text = await this.vault.cachedRead(abstract);
          loadedEntries.push({
            text,
            path: abstract.path,
            title: deriveStudioNoteTitleFromPath(abstract.path) || abstract.path,
          });
        } catch (error) {
          failedCount += 1;
          console.warn("[SystemSculpt Studio] Unable to read note preview", {
            nodeId: node.id,
            path: item.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (loadedEntries.length === 0) {
        const fallbackPath = enabledItems[0]?.path || "";
        this.presentation.primeNodeOutput(
          node.id,
          {
            text: "",
            path: fallbackPath,
            title: deriveStudioNoteTitleFromPath(fallbackPath) || "",
          },
          { message: "Linked notes unavailable" }
        );
        continue;
      }

      const outputs: StudioNodeOutputMap =
        loadedEntries.length === 1
          ? {
              text: loadedEntries[0].text,
              path: loadedEntries[0].path,
              title: loadedEntries[0].title,
            }
          : {
              text: loadedEntries.map((entry) => entry.text),
              path: loadedEntries.map((entry) => entry.path),
              title: loadedEntries.map((entry) => entry.title),
            };
      const message =
        failedCount > 0
          ? `Preview ready (${loadedEntries.length}/${enabledItems.length} notes loaded)`
          : "Preview ready";
      this.presentation.primeNodeOutput(node.id, outputs, { message });
    }

    return configChanged;
  }

}
