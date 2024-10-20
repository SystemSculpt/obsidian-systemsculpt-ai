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
    this.vault = vault;
    this.nodeSettings = nodeSettings;
    this.nodeId = nodeId;
    this.nodeType = nodeType;

    const titleEl = document.createElement("h3");
    titleEl.textContent = `${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)} Node`;
    titleEl.className = "systemsculpt-node-title";

    this.element.appendChild(titleEl);

    const settingsEl = document.createElement("div");
    settingsEl.className = "systemsculpt-node-settings";

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

  private addInputSourceSetting(container: HTMLElement, nodeData: any) {
    const settingEl = document.createElement("div");
    settingEl.className = "systemsculpt-node-setting";

    const labelEl = document.createElement("span");
    labelEl.className = "systemsculpt-node-setting-label";
    labelEl.textContent = "Input Source:";

    const select = document.createElement("select");
    select.className = "systemsculpt-node-setting-value";
    ["file", "user_input", "api"].forEach((option) => {
      const optionEl = document.createElement("option");
      optionEl.value = option;
      optionEl.textContent = option.charAt(0).toUpperCase() + option.slice(1);
      select.appendChild(optionEl);
    });

    select.value = nodeData.inputSource || "file";
    select.addEventListener("change", () => {
      this.updateNodeData({ inputSource: select.value });
    });

    settingEl.appendChild(labelEl);
    settingEl.appendChild(select);

    container.appendChild(settingEl);
  }

  private async addInputFileSetting(container: HTMLElement, nodeData: any) {
    const settingEl = document.createElement("div");
    settingEl.className =
      "systemsculpt-node-setting systemsculpt-input-file-setting";

    const labelEl = document.createElement("span");
    labelEl.className = "systemsculpt-node-setting-label";
    labelEl.textContent = "Input File:";

    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "systemsculpt-node-setting-value";
    inputEl.value = nodeData.inputFile || "";
    inputEl.placeholder = "Enter file path...";

    inputEl.addEventListener("change", () => {
      this.updateNodeData({ inputFile: inputEl.value });
    });

    settingEl.appendChild(labelEl);
    settingEl.appendChild(inputEl);

    container.appendChild(settingEl);

    if (nodeData.inputFile) {
      const fileContentEl = document.createElement("div");
      fileContentEl.className = "systemsculpt-file-content";

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
    const settingEl = document.createElement("div");
    settingEl.className = "systemsculpt-node-setting";

    const labelEl = document.createElement("span");
    labelEl.className = "systemsculpt-node-setting-label";
    labelEl.textContent = "Processing Type:";

    const select = document.createElement("select");
    select.className = "systemsculpt-node-setting-value";
    ["text_analysis", "data_transformation", "ai_model"].forEach((option) => {
      const optionEl = document.createElement("option");
      optionEl.value = option;
      optionEl.textContent = option
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
      select.appendChild(optionEl);
    });

    select.value = nodeData.processingType || "text_analysis";
    select.addEventListener("change", () => {
      this.updateNodeData({ processingType: select.value });
    });

    settingEl.appendChild(labelEl);
    settingEl.appendChild(select);

    container.appendChild(settingEl);
  }

  private addOutputTypeSetting(container: HTMLElement, nodeData: any) {
    const settingEl = document.createElement("div");
    settingEl.className = "systemsculpt-node-setting";

    const labelEl = document.createElement("span");
    labelEl.className = "systemsculpt-node-setting-label";
    labelEl.textContent = "Output Type:";

    const select = document.createElement("select");
    select.className = "systemsculpt-node-setting-value";
    ["file", "display", "api"].forEach((option) => {
      const optionEl = document.createElement("option");
      optionEl.value = option;
      optionEl.textContent = option.charAt(0).toUpperCase() + option.slice(1);
      select.appendChild(optionEl);
    });

    select.value = nodeData.outputType || "file";
    select.addEventListener("change", () => {
      this.updateNodeData({ outputType: select.value });
    });

    settingEl.appendChild(labelEl);
    settingEl.appendChild(select);

    container.appendChild(settingEl);
  }

  private updateNodeData(newData: Partial<any>) {
    this.nodeSettings.updateNodeData(this.nodeId, newData);
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
