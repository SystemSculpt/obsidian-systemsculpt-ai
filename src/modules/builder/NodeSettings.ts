import { Modal, App, TFile } from "obsidian";
import { MultiSuggest } from "../../utils/MultiSuggest";

interface NodeData {
  inputSource?: string;
  inputFile?: string;
  // Add more properties as needed for different node types
}

export class NodeSettings {
  public app: App; // Make this public so it can be accessed by NodeOverlay
  private nodeData: Map<string, NodeData> = new Map();
  private saveCallback: () => void;

  constructor(app: App, saveCallback: () => void) {
    this.app = app;
    this.saveCallback = saveCallback;
  }

  public showNodeSettingsModal(
    node: HTMLElement,
    getNodeType: (node: HTMLElement) => string,
    assignUniqueNodeId: (node: any) => string
  ) {
    const nodeType = getNodeType(node);
    const modal = new Modal(this.app);

    const titleContainer = modal.titleEl.createDiv(
      "systemsculpt-node-settings-title-container"
    );
    titleContainer.createEl("h2", { text: `${nodeType} Node Settings` });

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
    return "input"; // Default to input if no matching class is found
  }

  public assignUniqueNodeId(node: any): string {
    const nodeId = `systemsculpt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    if (!node.unknownData) {
      node.unknownData = {};
    }
    node.unknownData.systemsculptNodeId = nodeId;
    this.updateNodeData(nodeId, {}); // Initialize empty data for the new node
    return nodeId;
  }

  private createInputNodeSettings(container: HTMLElement, nodeId: string) {
    const data = this.getNodeData(nodeId);

    container.createEl("h3", { text: "Input Source" });
    const select = container.createEl("select");
    select.createEl("option", { value: "file", text: "File" });
    select.createEl("option", { value: "user_input", text: "User Input" });
    select.createEl("option", { value: "api", text: "API" });

    select.value = data.inputSource || "file";

    const filePickerContainer = container.createEl("div", {
      cls: "systemsculpt-file-picker-container",
    });
    filePickerContainer.createEl("label", { text: "Select Input File:" });
    const filePickerInput = filePickerContainer.createEl("input", {
      type: "text",
      placeholder: "Choose a file...",
      value: data.inputFile || "",
    });

    const files = this.app.vault.getFiles();
    const fileSuggestions = new Set(files.map((file) => file.path));

    new MultiSuggest(
      filePickerInput,
      fileSuggestions,
      (selectedPath: string) => {
        this.updateNodeData(nodeId, { inputFile: selectedPath });
      },
      this.app
    );

    select.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      this.updateNodeData(nodeId, { inputSource: target.value });
      filePickerContainer.style.display =
        target.value === "file" ? "block" : "none";
    });

    filePickerContainer.style.display =
      select.value === "file" ? "block" : "none";
  }

  private createProcessingNodeSettings(container: HTMLElement, nodeId: string) {
    // Implement processing node settings
  }

  private createOutputNodeSettings(container: HTMLElement, nodeId: string) {
    // Implement output node settings
  }

  public getNodeData(nodeId: string): NodeData {
    if (!this.nodeData.has(nodeId)) {
      this.nodeData.set(nodeId, {});
    }
    return this.nodeData.get(nodeId)!;
  }

  public updateNodeData(nodeId: string, newData: Partial<NodeData>) {
    const currentData = this.getNodeData(nodeId);
    this.nodeData.set(nodeId, { ...currentData, ...newData });
    this.saveNodeData();
  }

  private saveNodeData() {
    this.saveCallback();
  }

  public loadNodeData(data: { [nodeId: string]: NodeData }) {
    this.nodeData = new Map(Object.entries(data));
  }

  public getAllNodeData(): { [nodeId: string]: NodeData } {
    return Object.fromEntries(this.nodeData);
  }
}
