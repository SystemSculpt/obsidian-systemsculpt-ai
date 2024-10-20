import { Modal, setIcon, App } from "obsidian";

export class BuilderMenu {
  private app: App;
  private plugin: any;

  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }

  public addBuilderMenuToCanvas(canvasView: any) {
    const canvasContainer =
      canvasView.containerEl.querySelector(".canvas-wrapper");
    if (!canvasContainer) return;

    this.removeBuilderMenuFromCanvas(canvasView);

    const builderMenu = canvasContainer.createDiv({
      cls: "systemsculpt-builder-menu",
    });

    builderMenu.createEl("div", {
      cls: "systemsculpt-builder-label",
      text: "General",
    });

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

    builderMenu.createEl("hr", { cls: "systemsculpt-builder-separator" });

    builderMenu.createEl("div", {
      cls: "systemsculpt-builder-label",
      text: "Add Node",
    });

    const inputNodeButton = builderMenu.createEl("button", {
      cls: "systemsculpt-builder-button",
      text: "Input Node",
    });
    inputNodeButton.addEventListener("click", () => {
      this.plugin.addNode(null, "input");
    });

    const processingNodeButton = builderMenu.createEl("button", {
      cls: "systemsculpt-builder-button",
      text: "Processing Node",
    });
    processingNodeButton.addEventListener("click", () => {
      this.plugin.addNode(null, "processing");
    });

    const outputNodeButton = builderMenu.createEl("button", {
      cls: "systemsculpt-builder-button",
      text: "Output Node",
    });
    outputNodeButton.addEventListener("click", () => {
      this.plugin.addNode(null, "output");
    });

    this.plugin.addPlusButtonsToCustomNodes(canvasView);
  }

  private showNodeTypesInfo() {
    const modal = new Modal(this.app);
    modal.titleEl.setText("SystemSculpt AI Builder Node Types");
    modal.titleEl.addClass("systemsculpt-node-info-title");

    const content = document.createDocumentFragment();

    const nodeTypes = [
      {
        title: "Input Nodes",
        description:
          "Input nodes are the starting points of your AI workflow. They represent the data or information you want to process.",
        examples: [
          "Vault files",
          "User input or variables",
          "Output responses",
        ],
        icon: "file-input",
      },
      {
        title: "Processing Nodes",
        description:
          "Processing nodes perform operations on the data from input nodes or other processing nodes. They represent the core AI and data manipulation tasks.",
        examples: [
          "System prompts",
          "Data transformation",
          "AI model execution",
        ],
        icon: "cpu",
      },
      {
        title: "Output Nodes",
        description:
          "Output nodes represent the final results or actions of your AI workflow. They determine how the processed information is used or presented.",
        examples: [
          "Save results to a file",
          "Display in the UI",
          "Trigger external actions",
        ],
        icon: "file-output",
      },
    ];

    nodeTypes.forEach((nodeType) => {
      content.appendChild(this.createNodeTypeInfo(nodeType));
    });

    modal.contentEl.appendChild(content);
    modal.open();
  }

  private createNodeTypeInfo(nodeType: {
    title: string;
    description: string;
    examples: string[];
    icon: string;
  }): HTMLElement {
    const container = document.createElement("div");
    container.className = "systemsculpt-node-info";

    const header = container.createEl("div", {
      cls: "systemsculpt-node-info-header",
    });
    setIcon(
      header.createSpan({ cls: "systemsculpt-node-info-icon" }),
      nodeType.icon
    );
    header.createEl("h3", { text: nodeType.title });

    const descEl = container.createEl("p", { text: nodeType.description });

    const examplesTitle = container.createEl("h4", { text: "Examples:" });
    const examplesList = container.createEl("ul");
    nodeType.examples.forEach((example) => {
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
}
