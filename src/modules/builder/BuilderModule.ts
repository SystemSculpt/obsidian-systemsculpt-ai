import SystemSculptPlugin from "../../main";
import {
  BuilderSettings,
  DEFAULT_BUILDER_SETTINGS,
} from "./settings/BuilderSettings";
import { BuilderSettingTab } from "./settings/BuilderSettingTab";
import { TFile, Notice, WorkspaceLeaf, Menu, MenuItem, Modal } from "obsidian";

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
        this.addBuilderMenuToCanvas(canvasView);
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
      canvasView.canvas.nodes.forEach((node: any) => {
        if (node.unknownData && node.unknownData.systemsculptNodeType) {
          const nodeType = node.unknownData.systemsculptNodeType;
          if (node.nodeEl) {
            node.nodeEl.classList.add(`systemsculpt-node-${nodeType}`);
          }
        }
      });
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

    const infoButton = builderMenu.createEl("button", {
      cls: "systemsculpt-builder-info-button",
      text: "Node Types Info",
    });

    infoButton.addEventListener("click", () => {
      this.showNodeTypesInfo();
    });

    // Add the plus button to focused nodes
    this.addPlusButtonsToCustomNodes(canvasView);
  }

  private showNodeTypesInfo() {
    const modal = new Modal(this.plugin.app);
    modal.titleEl.setText("SystemSculpt AI Builder Node Types");

    const content = document.createDocumentFragment();
    content.appendChild(
      this.createNodeTypeInfo(
        "Input Nodes",
        "Input nodes are the starting points of your AI workflow. They represent the data or information you want to process.",
        ["Vault files", "User input or variables", "Output responses"]
      )
    );
    content.appendChild(
      this.createNodeTypeInfo(
        "Processing Nodes",
        "Processing nodes perform operations on the data from input nodes or other processing nodes. They represent the core AI and data manipulation tasks.",
        ["System prompts"]
      )
    );
    content.appendChild(
      this.createNodeTypeInfo(
        "Output Nodes",
        "Output nodes represent the final results or actions of your AI workflow. They determine how the processed information is used or presented.",
        ["Save results to a file"]
      )
    );

    modal.contentEl.appendChild(content);
    modal.open();
  }

  private createNodeTypeInfo(
    title: string,
    description: string,
    examples: string[]
  ): HTMLElement {
    const container = document.createElement("div");
    container.addClass("systemsculpt-node-info");

    const titleEl = container.createEl("h3");
    titleEl.setText(title);

    const descEl = container.createEl("p");
    descEl.setText(description);

    const examplesTitle = container.createEl("h4");
    examplesTitle.setText("Examples:");

    const examplesList = container.createEl("ul");
    examples.forEach((example) => {
      const li = examplesList.createEl("li");
      li.setText(example);
    });

    return container;
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

  private addPlusButtonsToCustomNodes(canvasView: any) {
    const canvasNodes = canvasView.containerEl.querySelectorAll(".canvas-node");
    canvasNodes.forEach((node: HTMLElement) => {
      if (
        node.classList.contains("systemsculpt-node-input") ||
        node.classList.contains("systemsculpt-node-processing") ||
        node.classList.contains("systemsculpt-node-output")
      ) {
        this.addPlusButtonToNode(node);
      }
    });

    // Set up an observer to add plus buttons to new nodes
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
                this.addPlusButtonToNode(addedNode);
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

      // Add the class directly to the new node after a short delay
      setTimeout(() => {
        this.addClassToNewNode(newNode, nodeType);
        this.saveCanvasData(canvasView);
      }, 100);

      // Trigger a canvas update
      canvasView.canvas.requestSave();
    } else {
      console.error("Canvas or createTextNode method not found");
    }
  }

  private addClassToNewNode(newNode: any, nodeType: string) {
    if (newNode && newNode.nodeEl) {
      newNode.nodeEl.classList.add(`systemsculpt-node-${nodeType}`);
      if (!newNode.unknownData) {
        newNode.unknownData = {};
      }
      newNode.unknownData.systemsculptNodeType = nodeType;
      console.log(`Class added to node: systemsculpt-node-${nodeType}`);
    } else {
      console.error("Unable to add class to new node:", newNode);
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
}
