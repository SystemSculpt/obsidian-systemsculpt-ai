import { Notice } from "obsidian";
import type { StudioTerminalSidecarStatus, StudioTerminalSessionSnapshot } from "../../studio/StudioTerminalSessionManager";
import {
  applyTerminalNodeSize,
  clampTerminalInt,
  fallbackTerminalGridDimensions,
  readTerminalSessionRequest,
  resolveTerminalScrollback,
} from "./terminal/StudioTerminalNodeConfig";
import type { StudioTerminalNodeMountOptions } from "./terminal/StudioTerminalNodeTypes";
import {
  buildStudioTerminalXtermOptions,
  loadXtermRuntime,
  resolveStudioTerminalShortcutInput,
  STUDIO_TERMINAL_FONT_FAMILY,
} from "./terminal/StudioTerminalXterm";

export { STUDIO_TERMINAL_FONT_FAMILY, buildStudioTerminalXtermOptions } from "./terminal/StudioTerminalXterm";

const RESIZE_DEBOUNCE_MS = 300;

type TerminalVisualTone = "idle" | "starting" | "running" | "failed" | "degraded";

function resolveSidecarState(status: StudioTerminalSidecarStatus | null): string {
  return String(status?.state || "unknown").trim().toLowerCase();
}

function resolveTerminalTone(
  snapshot: StudioTerminalSessionSnapshot | null,
  sidecarStatus: StudioTerminalSidecarStatus | null
): TerminalVisualTone {
  const terminalState = String(snapshot?.status || "idle").trim().toLowerCase();
  if (terminalState === "failed") {
    return "failed";
  }
  if (terminalState === "starting") {
    return "starting";
  }
  if (terminalState === "running") {
    const sidecarState = resolveSidecarState(sidecarStatus);
    if (sidecarState === "failed" || sidecarState === "disconnected") {
      return "degraded";
    }
    return "running";
  }
  return "idle";
}

function resolveCompactStatusText(
  snapshot: StudioTerminalSessionSnapshot | null,
  sidecarStatus: StudioTerminalSidecarStatus | null
): string {
  const terminalState = String(snapshot?.status || "idle").trim().toLowerCase();
  const terminalLabel = terminalState.charAt(0).toUpperCase() + terminalState.slice(1);
  const sidecarState = resolveSidecarState(sidecarStatus);
  if (!sidecarStatus || sidecarState === "unknown") {
    return terminalLabel;
  }
  return `${terminalLabel} · ${sidecarState}`;
}

