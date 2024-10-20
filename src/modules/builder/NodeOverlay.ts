import { TFile, Vault } from "obsidian";
import { NodeSettings } from "./NodeSettings";

export class NodeOverlay {
  private element: HTMLElement;
  private vault: Vault;
  private nodeSettings: NodeSettings;
  private nodeId: string;
  private nodeType: string;

  constructor(
    nodeType: string,
    nodeData: any,
    vault: Vault,
    nodeSettings: NodeSettings,
    nodeId: string
  ) {
    this.element = document.createElement("div");
    this.element.className = "systemsculpt-node-overlay";
    this.element.style.width = "100%";
    this.element.style.height = "100%";
    this.element.style.display = "flex";
    this.element.style.flexDirection = "column";
    this.element.style.padding = "10px";
    this.element.style.boxSizing = "border-box";
    this.element.style.overflow = "hidden";
    this.vault = vault;
    this.nodeSettings = nodeSettings;
    this.nodeId = nodeId;
    this.nodeType = nodeType;

    const titleEl = document.createElement("h3");
    titleEl.textContent = `${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)} Node`;
    titleEl.className = "systemsculpt-node-title";
    titleEl.style.margin = "0 0 10px 0";
    titleEl.style.padding = "0";
    titleEl.style.fontSize = "16px";
    titleEl.style.fontWeight = "bold";
    titleEl.style.whiteSpace = "nowrap";
    titleEl.style.overflow = "hidden";
    titleEl.style.textOverflow = "ellipsis";

    this.element.appendChild(titleEl);

    const settingsEl = document.createElement("div");
    settingsEl.className = "systemsculpt-node-settings";
    settingsEl.style.flex = "1";
    settingsEl.style.overflow = "auto";

    // Display settings based on node type
    switch (nodeType) {
      case "input":
        this.addInputSourceSetting(settingsEl, nodeData);
        this.addInputFileSetting(settingsEl, nodeData);
        break;
      case "processing":
        this.addProcessingTypeSetting(settingsEl, nodeData);
        break;
      case "output":
        this.addOutputTypeSetting(settingsEl, nodeData);
        break;
    }

    this.element.appendChild(settingsEl);
  }

  private createSettingElement(label: string, value: string): HTMLElement {
    const settingEl = document.createElement("div");
    settingEl.className = "systemsculpt-node-setting";
    settingEl.style.marginBottom = "5px";
    settingEl.style.fontSize = "12px";
    settingEl.style.lineHeight = "1.4";

    const labelEl = document.createElement("span");
    labelEl.className = "systemsculpt-node-setting-label";
    labelEl.textContent = label;
    labelEl.style.fontWeight = "bold";
    labelEl.style.marginRight = "5px";

    const valueEl = document.createElement("span");
    valueEl.className = "systemsculpt-node-setting-value";
    valueEl.textContent = value;

    settingEl.appendChild(labelEl);
    settingEl.appendChild(valueEl);

    return settingEl;
  }

  private addInputSourceSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement(
      "Input Source:",
      nodeData.inputSource || "File"
    );
    container.appendChild(settingEl);
  }

  private async addInputFileSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement(
      "Input File:",
      nodeData.inputFile || "Not set"
    );
    container.appendChild(settingEl);

    if (nodeData.inputFile) {
      const fileContentEl = document.createElement("div");
      fileContentEl.className = "systemsculpt-file-content";
      fileContentEl.style.marginTop = "5px";
      fileContentEl.style.fontSize = "11px";
      fileContentEl.style.lineHeight = "1.3";
      fileContentEl.style.maxHeight = "60px";
      fileContentEl.style.overflow = "auto";
      fileContentEl.style.whiteSpace = "pre-wrap";
      fileContentEl.style.wordBreak = "break-all";

      const file = this.vault.getAbstractFileByPath(nodeData.inputFile);
      if (file instanceof TFile) {
        const content = await this.vault.cachedRead(file);
        fileContentEl.textContent =
          content.slice(0, 200) + (content.length > 200 ? "..." : "");
      } else {
        fileContentEl.textContent = "File not found";
      }

      container.appendChild(fileContentEl);
    }
  }

  private addProcessingTypeSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement(
      "Processing Type:",
      nodeData.processingType || "Text Analysis"
    );
    container.appendChild(settingEl);
  }

  private addOutputTypeSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement(
      "Output Type:",
      nodeData.outputType || "File"
    );
    container.appendChild(settingEl);
  }

  private updateNodeData(newData: Partial<any>) {
    this.nodeSettings.updateNodeData(this.nodeId, newData);
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
