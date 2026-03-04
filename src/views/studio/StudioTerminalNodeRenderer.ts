import { Notice } from "obsidian";
import type {
  StudioTerminalSessionListener,
  StudioTerminalSessionRequest,
  StudioTerminalSessionSnapshot,
} from "../../studio/StudioTerminalSessionManager";
import { tryCopyToClipboard } from "../../utils/clipboard";
import {
  applyTerminalNodeSize,
  clampTerminalInt,
  fallbackTerminalGridDimensions,
  readTerminalSessionRequest,
  resolveTerminalScrollback,
} from "./terminal/StudioTerminalNodeConfig";
import { mountTerminalResizeHandle } from "./terminal/StudioTerminalResizeHandle";
import {
  buildStudioTerminalXtermOptions,
  loadXtermRuntime,
  STUDIO_TERMINAL_FONT_FAMILY,
} from "./terminal/StudioTerminalXterm";
import type { StudioTerminalNodeMountOptions } from "./terminal/StudioTerminalNodeTypes";

export { STUDIO_TERMINAL_FONT_FAMILY, buildStudioTerminalXtermOptions } from "./terminal/StudioTerminalXterm";
export type { StudioTerminalNodeMountOptions } from "./terminal/StudioTerminalNodeTypes";

export function mountStudioTerminalNode(options: StudioTerminalNodeMountOptions): () => void {
  applyTerminalNodeSize(options.node, options.nodeEl);

  const panelEl = options.nodeEl.createDiv({ cls: "ss-studio-terminal-panel" });
  const toolbarEl = panelEl.createDiv({ cls: "ss-studio-terminal-toolbar" });
  const statusEl = toolbarEl.createDiv({ cls: "ss-studio-terminal-status is-idle", text: "Idle" });
  const actionsEl = toolbarEl.createDiv({ cls: "ss-studio-terminal-actions" });

  const startButton = actionsEl.createEl("button", { text: "Start", cls: "ss-studio-terminal-action" });
  const stopButton = actionsEl.createEl("button", { text: "Stop", cls: "ss-studio-terminal-action" });
  const clearButton = actionsEl.createEl("button", { text: "Clear", cls: "ss-studio-terminal-action" });
  const copyButton = actionsEl.createEl("button", { text: "Copy", cls: "ss-studio-terminal-action" });
  startButton.type = "button";
  stopButton.type = "button";
  clearButton.type = "button";
  copyButton.type = "button";

  const surfaceEl = panelEl.createDiv({ cls: "ss-studio-terminal-surface" });
  const disposeResizeHandle = mountTerminalResizeHandle({
    node: options.node,
    nodeEl: options.nodeEl,
    interactionLocked: options.interactionLocked,
    onNodeConfigMutated: options.onNodeConfigMutated,
    onNodeGeometryMutated: options.onNodeGeometryMutated,
    getGraphZoom: options.getGraphZoom,
  });

  let disposed = false;
  let terminal: import("@xterm/xterm").Terminal | null = null;
  let fitAddon: import("@xterm/addon-fit").FitAddon | null = null;
  let unsubscribeSession: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let inputDisposable: { dispose: () => void } | null = null;
  let latestSnapshot: StudioTerminalSessionSnapshot | null = null;
  let appliedHistoryRevision: number | null = null;
  let pendingResizeTimer: number | null = null;

  const syncButtons = (): void => {
    const status = latestSnapshot?.status || "idle";
    statusEl.className = `ss-studio-terminal-status is-${status}`;
    statusEl.setText(status === "running" ? "Running" : status.charAt(0).toUpperCase() + status.slice(1));
    startButton.disabled = options.interactionLocked || status === "starting";
    startButton.setText(status === "running" ? "Restart" : "Start");
    stopButton.disabled = options.interactionLocked || (status !== "running" && status !== "starting");
    clearButton.disabled = options.interactionLocked;
    copyButton.disabled =
      options.interactionLocked ||
      !latestSnapshot ||
      (latestSnapshot.history.trim().length === 0 && latestSnapshot.errorMessage.trim().length === 0);
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
    }
    pendingResizeTimer = window.setTimeout(() => {
      pendingResizeTimer = null;
      if (!fitAddon || !terminal) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {}
      if (typeof fitAddon.proposeDimensions === "function") {
        const proposed = fitAddon.proposeDimensions();
        if (proposed) {
          options.resizeSession({
            projectPath: options.projectPath,
            nodeId: options.node.id,
            cols: clampTerminalInt(proposed.cols, 120, 20, 1000),
            rows: clampTerminalInt(proposed.rows, 30, 8, 600),
          });
        }
      }
    }, 80);
  };

  startButton.addEventListener("click", (event) => {
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

  clearButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.clearSessionHistory({
      projectPath: options.projectPath,
      nodeId: options.node.id,
    });
    if (terminal) {
      terminal.reset();
    }
  });

  copyButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = latestSnapshot?.history || latestSnapshot?.errorMessage || "";
    if (!text) {
      return;
    }
    void (async () => {
      const copied = await tryCopyToClipboard(text);
      new Notice(copied ? "Terminal output copied." : "Unable to copy terminal output.");
    })();
  });

  unsubscribeSession = options.subscribe({ projectPath: options.projectPath, nodeId: options.node.id }, (sessionEvent) => {
    if (disposed) {
      return;
    }
    if (sessionEvent.type === "snapshot") {
      applySnapshotToTerminal(sessionEvent.snapshot);
      return;
    }
    pushDataToTerminal(sessionEvent.data, sessionEvent.historyRevision);
  });

  const initialSnapshot = options.getSnapshot({
    projectPath: options.projectPath,
    nodeId: options.node.id,
  });
  if (initialSnapshot) {
    applySnapshotToTerminal(initialSnapshot);
  } else {
    syncButtons();
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
      try {
        fitAddon.fit();
      } catch {}
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
      await runWithCurrentConfig("ensure");
      terminal.focus();
    } catch (error) {
      if (disposed) {
        return;
      }
      statusEl.className = "ss-studio-terminal-status is-failed";
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
    unsubscribeSession?.();
    unsubscribeSession = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    inputDisposable?.dispose();
    inputDisposable = null;
    try {
      terminal?.dispose();
    } catch {}
    terminal = null;
    fitAddon = null;
    disposeResizeHandle();
  };
}