export function mountStudioTerminalNode(options: StudioTerminalNodeMountOptions): () => void {
  const sizeTargets = [options.nodeEl];
  if (options.nodeCardEl && options.nodeCardEl !== options.nodeEl) {
    sizeTargets.push(options.nodeCardEl);
  }
  for (const targetEl of sizeTargets) {
    applyTerminalNodeSize(options.node, targetEl);
  }

  const panelEl = options.nodeEl.createDiv({ cls: "ss-studio-terminal-panel" });
  const toolbarEl = panelEl.createDiv({ cls: "ss-studio-terminal-toolbar" });
  const summaryEl = toolbarEl.createDiv({ cls: "ss-studio-terminal-toolbar-summary" });
  const healthDotEl = summaryEl.createDiv({ cls: "ss-studio-terminal-health-dot is-idle" });
  const statusEl = summaryEl.createDiv({ cls: "ss-studio-terminal-status-text", text: "Idle" });
  const actionsEl = toolbarEl.createDiv({ cls: "ss-studio-terminal-actions" });

  const restartButton = actionsEl.createEl("button", {
    text: "Restart",
    cls: "ss-studio-terminal-action",
  });
  const stopButton = actionsEl.createEl("button", {
    text: "Stop",
    cls: "ss-studio-terminal-action",
  });
  restartButton.type = "button";
  stopButton.type = "button";

  const surfaceEl = panelEl.createDiv({ cls: "ss-studio-terminal-surface" });

  let disposed = false;
  let terminal: import("@xterm/xterm").Terminal | null = null;
  let fitAddon: import("@xterm/addon-fit").FitAddon | null = null;
  let unsubscribeSession: (() => void) | null = null;
  let unsubscribeSidecarStatus: (() => void) | null = null;
  let unsubscribeZoom: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let inputDisposable: { dispose: () => void } | null = null;
  let latestSnapshot: StudioTerminalSessionSnapshot | null = null;
  let latestSidecarStatus: StudioTerminalSidecarStatus | null = options.getSidecarStatus();
  let appliedHistoryRevision: number | null = null;
  let pendingResizeTimer: number | null = null;
  let lastSessionSize: { cols: number; rows: number } | null = null;

  const syncStatus = (): void => {
    const tone = resolveTerminalTone(latestSnapshot, latestSidecarStatus);
    healthDotEl.className = `ss-studio-terminal-health-dot is-${tone}`;
    statusEl.setText(resolveCompactStatusText(latestSnapshot, latestSidecarStatus));
  };

  const syncButtons = (): void => {
    const status = latestSnapshot?.status || "idle";
    restartButton.disabled = options.interactionLocked || status === "starting";
    stopButton.disabled = options.interactionLocked || (status !== "running" && status !== "starting");
    syncStatus();
  };

  const applySnapshotToTerminal = (snapshot: StudioTerminalSessionSnapshot): void => {
    latestSnapshot = snapshot;
    syncButtons();
    if (!terminal) {
      return;
    }
    if (appliedHistoryRevision !== snapshot.historyRevision) {
      terminal.reset();
      if (snapshot.history) {
        terminal.write(snapshot.history);
      }
      if (snapshot.errorMessage) {
        terminal.write(`\r\n${snapshot.errorMessage}\r\n`);
      }
      appliedHistoryRevision = snapshot.historyRevision;
    }
  };

  const pushDataToTerminal = (data: string, historyRevision: number): void => {
    if (!terminal) {
      return;
    }
    if (appliedHistoryRevision !== historyRevision) {
      if (latestSnapshot) {
        applySnapshotToTerminal(latestSnapshot);
      }
      return;
    }
    if (data) {
      terminal.write(data);
    }
  };

  const runWithCurrentConfig = async (mode: "ensure" | "restart"): Promise<void> => {
    const request = readTerminalSessionRequest({
      node: options.node,
      projectPath: options.projectPath,
    });

    const fallback = fallbackTerminalGridDimensions(options.node);
    let cols = fallback.cols;
    let rows = fallback.rows;
    if (fitAddon && typeof fitAddon.proposeDimensions === "function") {
      const proposed = fitAddon.proposeDimensions();
      if (proposed) {
        cols = clampTerminalInt(proposed.cols, cols, 20, 1000);
        rows = clampTerminalInt(proposed.rows, rows, 8, 600);
      }
    }
    request.cols = cols;
    request.rows = rows;

    try {
      const snapshot =
        mode === "restart" ? await options.restartSession(request) : await options.ensureSession(request);
      applySnapshotToTerminal(snapshot);
    } catch (error) {
      new Notice(`Terminal start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const queueResize = (): void => {
    if (pendingResizeTimer !== null) {
      window.clearTimeout(pendingResizeTimer);
      pendingResizeTimer = null;
    }
    pendingResizeTimer = window.setTimeout(() => {
      pendingResizeTimer = null;
      if (!fitAddon || !terminal) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (typeof fitAddon.proposeDimensions !== "function") {
        return;
      }
      const proposed = fitAddon.proposeDimensions();
      if (!proposed) {
        return;
      }
      const cols = clampTerminalInt(proposed.cols, 120, 20, 1000);
      const rows = clampTerminalInt(proposed.rows, 30, 8, 600);
      if (lastSessionSize && lastSessionSize.cols === cols && lastSessionSize.rows === rows) {
        return;
      }
      lastSessionSize = { cols, rows };
      options.resizeSession({
        projectPath: options.projectPath,
        nodeId: options.node.id,
        cols,
        rows,
      });
    }, RESIZE_DEBOUNCE_MS);
  };

  restartButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const mode = latestSnapshot?.status === "running" ? "restart" : "ensure";
    void runWithCurrentConfig(mode);
  });

  stopButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void options.stopSession({
      projectPath: options.projectPath,
      nodeId: options.node.id,
    });
  });

  unsubscribeSession = options.subscribe(
    { projectPath: options.projectPath, nodeId: options.node.id },
    (sessionEvent) => {
      if (disposed) {
        return;
      }
      if (sessionEvent.type === "snapshot") {
        applySnapshotToTerminal(sessionEvent.snapshot);
        return;
      }
      pushDataToTerminal(sessionEvent.data, sessionEvent.historyRevision);
    }
  );

  const initialSnapshot = options.getSnapshot({
    projectPath: options.projectPath,
    nodeId: options.node.id,
  });
  if (initialSnapshot) {
    applySnapshotToTerminal(initialSnapshot);
  } else {
    syncButtons();
  }

  unsubscribeSidecarStatus = options.subscribeSidecarStatus((status) => {
    if (disposed) {
      return;
    }
    latestSidecarStatus = status;
    syncStatus();
  });

  unsubscribeZoom = options.subscribeToGraphZoomChanges?.(() => {
    if (disposed) {
      return;
    }
    queueResize();
  }) || null;

  if (options.refreshSidecarStatus) {
    void options.refreshSidecarStatus().then((status) => {
      if (disposed || !status) {
        return;
      }
      latestSidecarStatus = status;
      syncStatus();
    });
  } else {
    syncStatus();
  }

  void (async () => {
    try {
      const runtime = await loadXtermRuntime();
      if (disposed) {
        return;
      }

      const resolvedScrollback = resolveTerminalScrollback((options.node.config as Record<string, unknown>).scrollback);
      terminal = new runtime.TerminalCtor(buildStudioTerminalXtermOptions(resolvedScrollback));
      fitAddon = new runtime.FitAddonCtor();
      terminal.loadAddon(fitAddon);
      terminal.open(surfaceEl);

      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        const translatedInput = resolveStudioTerminalShortcutInput(event);
        if (!translatedInput) {
          return true;
        }
        event.preventDefault();
        event.stopPropagation();
        options.writeInput({
          projectPath: options.projectPath,
          nodeId: options.node.id,
          data: translatedInput,
        });
        return false;
      });

      try {
        fitAddon.fit();
      } catch {
        // Fit is best effort at startup.
      }

      inputDisposable = terminal.onData((data: string) => {
        options.writeInput({
          projectPath: options.projectPath,
          nodeId: options.node.id,
          data,
        });
      });

      surfaceEl.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        terminal?.focus();
      });

      surfaceEl.addEventListener("click", (event) => {
        event.stopPropagation();
        terminal?.focus();
      });

      if (latestSnapshot) {
        applySnapshotToTerminal(latestSnapshot);
      }

      resizeObserver = new ResizeObserver(() => {
        queueResize();
      });
      resizeObserver.observe(panelEl);
      queueResize();

      try {
        const peekSnapshot = await options.peekSession({
          projectPath: options.projectPath,
          nodeId: options.node.id,
        });
        if (peekSnapshot) {
          applySnapshotToTerminal(peekSnapshot);
        }
      } catch {
        // Peek is best effort.
      }

      await runWithCurrentConfig("ensure");
      terminal.focus();
    } catch (error) {
      if (disposed) {
        return;
      }
      healthDotEl.className = "ss-studio-terminal-health-dot is-failed";
      statusEl.setText("Failed");
      const message = error instanceof Error ? error.message : String(error);
      surfaceEl.createDiv({
        cls: "ss-studio-terminal-error",
        text: `Unable to load terminal runtime: ${message}`,
      });
    }
  })();

  return () => {
    disposed = true;
    if (pendingResizeTimer !== null) {
      window.clearTimeout(pendingResizeTimer);
      pendingResizeTimer = null;
    }
    unsubscribeZoom?.();
    unsubscribeZoom = null;
    unsubscribeSidecarStatus?.();
    unsubscribeSidecarStatus = null;
    unsubscribeSession?.();
    unsubscribeSession = null;
    lastSessionSize = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    inputDisposable?.dispose();
    inputDisposable = null;
    try {
      terminal?.dispose();
    } catch {
      // Best effort cleanup.
    }
    terminal = null;
    fitAddon = null;
    panelEl.remove();
  };
}
