import { Modal, App } from "obsidian";

export class NodeSettings {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  public showNodeSettingsModal(
    node: HTMLElement,
    getNodeType: (node: HTMLElement) => string,
    assignUniqueNodeId: (node: any) => string,
    saveCanvasData: (canvasView: any) => void
  ) {
    const nodeType = getNodeType(node);
    const modal = new Modal(this.app);

    const titleContainer = modal.titleEl.createDiv(
      "systemsculpt-node-settings-title-container"
    );

    titleContainer.createEl("h2", {
      text: `${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)} Node Settings`,
      cls: "systemsculpt-node-settings-title",
    });

    const nodeId =
      node.getAttribute("data-systemsculpt-node-id") ||
      assignUniqueNodeId(node);

    titleContainer.createEl("p", {
      text: `Node ID: ${nodeId}`,
      cls: "systemsculpt-node-id",
    });

    const content = modal.contentEl.createDiv("systemsculpt-node-settings");

    switch (nodeType) {
      case "input":
        this.createInputNodeSettings(content, nodeId);
        break;
      case "processing":
        this.createProcessingNodeSettings(content, nodeId);
        break;
      case "output":
        this.createOutputNodeSettings(content, nodeId);
        break;
    }

    modal.open();
  }

  public getNodeType(node: HTMLElement): "input" | "processing" | "output" {
    if (node.classList.contains("systemsculpt-node-input")) return "input";
    if (node.classList.contains("systemsculpt-node-processing"))
      return "processing";
    if (node.classList.contains("systemsculpt-node-output")) return "output";
    return "input";
  }

  public assignUniqueNodeId(node: any): string {
    if (!node.unknownData || !node.unknownData.systemsculptNodeId) {
      const nodeId = `systemsculpt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      if (!node.unknownData) {
        node.unknownData = {};
      }
      node.unknownData.systemsculptNodeId = nodeId;
    }
    return node.unknownData.systemsculptNodeId;
  }

  private createInputNodeSettings(container: HTMLElement, nodeId: string) {
    container.createEl("h3", { text: "Input Source" });
    const select = container.createEl("select");
    select.createEl("option", { value: "file", text: "File" });
    select.createEl("option", { value: "user_input", text: "User Input" });
    select.createEl("option", { value: "api", text: "API" });
  }

  private createProcessingNodeSettings(container: HTMLElement, nodeId: string) {
    container.createEl("h3", { text: "Processing Type" });
    const select = container.createEl("select");
    select.createEl("option", {
      value: "text_analysis",
      text: "Text Analysis",
    });
    select.createEl("option", {
      value: "data_transformation",
      text: "Data Transformation",
    });
    select.createEl("option", { value: "ai_model", text: "AI Model" });
  }

  private createOutputNodeSettings(container: HTMLElement, nodeId: string) {
    container.createEl("h3", { text: "Output Destination" });
    const select = container.createEl("select");
    select.createEl("option", { value: "file", text: "File" });
    select.createEl("option", { value: "display", text: "Display" });
    select.createEl("option", { value: "api", text: "API" });
  }
}
