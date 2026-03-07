import type { CSSProperties } from "react";
import { ContextSelectionModal } from "@plugin-ui/ContextSelectionModal";
import { SystemSculptSearchModal } from "@plugin-ui/SystemSculptSearchModal";
import { SystemSculptHistoryModal } from "@plugin-ui/SystemSculptHistoryModal";
import { CreditsBalanceModal } from "@plugin-ui/CreditsBalanceModal";
import { EmbeddingsStatusModal } from "@plugin-ui/EmbeddingsStatusModal";
import { renderChatStatusSurface } from "@plugin-ui/ChatStatusSurface";
import { BenchResultsView } from "@plugin-ui/BenchResultsView";
import {
  Component,
  MarkdownRenderer,
  TFile,
  WorkspaceLeaf,
} from "../../shims/obsidian";
import type {
  BenchLeaderboardEntrySpec,
  BenchResultsSurfaceSpec,
  ChatStatusSurfaceSpec,
  ChatThreadSurfaceSpec,
  ContextModalSurfaceSpec,
  CreditsModalSurfaceSpec,
  EmbeddingsStatusSurfaceSpec,
  HistoryEntrySpec,
  HistoryModalSurfaceSpec,
  SceneSpec,
  SettingsPanelSurfaceSpec,
  SearchModalSurfaceSpec,
  SearchResultSpec,
  SettingsControlSpec,
  SettingsFieldSpec,
  SettingsSectionSpec,
  StudioGraphSurfaceSpec,
  ViewChromeSpec,
} from "../../lib/storyboard";
import { resolveTextReveal } from "../../lib/textReveal";
import { mountComposer } from "./composer";
import { createVideoHostApp } from "./hostApp";
import { createHostMessageRenderer, renderThreadMessage } from "./messageRendererBridge";
import { StudioGraphInteractionEngine } from "../../../../src/views/studio/StudioGraphInteractionEngine";
import { renderStudioGraphWorkspace } from "../../../../src/views/studio/graph-v3/StudioGraphWorkspaceRenderer";
import { resolveNodeDefinitionPorts } from "../../../../src/studio/StudioNodePortResolution";
import { inputNode } from "../../../../src/studio/nodes/inputNode";
import { textGenerationNode } from "../../../../src/studio/nodes/textGenerationNode";
import { textNode } from "../../../../src/studio/nodes/textNode";
import { labelNode } from "../../../../src/studio/nodes/labelNode";
import type {
  StudioNodeDefinition,
  StudioNodeOutputMap,
  StudioProjectV1,
} from "../../../../src/studio/types";
import type { StudioNodeRunDisplayState } from "../../../../src/views/studio/StudioRunPresentationState";

const modalViewportStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 28,
  background: "rgba(0, 0, 0, 0.38)",
  pointerEvents: "auto",
};

const modalShellStyle: CSSProperties = {
  width: "min(1180px, 100%)",
  maxHeight: "100%",
  display: "flex",
  justifyContent: "center",
  alignItems: "stretch",
};

const settingsShellStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px minmax(0, 1fr)",
  width: "100%",
  height: "100%",
  minHeight: 0,
  background: "var(--background-primary)",
};

const settingsSidebarStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "18px 12px 18px 16px",
  borderRight: "1px solid color-mix(in srgb, var(--background-modifier-border) 82%, transparent)",
  background: "var(--background-primary-alt)",
  overflow: "hidden",
};

const settingsSearchStyle: CSSProperties = {
  width: "100%",
  height: "34px",
  borderRadius: "10px",
  border: "1px solid var(--background-modifier-border)",
  padding: "0 12px",
  background: "var(--background-secondary)",
  color: "var(--text-normal)",
  boxSizing: "border-box",
};

const settingsPanelStyle: CSSProperties = {
  padding: "22px 28px 22px 24px",
  overflow: "auto",
  minWidth: 0,
};

const settingsFieldNoteStyle: CSSProperties = {
  marginTop: "4px",
  fontSize: "12px",
  lineHeight: "18px",
  color: "var(--text-faint)",
};

const studioDefinitionMap = new Map<string, StudioNodeDefinition>(
  [inputNode, textGenerationNode, textNode, labelNode].map((definition) => [
    `${definition.kind}@${definition.version}`,
    definition,
  ])
);

const settingsControlButtonToneClass = (
  tone?: "default" | "warning" | "accent"
) => {
  switch (tone) {
    case "warning":
      return "mod-warning";
    case "accent":
      return "mod-cta";
    default:
      return "";
  }
};

