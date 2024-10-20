import { TFile, Vault } from "obsidian";
import { NodeSettings } from "./NodeSettings";
import { FileChooserModal } from "./FileChooserModal";

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
    this.element = document.createElement("div") as HTMLElement;
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

    const titleEl = document.createElement("h3") as HTMLElement;
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

  private createSettingElement(label: string): HTMLElement {
    const settingEl = document.createElement("div") as HTMLDivElement;
    settingEl.className = "systemsculpt-node-setting";
    settingEl.style.marginBottom = "10px";
    settingEl.style.fontSize = "12px";
    settingEl.style.lineHeight = "1.4";

    const labelEl = document.createElement("label") as HTMLLabelElement;
    labelEl.className = "systemsculpt-node-setting-label";
    labelEl.textContent = label;
    labelEl.style.display = "block";
    labelEl.style.marginBottom = "3px";
    labelEl.style.fontWeight = "bold";

    settingEl.appendChild(labelEl);

    return settingEl;
  }

  private addInputSourceSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement("Input Source:");
    const select = document.createElement("select");
    select.style.width = "100%";
    select.style.padding = "2px";

    const options = ["File", "User Input"];
    options.forEach((option) => {
      const optionEl = document.createElement("option");
      optionEl.value = option.toLowerCase().replace(" ", "_");
      optionEl.textContent = option;
      select.appendChild(optionEl);
    });

    select.value = nodeData.inputSource || "file";
    select.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      this.updateNodeData({ inputSource: target.value });
    });

    settingEl.appendChild(select);
    container.appendChild(settingEl);
  }

  private async addInputFileSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement("Input File:");
    const input = document.createElement("input");
    input.type = "text";
    input.style.width = "100%";
    input.style.padding = "2px";
    input.value = nodeData.inputFile || "";
    input.readOnly = true;

    const chooseFileButton = document.createElement("button");
    chooseFileButton.textContent = "Choose File";
    chooseFileButton.style.marginLeft = "5px";

    chooseFileButton.addEventListener("click", () => {
      new FileChooserModal(this.nodeSettings.app, (file: TFile) => {
        input.value = file.path;
        this.updateNodeData({ inputFile: file.path });
        this.updateFileContent(settingEl, file);
      }).open();
    });

    const inputContainer = document.createElement("div");
    inputContainer.style.display = "flex";
    inputContainer.appendChild(input);
    inputContainer.appendChild(chooseFileButton);

    settingEl.appendChild(inputContainer);
    container.appendChild(settingEl);

    if (nodeData.inputFile) {
      const file = this.vault.getAbstractFileByPath(nodeData.inputFile);
      if (file instanceof TFile) {
        this.updateFileContent(settingEl, file);
      }
    }
  }

  private async updateFileContent(settingEl: HTMLElement, file: TFile) {
    let fileContentEl = settingEl.querySelector(
      ".systemsculpt-file-content"
    ) as HTMLDivElement;
    if (!fileContentEl) {
      fileContentEl = document.createElement("div") as HTMLDivElement;
      fileContentEl.className = "systemsculpt-file-content";
      fileContentEl.style.marginTop = "5px";
      fileContentEl.style.fontSize = "11px";
      fileContentEl.style.lineHeight = "1.3";
      fileContentEl.style.maxHeight = "60px";
      fileContentEl.style.overflow = "auto";
      fileContentEl.style.whiteSpace = "pre-wrap";
      fileContentEl.style.wordBreak = "break-all";
      settingEl.appendChild(fileContentEl);
    }

    const content = await this.vault.cachedRead(file);
    fileContentEl.textContent =
      content.slice(0, 200) + (content.length > 200 ? "..." : "");
  }

  private addProcessingTypeSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement("Processing Type:");
    const select = document.createElement("select");
    select.style.width = "100%";
    select.style.padding = "2px";

    const option = document.createElement("option");
    option.value = "ai_processing_text";
    option.textContent = "AI Processing (Text)";
    select.appendChild(option);

    select.value = nodeData.processingType || "ai_processing_text";
    select.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      this.updateNodeData({ processingType: target.value });
    });

    settingEl.appendChild(select);
    container.appendChild(settingEl);
  }

  private addOutputTypeSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement("Output Type:");
    const select = document.createElement("select");
    select.style.width = "100%";
    select.style.padding = "2px";

    const options = ["File", "Display in UI"];
    options.forEach((option) => {
      const optionEl = document.createElement("option");
      optionEl.value = option.toLowerCase().replace(" ", "_");
      optionEl.textContent = option;
      select.appendChild(optionEl);
    });

    select.value = nodeData.outputType || "file";
    select.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      this.updateNodeData({ outputType: target.value });
    });

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
