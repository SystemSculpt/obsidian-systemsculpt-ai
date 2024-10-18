import SystemSculptPlugin from "../../main";
import {
  BuilderSettings,
  DEFAULT_BUILDER_SETTINGS,
} from "./settings/BuilderSettings";
import { BuilderSettingTab } from "./settings/BuilderSettingTab";
import { TFile, Notice, WorkspaceLeaf, Menu, MenuItem } from "obsidian";

export class BuilderModule {
  plugin: SystemSculptPlugin;
  settings: BuilderSettings;
  lastActiveCanvasView: any | null = null;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_BUILDER_SETTINGS;
  }

  async load() {
    await this.loadSettings();
    this.addCommands();

    // Add event listener for when the active leaf changes
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
        this.handleActiveLeafChange(leaf);
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

  private handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
    if (leaf && leaf.view.getViewType() === "canvas") {
      const canvasView = leaf.view as any;
      this.lastActiveCanvasView = canvasView;
      if (canvasView.canvas && canvasView.canvas.data.systemsculptAIBuilder) {
        this.addBuilderMenuToCanvas(canvasView);
      } else {
        this.removeBuilderMenuFromCanvas(canvasView);
      }
      console.log("Active canvas view set:", this.lastActiveCanvasView);
    } else {
      this.lastActiveCanvasView = null;
      this.removeBuilderMenuFromCanvas();
    }
  }

  private addBuilderMenuToCanvas(canvasView: any) {
    const canvasContainer =
      canvasView.containerEl.querySelector(".canvas-wrapper");
    if (!canvasContainer) return;

    // Remove existing builder menu if it's there
    this.removeBuilderMenuFromCanvas(canvasView);

    const builderMenu = canvasContainer.createDiv("systemsculpt-builder-menu");
    builderMenu.style.position = "absolute";
    builderMenu.style.top = "10px";
    builderMenu.style.left = "10px";
    builderMenu.style.zIndex = "1000";

    const aiButton = builderMenu.createEl("button", {
      cls: "systemsculpt-builder-ai-button",
      text: "SSAI Settings",
    });

    aiButton.addEventListener("click", () => {
      console.log("Hello! Button is working!");
    });

    // Add the plus button to focused nodes
    this.addPlusButtonToFocusedNodes(canvasView);
  }

  private removeBuilderMenuFromCanvas(canvasView?: any) {
    const container = canvasView ? canvasView.containerEl : document;

    const existingBuilderMenu = container.querySelector(
      ".systemsculpt-builder-menu"
    );
    if (existingBuilderMenu) {
      existingBuilderMenu.remove();
    }
  }

  private addPlusButtonToFocusedNodes(canvasView: any) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "class"
        ) {
          const node = mutation.target as HTMLElement;
          if (
            node.classList.contains("canvas-node") &&
            node.classList.contains("is-focused")
          ) {
            this.addPlusButtonToNode(node);
          } else {
            this.removePlusButtonFromNode(node);
          }
        }
      });
    });

    const canvasNodes = canvasView.containerEl.querySelectorAll(".canvas-node");
    canvasNodes.forEach((node: HTMLElement) => {
      observer.observe(node, { attributes: true });
    });
  }

  private addPlusButtonToNode(node: HTMLElement) {
    if (node.querySelector(".systemsculpt-plus-button")) return;

    const plusButton = document.createElement("button");
    plusButton.className = "systemsculpt-plus-button";
    plusButton.textContent = "+";
    plusButton.style.position = "absolute";
    plusButton.style.bottom = "-40px";
    plusButton.style.right = "-50px";
    plusButton.style.zIndex = "1001";

    plusButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showContextMenu(e, node);
    });

    node.appendChild(plusButton);
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

  private removePlusButtonFromNode(node: HTMLElement) {
    const plusButton = node.querySelector(".systemsculpt-plus-button");
    if (plusButton) {
      plusButton.remove();
    }
  }

  private addNode(
    parentNode: HTMLElement,
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

    // Get the parent node's position
    const transformStyle = parentNode.style.transform;
    const matches = transformStyle.match(
      /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/
    );

    let parentNodePosition = { x: 0, y: 0 };
    if (matches && matches.length === 3) {
      parentNodePosition = {
        x: parseFloat(matches[1]),
        y: parseFloat(matches[2]),
      };
    } else {
      console.error("Unable to parse parent node position");
    }

    console.log("Parent node position:", parentNodePosition);

    // Set the position for the new node
    newNodeData.pos = {
      x: parentNodePosition.x + 300,
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

      // Trigger a canvas update
      canvasView.canvas.requestSave();
    } else {
      console.error("Canvas or createTextNode method not found");
    }
  }

  private getCanvasView(node: HTMLElement): any {
    if (this.lastActiveCanvasView) {
      return this.lastActiveCanvasView;
    }

    let current = node;
    while (current && !current.classList.contains("canvas-wrapper")) {
      // @ts-ignore
      current = current.parentElement;
    }
    if (current) {
      const canvasView = (current as any).__vue__;
      if (canvasView) {
        this.lastActiveCanvasView = canvasView;
        return canvasView;
      }
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
      class: `systemsculpt-node-${nodeType}`,
    };
  }
}