type ContextFilterKey = "all" | "text" | "documents" | "images" | "audio";

type SearchResponseLike = {
  results: Array<{
    path: string;
    title: string;
    excerpt?: string;
    score: number;
    origin: "lexical" | "semantic" | "blend" | "recent";
    updatedAt?: number;
    size?: number;
  }>;
  stats: {
    totalMs: number;
    indexedCount: number;
    inspectedCount: number;
    mode: "smart" | "lexical" | "semantic";
    usedEmbeddings: boolean;
    lexMs?: number;
    semMs?: number;
    indexMs?: number;
  };
  embeddings: {
    enabled: boolean;
    ready: boolean;
    available: boolean;
    reason?: string;
    processed?: number;
    total?: number;
  };
};

type SurfaceMountContext = {
  contentRoot: HTMLElement;
  overlayRoot: HTMLElement;
  scene: SceneSpec;
  chrome: Required<ViewChromeSpec>;
  frame: number;
  fps: number;
};

type SurfaceRenderContext<TSurface extends SceneSpec["surface"]> = Omit<
  SurfaceMountContext,
  "scene"
> & { surface: TSurface };

export type SurfaceMountController<
  TSurface extends SceneSpec["surface"] = SceneSpec["surface"],
> = {
  update?: (context: SurfaceRenderContext<TSurface>) => void;
  cleanup?: () => void;
};

type SurfaceMountHandler<TSurface extends SceneSpec["surface"]> = (
  context: SurfaceRenderContext<TSurface>
) => SurfaceMountController<TSurface> | void;

const getActiveContextFilter = (
  filters: ContextModalSurfaceSpec["filters"]
): ContextFilterKey => {
  const activeFilterId = filters.find((filter) => filter.active)?.id?.toLowerCase() ?? "all";

  switch (activeFilterId) {
    case "text":
      return "text";
    case "docs":
    case "doc":
    case "document":
    case "documents":
      return "documents";
    case "image":
    case "images":
      return "images";
    case "audio":
      return "audio";
    default:
      return "all";
  }
};

const applyContextModalLayout = (
  modalEl: HTMLDivElement,
  titleEl: HTMLDivElement,
  contentEl: HTMLDivElement
) => {
  Object.assign(modalEl.style, {
    width: "100%",
    height: "min(720px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "20px",
    background: "var(--background-secondary)",
    borderRadius: "12px",
    border: "1px solid color-mix(in srgb, var(--background-modifier-border) 88%, transparent)",
    boxShadow: "0 20px 48px rgba(0, 0, 0, 0.32)",
    overflow: "hidden",
  } as CSSStyleDeclaration);

  Object.assign(titleEl.style, {
    fontSize: "26px",
    fontWeight: "700",
    letterSpacing: "-0.03em",
    color: "var(--text-normal)",
  } as CSSStyleDeclaration);

  Object.assign(contentEl.style, {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    flex: "1",
    minHeight: "0",
  } as CSSStyleDeclaration);

  modalEl.querySelectorAll<HTMLElement>(".setting-item").forEach((el) => {
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.gap = "12px";
  });
  modalEl.querySelectorAll<HTMLElement>(".setting-item-name").forEach((el) => {
    el.style.minWidth = "92px";
    el.style.fontSize = "13px";
    el.style.fontWeight = "600";
    el.style.color = "var(--text-muted)";
  });
  modalEl.querySelectorAll<HTMLElement>(".setting-item-control").forEach((el) => {
    el.style.display = "flex";
    el.style.flex = "1";
    el.style.alignItems = "center";
    el.style.gap = "8px";
  });
  modalEl
    .querySelectorAll<HTMLInputElement>(".setting-item-control input")
    .forEach((el) => {
      el.style.width = "100%";
      el.style.height = "38px";
      el.style.border = "1px solid var(--background-modifier-border)";
      el.style.borderRadius = "10px";
      el.style.padding = "0 12px";
      el.style.background = "var(--background-primary)";
      el.style.color = "var(--text-normal)";
    });
};

const createModalShell = (overlayRoot: HTMLElement) => {
  overlayRoot.empty();
  const overlay = overlayRoot.createDiv();
  Object.assign(overlay.style, modalViewportStyle);
  const shell = overlay.createDiv();
  Object.assign(shell.style, modalShellStyle);
  return shell;
};

const withPatchedSetTimeout = (callback: () => void) => {
  const originalSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler) => {
    if (typeof handler === "function") {
      handler();
    }
    return 0;
  }) as typeof window.setTimeout;

  try {
    callback();
  } finally {
    window.setTimeout = originalSetTimeout;
  }
};

