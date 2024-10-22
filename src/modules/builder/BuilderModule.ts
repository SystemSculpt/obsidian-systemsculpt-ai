import SystemSculptPlugin from "../../main";
import {
  BuilderSettings,
  DEFAULT_BUILDER_SETTINGS,
} from "./settings/BuilderSettings";
import { BuilderSettingTab } from "./settings/BuilderSettingTab";
import { TFile, Notice, WorkspaceLeaf, Menu, MenuItem } from "obsidian";
import { NodeSettings } from "./NodeSettings";
import { BuilderMenu } from "./ui/BuilderMenu";
import { NodeCreator } from "./NodeCreator";
import { CanvasViewportManager } from "./CanvasViewportManager";
import { EdgeStyleManager } from "./edge/EdgeStyleManager";
import { logModuleLoadTime } from "../../utils/timing";

export class BuilderModule {
  plugin: SystemSculptPlugin;
  settings: BuilderSettings;
  lastActiveCanvasView: any | null = null;
  nodeSettings: NodeSettings;
  builderMenu: BuilderMenu;
  nodeCreator: NodeCreator;
  private canvasViewportManager: CanvasViewportManager;
  private overlayCheckInterval: number | null = null;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_BUILDER_SETTINGS;
    this.nodeSettings = new NodeSettings(this.plugin.app, this.plugin, () =>
      this.saveSettings()
    );
    this.builderMenu = new BuilderMenu(this.plugin.app, this);
    this.nodeCreator = new NodeCreator(
      this.nodeSettings,
      this.plugin.app.vault
    );
    this.canvasViewportManager = new CanvasViewportManager();
    this.loadSettings();
    this.canvasViewportManager.viewportPosition = { x: 0, y: 0, zoom: 1 };
  }

  async load() {
    const startTime = performance.now();
    await this.loadSettings();

    this.addCommands();
    this.applyCustomVisualsToAllCanvasViews();

    // Start the overlay check
    this.startOverlayCheck();

    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
        this.handleActiveLeafChange(leaf);
      })
    );

    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => {
        this.applyCustomVisualsToAllCanvasViews();
      })
    );

    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "canvas") {
          this.applyCustomVisualsToAllCanvasViews();
        }
      })
    );

    this.plugin.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
      const activeLeaf = this.plugin.app.workspace.activeLeaf;
      if (this.canvasViewportManager.handleCanvasKeyEvent(evt, activeLeaf)) {
        evt.preventDefault();
        evt.stopPropagation();
      }
    });

    // Update viewport position when switching to a canvas
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view.getViewType() === "canvas") {
          const canvasView = leaf.view as any;
          if (canvasView.canvas) {
            this.canvasViewportManager.updateViewportPosition(
              canvasView.canvas
            );
          }
        }
      })
    );

    logModuleLoadTime("Builder", startTime);
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_BUILDER_SETTINGS,
      await this.plugin.loadData()
    );
    this.nodeSettings.loadNodeData(this.settings.nodeData || {});
  }

  async saveSettings() {
    this.settings.nodeData = this.nodeSettings.getAllNodeData();
    await this.plugin.saveData(this.settings);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new BuilderSettingTab(this.plugin.app, this, containerEl).display();
  }

  private addCommands() {
    this.plugin.addCommand({
      id: "open-systemsculpt-ai-builder-canvas",
      name: "Open SystemSculpt AI Builder Canvas",
      callback: () => this.openBuilderCanvas(),
    });
  }

  private async openBuilderCanvas() {
    const fileName = `SystemSculpt AI Builder Canvas ${Date.now()}.canvas`;
    const filePath = `${this.settings.builderCanvasDirectory}/${fileName}`;

    await this.plugin.app.vault.adapter.mkdir(
      this.settings.builderCanvasDirectory
    );

    const file = await this.plugin.app.vault.create(filePath, "{}");

    if (file instanceof TFile) {
      const leaf = this.plugin.app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });

      await this.initializeCanvasContent(file);

      // Add this line to add the builder menu to the new canvas
      this.builderMenu.addBuilderMenuToCanvas(leaf.view);

      new Notice("SystemSculpt AI Builder Canvas created");
    }
  }

  private async initializeCanvasContent(file: TFile) {
    const initialContent = {
      nodes: [],
      edges: [],
      systemsculptAIBuilder: true,
      version: "1.0",
    };
    await this.plugin.app.vault.modify(
      file,
      JSON.stringify(initialContent, null, 2)
    );
  }

  private applyCustomVisualsToAllCanvasViews() {
    const canvasViews = this.plugin.app.workspace.getLeavesOfType("canvas");
    canvasViews.forEach((leaf) => {
      const canvasView = leaf.view as any;
      if (canvasView.canvas && canvasView.canvas.data.systemsculptAIBuilder) {
        this.builderMenu.addBuilderMenuToCanvas(canvasView);
        this.applyNodeClasses(canvasView);
        this.addPlusButtonsToCustomNodes(canvasView);
        this.applyNodeOverlaysToExistingNodes(canvasView);
        this.setupEdgeObserver(canvasView);
      }
    });
  }

  private setupEdgeObserver(canvasView: any) {
    const edgeManager = new EdgeStyleManager(canvasView);
    edgeManager.setupEdgeObserver();
  }

  private applyNodeOverlaysToExistingNodes(canvasView: any) {
    if (canvasView.canvas && canvasView.canvas.nodes) {
      canvasView.canvas.nodes.forEach((node: any) => {
        if (node.unknownData && node.unknownData.systemsculptNodeType) {
          const nodeType = node.unknownData.systemsculptNodeType;
          this.nodeCreator.applyNodeOverlay(node, nodeType);
        }
      });
    }
  }

  private handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
    if (leaf && leaf.view.getViewType() === "canvas") {
      const canvasView = leaf.view as any;
      this.lastActiveCanvasView = canvasView;
      console.log("Active canvas view set:", this.lastActiveCanvasView);
    } else {
      this.lastActiveCanvasView = null;
    }
  }

  private applyNodeClasses(canvasView: any) {
    if (canvasView.canvas && canvasView.canvas.nodes) {
      const existingIds = new Set();
      canvasView.canvas.nodes.forEach((node: any) => {
        if (node.unknownData && node.unknownData.systemsculptNodeType) {
          const nodeType = node.unknownData.systemsculptNodeType;
          let nodeId = node.unknownData.systemsculptNodeId;

          if (!nodeId || existingIds.has(nodeId)) {
            nodeId = this.nodeSettings.assignUniqueNodeId(node);
            node.unknownData.systemsculptNodeId = nodeId;
          }

          existingIds.add(nodeId);

          if (node.nodeEl) {
            node.nodeEl.classList.add(`systemsculpt-node-${nodeType}`);
            node.nodeEl.setAttribute("data-systemsculpt-node-id", nodeId);
          }
        }
      });

      this.saveCanvasData(canvasView);
    }
  }

  private addNodeToolbarToCustomNodes(canvasView: any) {
    const canvasNodes = canvasView.containerEl.querySelectorAll(".canvas-node");
    canvasNodes.forEach((node: HTMLElement) => {
      if (
        node.classList.contains("systemsculpt-node-input") ||
        node.classList.contains("systemsculpt-node-processing") ||
        node.classList.contains("systemsculpt-node-output")
      ) {
        this.addNodeToolbar(node);
      }
    });

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((addedNode) => {
            if (
              addedNode instanceof HTMLElement &&
              addedNode.classList.contains("canvas-node")
            ) {
              if (
                addedNode.classList.contains("systemsculpt-node-input") ||
                addedNode.classList.contains("systemsculpt-node-processing") ||
                addedNode.classList.contains("systemsculpt-node-output")
              ) {
                this.addNodeToolbar(addedNode);
              }
            }
          });
        }
      });
    });

    observer.observe(canvasView.containerEl, {
      childList: true,
      subtree: true,
    });
  }

  private addNodeToolbar(node: HTMLElement) {
    if (node.querySelector(".systemsculpt-node-toolbar")) return;

    const toolbar = document.createElement("div");
    toolbar.className = "systemsculpt-node-toolbar";

    const plusButton = this.createToolbarButton("+", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showContextMenu(e, node);
    });

    toolbar.appendChild(plusButton);

    node.appendChild(toolbar);
  }

  private createToolbarButton(
    text: string,
    onClick: (e: MouseEvent) => void
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "systemsculpt-toolbar-button";
    button.textContent = text;
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(e);
    });
    return button;
  }

  public addPlusButtonsToCustomNodes(canvasView: any) {
    this.addNodeToolbarToCustomNodes(canvasView);
  }

  private showContextMenu(event: MouseEvent, node: HTMLElement) {
    const menu = new Menu();

    menu.addItem((item: MenuItem) => {
      item.setTitle("Add Input Node").onClick(() => {
        this.addNode(node, "input");
      });
    });

    menu.addItem((item: MenuItem) => {
      item.setTitle("Add Processing Node").onClick(() => {
        this.addNode(node, "processing");
      });
    });

    menu.addItem((item: MenuItem) => {
      item.setTitle("Add Output Node").onClick(() => {
        this.addNode(node, "output");
      });
    });

    menu.showAtMouseEvent(event);
  }

  public addNode(
    parentNode: HTMLElement | null,
    nodeType: "input" | "processing" | "output"
  ) {
    const canvasView = this.getCanvasView(parentNode);
    this.nodeCreator.addNode(canvasView, parentNode, nodeType);
  }

  private getCanvasView(node: HTMLElement | null): any | null {
    if (this.lastActiveCanvasView) {
      return this.lastActiveCanvasView;
    }

    if (node) {
      let current: HTMLElement | null = node;
      while (current && !current.classList.contains("canvas-wrapper")) {
        current = current.parentElement;
      }
      if (current) {
        const canvasView = (current as any).__vue__;
        if (canvasView) {
          this.lastActiveCanvasView = canvasView;
          return canvasView;
        }
      }
    }

    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    if (activeLeaf && activeLeaf.view.getViewType() === "canvas") {
      const canvasView = activeLeaf.view as any;
      this.lastActiveCanvasView = canvasView;
      return canvasView;
    }

    console.error("Canvas view not found");
    return null;
  }

  private saveCanvasData(canvasView: any) {
    if (
      canvasView.canvas &&
      typeof canvasView.canvas.requestSave === "function"
    ) {
      canvasView.canvas.requestSave();
    }
  }

  private startOverlayCheck() {
    // Clear any existing interval
    if (this.overlayCheckInterval) {
      window.clearInterval(this.overlayCheckInterval);
    }

    // Check every 1 second
    this.overlayCheckInterval = window.setInterval(() => {
      const canvasViews = this.plugin.app.workspace.getLeavesOfType("canvas");
      canvasViews.forEach((leaf) => {
        const canvasView = leaf.view as any;
        if (canvasView.canvas && canvasView.canvas.data.systemsculptAIBuilder) {
          this.checkAndLoadMissingOverlays(canvasView);
        }
      });
    }, 1000);
  }

  private checkAndLoadMissingOverlays(canvasView: any) {
    if (canvasView.canvas && canvasView.canvas.nodes) {
      canvasView.canvas.nodes.forEach((node: any) => {
        if (
          node.unknownData?.systemsculptNodeType &&
          node.nodeEl &&
          !node.nodeEl.querySelector(".systemsculpt-node-overlay")
        ) {
          console.log(
            `Reloading missing overlay for node type: ${node.unknownData.systemsculptNodeType}`
          );
          const nodeType = node.unknownData.systemsculptNodeType;
          this.nodeCreator.applyNodeOverlay(node, nodeType);
        }
      });
    }
  }

  unload() {
    if (this.overlayCheckInterval) {
      window.clearInterval(this.overlayCheckInterval);
      this.overlayCheckInterval = null;
    }
  }
}
