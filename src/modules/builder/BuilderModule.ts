import SystemSculptPlugin from "../../main";
import {
  BuilderSettings,
  DEFAULT_BUILDER_SETTINGS,
} from "./settings/BuilderSettings";
import { BuilderSettingTab } from "./settings/BuilderSettingTab";
import { TFile, Notice, WorkspaceLeaf, Menu, MenuItem } from "obsidian";
import { NodeSettings } from "./NodeSettings";
import { BuilderMenu } from "./ui/BuilderMenu";

export class BuilderModule {
  plugin: SystemSculptPlugin;
  settings: BuilderSettings;
  lastActiveCanvasView: any | null = null;
  nodeSettings: NodeSettings;
  builderMenu: BuilderMenu;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_BUILDER_SETTINGS;
    this.nodeSettings = new NodeSettings(this.plugin.app);
    this.builderMenu = new BuilderMenu(this.plugin.app, this);
  }

  async load() {
    await this.loadSettings();
    this.addCommands();

    // Apply custom visuals to all canvas views on plugin load
    this.applyCustomVisualsToAllCanvasViews();

    // Add event listener for when the active leaf changes
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
        this.handleActiveLeafChange(leaf);
      })
    );

    // Add event listener for layout changes
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => {
        this.applyCustomVisualsToAllCanvasViews();
      })
    );

    // Add event listener for file changes
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "canvas") {
          this.applyCustomVisualsToAllCanvasViews();
        }
      })
    );
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_BUILDER_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveSettings(this.settings);
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

    // Ensure the directory exists
    await this.plugin.app.vault.adapter.mkdir(
      this.settings.builderCanvasDirectory
    );

    const file = await this.plugin.app.vault.create(filePath, "{}");

    if (file instanceof TFile) {
      const leaf = this.plugin.app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });

      // Optionally, you can add some initial content to the canvas
      await this.initializeCanvasContent(file);

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
      }
    });
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

          // Check if the ID already exists or is not set
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

      // Save the updated canvas data
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

    // Set up an observer to add toolbars to new nodes
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
    toolbar.style.position = "absolute";
    toolbar.style.bottom = "-40px";
    toolbar.style.right = "-50px";
    toolbar.style.zIndex = "1001";
    toolbar.style.display = "flex";
    toolbar.style.gap = "5px";

    // Add plus button
    const plusButton = this.createToolbarButton("+", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showContextMenu(e, node);
    });

    // Add gear button
    const gearButton = this.createToolbarButton("⚙️", () => {
      this.nodeSettings.showNodeSettingsModal(
        node,
        this.nodeSettings.getNodeType.bind(this.nodeSettings),
        this.nodeSettings.assignUniqueNodeId.bind(this.nodeSettings),
        this.saveCanvasData.bind(this)
      );
    });

    toolbar.appendChild(plusButton);
    toolbar.appendChild(gearButton);

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
    console.log("Adding node. Parent node:", parentNode);
    console.log("Node type:", nodeType);

    const canvasView = this.getCanvasView(parentNode);
    if (!canvasView) {
      console.error("No active canvas view found");
      return;
    }

    console.log("Canvas view:", canvasView);

    const newNodeData = this.createNodeData(nodeType);

    // Assign a unique ID to the new node
    const nodeId = this.nodeSettings.assignUniqueNodeId(newNodeData);

    // Get the parent node's position or use the position of the most recently added node
    let parentNodePosition = { x: 0, y: 0 };
    if (parentNode) {
      parentNodePosition = this.getNodePosition(parentNode);
    } else {
      parentNodePosition = this.getMostRecentNodePosition(canvasView);
    }

    console.log("Parent node position:", parentNodePosition);

    // Set the position for the new node
    newNodeData.pos = {
      x: parentNodePosition.x + 275,
      y: parentNodePosition.y,
    };

    console.log("New node data:", newNodeData);

    // Add the new node to the canvas
    if (
      canvasView.canvas &&
      typeof canvasView.canvas.createTextNode === "function"
    ) {
      const newNode = canvasView.canvas.createTextNode(newNodeData);
      console.log("New node created:", newNode);

      // Add the class and save node data directly to the new node after a short delay
      setTimeout(() => {
        this.addClassAndDataToNewNode(newNode, nodeType, nodeId);
        this.saveCanvasData(canvasView);
      }, 100);

      // Trigger a canvas update
      canvasView.canvas.requestSave();
    } else {
      console.error("Canvas or createTextNode method not found");
    }
  }

  private addClassAndDataToNewNode(
    newNode: any,
    nodeType: string,
    nodeId: string
  ) {
    if (newNode && newNode.nodeEl) {
      newNode.nodeEl.classList.add(`systemsculpt-node-${nodeType}`);
      if (!newNode.unknownData) {
        newNode.unknownData = {};
      }
      newNode.unknownData.systemsculptNodeType = nodeType;
      newNode.unknownData.systemsculptNodeId = nodeId;
      console.log(
        `Class and data added to node: systemsculpt-node-${nodeType}, ID: ${nodeId}`
      );
    } else {
      console.error("Unable to add class and data to new node:", newNode);
    }
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

    // If no node is provided or canvas view is not found, try to get the active canvas view
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    if (activeLeaf && activeLeaf.view.getViewType() === "canvas") {
      const canvasView = activeLeaf.view as any;
      this.lastActiveCanvasView = canvasView;
      return canvasView;
    }

    console.error("Canvas view not found");
    return null;
  }

  private createNodeData(nodeType: "input" | "processing" | "output") {
    const nodeColors = {
      input: "#b5e8d5",
      processing: "#f8d775",
      output: "#f3a683",
    };

    return {
      text: `# ${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)} Node\n\nAdd your content here`,
      size: {
        width: 250,
        height: 120,
      },
      pos: {
        x: 0,
        y: 0,
      },
      color: nodeColors[nodeType],
      systemsculptNodeType: nodeType,
      id: `systemsculpt-${nodeType}-${Date.now()}`,
    };
  }

  private saveCanvasData(canvasView: any) {
    if (
      canvasView.canvas &&
      typeof canvasView.canvas.requestSave === "function"
    ) {
      canvasView.canvas.requestSave();
    }
  }

  private getNodePosition(node: HTMLElement): { x: number; y: number } {
    const transformStyle = node.style.transform;
    const matches = transformStyle.match(
      /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/
    );

    if (matches && matches.length === 3) {
      return {
        x: parseFloat(matches[1]),
        y: parseFloat(matches[2]),
      };
    } else {
      console.error("Unable to parse node position");
      return { x: 0, y: 0 };
    }
  }

  private getMostRecentNodePosition(canvasView: any): { x: number; y: number } {
    let mostRecentTimestamp = 0;
    let mostRecentPosition = { x: 0, y: 0 };

    canvasView.canvas.nodes.forEach((node: any) => {
      if (node.unknownData && node.unknownData.systemsculptNodeId) {
        const timestamp = parseInt(
          node.unknownData.systemsculptNodeId.split("-")[1]
        );
        if (timestamp > mostRecentTimestamp) {
          mostRecentTimestamp = timestamp;
          mostRecentPosition = this.getNodePosition(node.nodeEl);
        }
      }
    });

    return mostRecentPosition;
  }
}