const toSearchHit = (result: SearchResultSpec) => ({
  path: result.path,
  title: result.title,
  excerpt: result.excerpt,
  score: result.score,
  origin: result.origin,
  updatedAt: result.updatedAt,
  size: result.size,
});

const buildSearchResponse = (
  surface: SearchModalSurfaceSpec,
  visibleQuery: string
): SearchResponseLike => ({
  results: surface.results.map(toSearchHit),
  stats: {
    ...surface.metrics,
    mode: surface.mode,
    usedEmbeddings:
      surface.metrics.usedEmbeddings && visibleQuery.trim().length > 0 && surface.results.length > 0,
  },
  embeddings: { ...surface.embeddings },
});

type SearchModalFrameState = {
  query: string | null;
  phase: "recents" | "partial" | "complete" | null;
};

const syncSearchModalFrame = (
  modal: SystemSculptSearchModal,
  surface: SearchModalSurfaceSpec,
  frame: number,
  fps: number,
  frameStateRef: { current: SearchModalFrameState }
) => {
  const visibleQuery = resolveTextReveal(surface.query, frame, fps, surface.queryReveal).text;
  const trimmedVisibleQuery = visibleQuery.trim();
  const nextPhase =
    trimmedVisibleQuery.length === 0
      ? "recents"
      : visibleQuery === surface.query
        ? "complete"
        : "partial";

  const modalAny = modal as any;
  modalAny.currentQuery = visibleQuery;
  modalAny.mode = surface.mode;
  modalAny.sort = surface.sort;
  modalAny.syncModeButtons?.();
  modalAny.syncSortButtons?.();
  modalAny.syncModeAvailability?.(surface.embeddings);

  const input = modalAny.searchInputEl as HTMLInputElement | null;
  if (input) {
    input.value = visibleQuery;
  }

  const lastFrameState = frameStateRef.current;
  const phaseChanged = lastFrameState.phase !== nextPhase;
  const queryChanged = lastFrameState.query !== visibleQuery;

  if (nextPhase === "recents" && (phaseChanged || queryChanged)) {
    modalAny.renderResults?.(surface.recents.map(toSearchHit));
    modalAny.renderMetrics?.({
      totalMs: 0,
      indexedCount: surface.metrics.indexedCount,
      inspectedCount: surface.recents.length,
      mode: surface.mode,
      usedEmbeddings: false,
    });
    modalAny.renderState?.("Showing your 25 most recent files.");
  } else if (nextPhase === "partial" && phaseChanged) {
    modalAny.renderResponse?.(buildSearchResponse(surface, visibleQuery));
    if (surface.stateText) {
      modalAny.renderState?.(surface.stateText);
    }
  } else if (nextPhase === "complete" && (phaseChanged || queryChanged)) {
    modalAny.currentQuery = surface.query;
    if (input) {
      input.value = surface.query;
    }
    modalAny.renderResponse?.(buildSearchResponse(surface, surface.query));
    if (surface.stateText) {
      modalAny.renderState?.(surface.stateText);
    }
  }

  frameStateRef.current = {
    query: visibleQuery,
    phase: nextPhase,
  };
};

const toHistoryEntry = (entry: HistoryEntrySpec) => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  subtitle: entry.subtitle ?? "",
  timestampMs: entry.timestampMs,
  searchText: (entry.searchText ?? `${entry.title}\n${entry.subtitle ?? ""}`).toLowerCase(),
  badge: entry.badge,
  isFavorite: entry.isFavorite ?? false,
  toggleFavorite: async () => entry.isFavorite ?? false,
  openPrimary: async () => {},
});

const toBenchLoadResult = (surface: BenchResultsSurfaceSpec) => ({
  status:
    surface.status ?? (surface.entries.length > 0 ? "success" : "empty"),
  entries: surface.entries.map((entry: BenchLeaderboardEntrySpec, index) => ({
    rank: index + 1,
    modelId: entry.modelId,
    modelDisplayName: entry.modelDisplayName,
    scorePercent: entry.scorePercent,
    totalPointsEarned: entry.totalPointsEarned,
    totalMaxPoints: entry.totalMaxPoints,
    runId: entry.runId,
    runDate: new Date(entry.runDate),
    suiteId: entry.suiteId,
    suiteVersion: entry.suiteVersion,
  })),
  errorMessage: surface.errorMessage,
});

const mountDragOverlay = (root: HTMLElement) => {
  const dragOverlay = root.createDiv({ cls: "systemsculpt-drag-overlay" });
  dragOverlay.createDiv({
    cls: "systemsculpt-drag-message",
    text: "Drop files, folders, or search results to add to context",
  });
  dragOverlay.createDiv({ cls: "systemsculpt-drag-detail" });
};

const mountScrollChrome = (root: HTMLElement, showButton = false) => {
  const button = root.createEl("button", {
    cls: "systemsculpt-scroll-to-bottom",
    attr: {
      type: "button",
      "aria-label": "Scroll to bottom",
    },
  });
  if (!showButton) {
    button.style.display = "none";
  }
  button.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 3v10m0 0l-4-4m4 4l4-4"/>
    </svg>
  `;
  root.createDiv({ cls: "systemsculpt-visually-hidden" });
};

const mountContextModal: SurfaceMountHandler<ContextModalSurfaceSpec> = ({
  overlayRoot,
  surface,
  frame,
  fps,
}) => {
  const shell = createModalShell(overlayRoot);
  const files = surface.rows.map((row) => new TFile(row.path));
  const attachedPaths = new Set(
    surface.rows.filter((row) => row.state === "attached").map((row) => row.path)
  );
  const selectedPaths = new Set(
    surface.rows.filter((row) => row.state === "selected").map((row) => row.path)
  );
  const searchResult = resolveTextReveal(
    surface.searchValue,
    frame,
    fps,
    surface.searchReveal
  );
  const app = createVideoHostApp(files);
  const modal = new ContextSelectionModal(
    app as any,
    () => {},
    {} as any,
    {
      isFileAlreadyInContext: (file: TFile) => attachedPaths.has(file.path),
      initialFilter: getActiveContextFilter(surface.filters),
      initialSearchQuery: searchResult.text,
      initialSelectedPaths: Array.from(selectedPaths),
      autoFocusSearch: false,
    }
  );

  modal.onOpen();
  applyContextModalLayout(modal.modalEl, modal.titleEl, modal.contentEl);
  shell.appendChild(modal.modalEl);

  return {
    cleanup: () => modal.onClose?.(),
  };
};

const mountSearchModal: SurfaceMountHandler<SearchModalSurfaceSpec> = ({
  overlayRoot,
  surface,
  frame,
  fps,
}) => {
  const shell = createModalShell(overlayRoot);
  const app = createVideoHostApp();
  const engine = {
    search: async () => buildSearchResponse(surface, surface.query),
    getRecent: async () => surface.recents.map(toSearchHit),
    getEmbeddingsIndicator: () => ({ ...surface.embeddings }),
  };
  const modal = new SystemSculptSearchModal({
    app,
    getSearchEngine: () => engine,
  } as any);
  const frameStateRef = {
    current: {
      query: null,
      phase: null,
    } as SearchModalFrameState,
  };

  (modal as any).renderRecents = async () => {};
  withPatchedSetTimeout(() => {
    modal.onOpen();
  });
  syncSearchModalFrame(modal, surface, frame, fps, frameStateRef);

  shell.appendChild(modal.modalEl);

  return {
    update: ({ surface: nextSurface, frame: nextFrame, fps: nextFps }) => {
      syncSearchModalFrame(modal, nextSurface, nextFrame, nextFps, frameStateRef);
    },
    cleanup: () => modal.onClose?.(),
  };
};

const mountHistoryModal: SurfaceMountHandler<HistoryModalSurfaceSpec> = ({
  overlayRoot,
  surface,
  frame,
  fps,
}) => {
  const shell = createModalShell(overlayRoot);
  const app = createVideoHostApp();
  const modal = new SystemSculptHistoryModal({
    app,
  } as any, {
    loadEntries: async () => surface.entries.map(toHistoryEntry),
  } as any);
  void modal.onOpen();

  modal.isLoading = false;
  modal.entries = surface.entries.map(toHistoryEntry);

  const visibleSearch = resolveTextReveal(
    surface.searchValue,
    frame,
    fps,
    surface.searchReveal
  ).text;
  if (modal.searchInput) {
    modal.searchInput.setValue(visibleSearch);
  }
  modal.applyFilters?.();

  shell.appendChild(modal.modalEl);

  return {
    cleanup: () => modal.onClose?.(),
  };
};

const mountCreditsModal: SurfaceMountHandler<CreditsModalSurfaceSpec> = ({
  overlayRoot,
  surface,
}) => {
  const shell = createModalShell(overlayRoot);
  const app = createVideoHostApp();
  const initialUsage = surface.usage
    ? {
        items: [...surface.usage.items],
        nextBefore: surface.usage.nextBefore,
      }
    : { items: [], nextBefore: null };
  const modal = new CreditsBalanceModal(app as any, {
    initialBalance: {
      ...surface.balance,
      cycleAnchorAt: surface.balance.cycleAnchorAt ?? null,
      turnInFlightUntil: surface.balance.turnInFlightUntil ?? null,
      purchaseUrl: surface.balance.purchaseUrl ?? null,
    },
    initialUsage,
    loadBalance: async () => ({
      ...surface.balance,
      cycleAnchorAt: surface.balance.cycleAnchorAt ?? null,
      turnInFlightUntil: surface.balance.turnInFlightUntil ?? null,
      purchaseUrl: surface.balance.purchaseUrl ?? null,
    }),
    loadUsage: async () => initialUsage,
    onOpenSetup: () => {},
  });

  modal.onOpen();
  if (surface.activeTab === "usage") {
    modal.activeTab = "usage";
    modal.updateTabUI?.();
    modal.renderUsage?.();
  }
  shell.appendChild(modal.modalEl);

  return {
    cleanup: () => modal.onClose?.(),
  };
};

const mountEmbeddingsStatusModal: SurfaceMountHandler<EmbeddingsStatusSurfaceSpec> = ({
  overlayRoot,
  surface,
}) => {
  const shell = createModalShell(overlayRoot);
  const app = createVideoHostApp();
  const manager = {
    isCurrentlyProcessing: () => surface.isProcessing ?? false,
    getStats: () => ({ ...surface.stats }),
    getCurrentNamespaceDescriptor: () => ({
      provider: surface.provider,
      model: surface.model,
      schema: surface.schema,
    }),
    processVault: async () => ({ status: "complete" }),
    retryFailedFiles: async () => undefined,
    suspendProcessing: () => {},
  };
  const plugin = {
    app,
    settings: {
      embeddingsEnabled: surface.embeddingsEnabled ?? true,
    },
    embeddingsManager: manager,
    getOrCreateEmbeddingsManager: () => manager,
    emitter: {
      on: () => () => {},
    },
    manifest: { id: "systemsculpt-plugin" },
  };
  const modal = new EmbeddingsStatusModal(app as any, plugin as any);
  modal.setupEventListeners = () => {};
  modal.startPeriodicUpdates = () => {};
  modal.updateDisplay = async () => {};
  void modal.onOpen();

  if (surface.embeddingsEnabled === false) {
    modal.renderNotInitialized?.();
  } else {
    modal.renderProviderInfo?.(
      {
        provider: surface.provider,
        model: surface.model,
        schema: surface.schema,
      },
      surface.isProcessing ?? false
    );
    modal.renderStats?.(surface.stats, surface.isProcessing ?? false);
    modal.renderProgress?.(surface.stats, surface.isProcessing ?? false);
    modal.updateActionButtons?.(surface.isProcessing ?? false, surface.stats);
    if (surface.errorMessage) {
      modal.displayError?.(surface.errorMessage);
    }
  }

  shell.appendChild(modal.modalEl);

  return {
    cleanup: () => modal.onClose?.(),
  };
};

const renderSettingsControl = (parent: HTMLElement, control: SettingsControlSpec) => {
  switch (control.kind) {
    case "toggle": {
      const label = parent.createEl("label", {
        cls: "checkbox-container",
      });
      label.style.display = "inline-flex";
      label.style.alignItems = "center";
      label.style.gap = "10px";

      const input = label.createEl("input", {
        type: "checkbox",
      });
      input.checked = control.value;
      input.disabled = control.disabled ?? false;
      input.style.width = "18px";
      input.style.height = "18px";
      label.createSpan({ text: control.value ? "On" : "Off" });
      return;
    }
    case "dropdown": {
      const select = parent.createEl("select");
      Object.assign(select.style, {
        minWidth: "220px",
        height: "34px",
        borderRadius: "8px",
        border: "1px solid var(--background-modifier-border)",
        padding: "0 10px",
        background: "var(--background-secondary)",
        color: "var(--text-normal)",
      } as CSSStyleDeclaration);
      control.options.forEach((option) => {
        select.createEl("option", {
          value: option,
          text: option,
        });
      });
      select.value = control.value;
      select.disabled = control.disabled ?? false;
      return;
    }
    case "text": {
      const input = parent.createEl("input", {
        type: control.secret ? "password" : "text",
      });
      Object.assign(input.style, {
        minWidth: "260px",
        height: "34px",
        borderRadius: "8px",
        border: "1px solid var(--background-modifier-border)",
        padding: "0 10px",
        background: "var(--background-secondary)",
        color: "var(--text-normal)",
        boxSizing: "border-box",
      } as CSSStyleDeclaration);
      input.value = control.value;
      input.placeholder = control.placeholder ?? "";
      input.disabled = control.disabled ?? false;
      return;
    }
    case "button": {
      const button = parent.createEl("button", {
        text: control.label,
        cls: settingsControlButtonToneClass(control.tone),
        attr: {
          type: "button",
        },
      });
      Object.assign(button.style, {
        minHeight: "34px",
        padding: "0 12px",
        borderRadius: "8px",
        border: "1px solid var(--background-modifier-border)",
        background:
          control.tone === "accent"
            ? "var(--interactive-accent)"
            : control.tone === "warning"
              ? "rgba(var(--color-red-rgb), 0.16)"
              : "var(--interactive-normal)",
        color:
          control.tone === "accent" ? "var(--text-on-accent)" : "var(--text-normal)",
      } as CSSStyleDeclaration);
      button.disabled = control.disabled ?? false;
      return;
    }
  }
};

const renderSettingsField = (parent: HTMLElement, field: SettingsFieldSpec) => {
  const row = parent.createDiv({ cls: "setting-item" });
  row.dataset.settingId = field.id;
  row.style.padding = "12px 0";
  row.style.borderBottom =
    "1px solid color-mix(in srgb, var(--background-modifier-border) 78%, transparent)";

  const info = row.createDiv({ cls: "setting-item-info" });
  info.style.display = "flex";
  info.style.flexDirection = "column";
  info.style.gap = "4px";

  info.createDiv({
    cls: "setting-item-name",
    text: field.label,
  });

  if (field.description) {
    info.createDiv({
      cls: "setting-item-description",
      text: field.description,
    });
  }

  const controlWrap = row.createDiv({ cls: "setting-item-control" });
  controlWrap.style.display = "flex";
  controlWrap.style.alignItems = "center";
  controlWrap.style.justifyContent = "flex-end";
  controlWrap.style.flex = "0 0 auto";
  renderSettingsControl(controlWrap, field.control);

  if (field.note) {
    const note = info.createDiv({
      text: field.note,
    });
    Object.assign(note.style, settingsFieldNoteStyle);
  }
};

const renderSettingsSection = (parent: HTMLElement, section: SettingsSectionSpec) => {
  const sectionEl = parent.createDiv();
  sectionEl.dataset.sectionId = section.id;
  sectionEl.style.marginBottom = "22px";
  sectionEl.createEl("h3", {
    text: section.title,
  });
  if (section.description) {
    sectionEl.createEl("p", {
      text: section.description,
      cls: "setting-item-description",
    });
  }
  section.fields.forEach((field) => renderSettingsField(sectionEl, field));
};

const mountSettingsPanel: SurfaceMountHandler<SettingsPanelSurfaceSpec> = ({
  contentRoot,
  surface,
}) => {
  contentRoot.empty();

  const shell = contentRoot.createDiv({ cls: "ss-settings-video-shell" });
  Object.assign(shell.style, settingsShellStyle);

  const sidebar = shell.createDiv({ cls: "ss-settings-video-sidebar" });
  Object.assign(sidebar.style, settingsSidebarStyle);
  const searchInput = sidebar.createEl("input", {
    type: "search",
    placeholder: "Search settings...",
    value: surface.searchValue ?? "",
  });
  Object.assign(searchInput.style, settingsSearchStyle as CSSStyleDeclaration);

  const tabList = sidebar.createDiv();
  tabList.style.display = "flex";
  tabList.style.flexDirection = "column";
  tabList.style.gap = "6px";
  tabList.style.minHeight = "0";
  tabList.style.overflow = "hidden";

  surface.tabs.forEach((tab) => {
    const button = tabList.createEl("button", {
      text: tab.label,
      attr: {
        type: "button",
      },
    });
    button.disabled = true;
    button.style.textAlign = "left";
    button.style.padding = "9px 12px";
    button.style.border = "0";
    button.style.borderRadius = "10px";
    button.style.background = tab.active
      ? "color-mix(in srgb, var(--interactive-accent) 20%, transparent)"
      : "transparent";
    button.style.color = tab.active ? "var(--text-normal)" : "var(--text-muted)";
    button.style.fontWeight = tab.active ? "600" : "500";
  });

  const panel = shell.createDiv({ cls: "ss-settings-video-panel" });
  Object.assign(panel.style, settingsPanelStyle);
  surface.sections.forEach((section) => renderSettingsSection(panel, section));
};

const mountStudioGraphView: SurfaceMountHandler<StudioGraphSurfaceSpec> = ({
  contentRoot,
  surface,
}) => {
  contentRoot.empty();

  const root = contentRoot.createDiv({ cls: "ss-studio-video-shell" });
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.minHeight = "0";

  const project: StudioProjectV1 = {
    schema: "studio.project.v1",
    projectId: `video-${surface.projectName.toLowerCase().replace(/\s+/g, "-")}`,
    name: surface.projectName,
    createdAt: "2026-03-07T00:00:00.000Z",
    updatedAt: "2026-03-07T10:30:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: surface.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        version: node.version,
        title: node.title,
        position: { ...node.position },
        config: { ...node.config } as any,
      })),
      edges: surface.edges.map((edge) => ({ ...edge })),
      entryNodeIds: [...surface.entryNodeIds],
      groups: surface.groups?.map((group) => ({
        id: group.id,
        name: group.name,
        color: group.color,
        nodeIds: [...group.nodeIds],
      })),
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: ".systemsculpt/policies/video-demo.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 50,
        maxArtifactsMb: 512,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };

  const nodeStateById = new Map<string, StudioNodeRunDisplayState>();
  surface.nodeStates?.forEach((state) => {
    nodeStateById.set(state.nodeId, {
      status: state.status,
      message: state.message ?? "",
      updatedAt: state.updatedAt ?? null,
      outputs: (state.outputs as StudioNodeOutputMap | null | undefined) ?? null,
    });
  });

  const findStudioNodeDefinition = (nodeId: string) => {
    const node = project.graph.nodes.find((entry) => entry.id === nodeId) ?? null;
    if (!node) {
      return null;
    }
    const definition = studioDefinitionMap.get(`${node.kind}@${node.version}`) ?? null;
    return definition ? resolveNodeDefinitionPorts(node, definition) : null;
  };

  const graphInteraction = new StudioGraphInteractionEngine({
    isBusy: () => false,
    getCurrentProject: () => project,
    setError: () => {},
    recomputeEntryNodes: () => {},
    scheduleProjectSave: () => {},
    requestRender: () => {},
    getPortType: (nodeId, direction, portId) => {
      const definition = findStudioNodeDefinition(nodeId);
      const ports = direction === "in" ? definition?.inputPorts : definition?.outputPorts;
      return ports?.find((port) => port.id === portId)?.type ?? null;
    },
    portTypeCompatible: (sourceType, targetType) =>
      sourceType === "any" || targetType === "any" || sourceType === targetType,
  });

  graphInteraction.setGraphZoom(surface.viewport?.zoom ?? 0.74);

  const renderResult = renderStudioGraphWorkspace({
    root,
    busy: false,
    currentProject: project,
    currentProjectPath: surface.projectPath,
    nodeDetailMode: surface.nodeDetailMode ?? "expanded",
    graphInteraction,
    getNodeRunState: (nodeId) =>
      nodeStateById.get(nodeId) ?? {
        status: "idle",
        message: "",
        updatedAt: null,
        outputs: null,
      },
    findNodeDefinition: (node) =>
      studioDefinitionMap.get(`${node.kind}@${node.version}`)
        ? resolveNodeDefinitionPorts(
            node,
            studioDefinitionMap.get(`${node.kind}@${node.version}`) as StudioNodeDefinition
          )
        : null,
    onRunGraph: () => {},
    onOpenAddNodeMenuAtViewportCenter: () => {},
    onZoomIn: () => {},
    onZoomOut: () => {},
    onZoomReset: () => {},
    onToggleNodeDetailMode: () => {},
    onOpenNodeContextMenu: () => {},
    onCreateLabelAtPosition: () => {},
    onRunNode: () => {},
    onCopyTextGenerationPromptBundle: () => {},
    onToggleTextGenerationOutputLock: () => {},
    onRemoveNode: () => {},
    onNodeTitleInput: () => {},
    onNodeConfigMutated: () => {},
    onNodePresentationMutated: () => {},
    onNodeGeometryMutated: () => {},
    resolveDynamicSelectOptions: async (source) => {
      if (source === "studio.pi_text_models") {
        return surface.modelOptions?.map((option) => ({ ...option })) ?? [];
      }
      return [];
    },
    renderMarkdownPreview: async (_node, markdown, containerEl) => {
      const component = new Component();
      await MarkdownRenderer.render(
        null,
        markdown,
        containerEl,
        surface.projectPath,
        component
      );
    },
    isLabelEditing: () => false,
    consumeLabelAutoFocus: () => false,
    onRequestLabelEdit: () => {},
    onStopLabelEdit: () => {},
    onRevealPathInFinder: () => {},
  });

  if (renderResult.viewportEl) {
    renderResult.viewportEl.scrollLeft = surface.viewport?.scrollLeft ?? 80;
    renderResult.viewportEl.scrollTop = surface.viewport?.scrollTop ?? 32;
  }
};

const mountChatStatus: SurfaceMountHandler<ChatStatusSurfaceSpec> = ({
  contentRoot,
  chrome,
  surface,
  frame,
  fps,
}) => {
  contentRoot.empty();
  if (chrome.showDragOverlay) {
    mountDragOverlay(contentRoot);
  }

  const messages = contentRoot.createDiv({
    cls: `systemsculpt-messages-container systemsculpt-chat-${chrome.chatFontSize}`,
  });
  const status = messages.createDiv({ cls: "systemsculpt-chat-status no-animate" });
  renderChatStatusSurface(status, {
    eyebrow: surface.eyebrow,
    title: surface.title,
    description: surface.description,
    chips: surface.chips.map((chip) => ({
      label: chip.label,
      value: chip.value,
      icon: chip.icon,
    })),
    actions: surface.actions.map((action) => ({
      label: action.label,
      icon: action.icon,
      primary: action.primary,
    })),
    note: surface.note,
  });
  messages.createDiv({ cls: "systemsculpt-scroll-sentinel" });
  mountScrollChrome(contentRoot, chrome.showScrollToBottom);

  mountComposer(
    contentRoot,
    surface.toolbarChips,
    surface.attachments,
    surface.draft,
    "none",
    false,
    frame,
    fps
  );
};

const mountChatThread: SurfaceMountHandler<ChatThreadSurfaceSpec> = ({
  contentRoot,
  chrome,
  surface,
  frame,
  fps,
}) => {
  contentRoot.empty();
  if (chrome.showDragOverlay) {
    mountDragOverlay(contentRoot);
  }

  const messages = contentRoot.createDiv({
    cls: `systemsculpt-messages-container systemsculpt-chat-${chrome.chatFontSize}`,
  });
  const app = createVideoHostApp();
  const renderer = createHostMessageRenderer(app);

  surface.messages.forEach((message) => {
    renderThreadMessage(renderer, messages, message, frame, fps);
  });
  messages.createDiv({ cls: "systemsculpt-scroll-sentinel" });
  mountScrollChrome(contentRoot, chrome.showScrollToBottom);

  mountComposer(
    contentRoot,
    surface.toolbarChips,
    surface.attachments,
    surface.draft,
    surface.recording ?? "none",
    surface.stopVisible ?? false,
    frame,
    fps
  );
};

const mountBenchResultsView: SurfaceMountHandler<BenchResultsSurfaceSpec> = ({
  contentRoot,
  surface,
}) => {
  contentRoot.empty();
  const app = createVideoHostApp();
  const plugin = {
    app,
    storage: {
      initialize: async () => {},
      getPath: () => ".systemsculpt/benchmarks/v2/runs",
    },
    modelService: {
      getModelById: async (_modelId: string) => null,
    },
  };
  const leaf = new WorkspaceLeaf(app);
  const view = new BenchResultsView(leaf as any, plugin as any);
  const root = view.containerEl.children[1] as HTMLElement;
  root.empty();
  root.addClass("systemsculpt-benchresults-view");
  view.containerElRoot = root;
  view.buildHeader?.();
  view.buildContent?.();
  view.renderer.render(view.leaderboardEl, toBenchLoadResult(surface));
  contentRoot.appendChild(root);
};

const surfaceRegistry = {
  "search-modal": mountSearchModal,
  "context-modal": mountContextModal,
  "history-modal": mountHistoryModal,
  "credits-modal": mountCreditsModal,
  "embeddings-status-modal": mountEmbeddingsStatusModal,
  "settings-panel": mountSettingsPanel,
  "studio-graph-view": mountStudioGraphView,
  "chat-status": mountChatStatus,
  "chat-thread": mountChatThread,
  "bench-results-view": mountBenchResultsView,
} satisfies {
  [K in SceneSpec["surface"]["kind"]]: SurfaceMountHandler<Extract<SceneSpec["surface"], { kind: K }>>;
};

export const mountSceneSurface = ({
  scene,
  ...context
}: SurfaceMountContext) => {
  surfaceRegistry[scene.surface.kind]({
    ...context,
    surface: scene.surface as never,
  });
};
