import { TFile, Vault, TFolder } from "obsidian";
import { NodeSettings } from "./NodeSettings";
import { FileChooserModal } from "./FileChooserModal";
import { DirectoryChooserModal } from "./DirectoryChooserModal";
import { NodeModelSelectionModal } from "./ui/NodeModelSelectionModal";
import { SystemPromptModal } from "./ui/SystemPromptModal";

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

    // Add the model selection setting
    this.addModelSelectionSetting(container, nodeData);

    // Add the temperature setting
    this.addTemperatureSetting(container, nodeData);

    // Add the system prompt setting
    this.addSystemPromptSetting(container, nodeData);

    // Add the additional prompt setting
    this.addAdditionalPromptSetting(container, nodeData);
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
      this.toggleOutputFileSettings(container, target.value);
    });

    settingEl.appendChild(select);
    container.appendChild(settingEl);

    // Add Output Filename and Output Directory settings
    this.addOutputFileSettings(container, nodeData);

    // Initially show/hide file settings based on the current output type
    this.toggleOutputFileSettings(container, select.value);
  }

  private addOutputFileSettings(container: HTMLElement, nodeData: any) {
    // Output Filename setting
    const filenameSetting = this.createSettingElement("Output Filename:");
    const filenameInput = document.createElement("input");
    filenameInput.type = "text";
    filenameInput.style.width = "100%";
    filenameInput.style.padding = "2px";
    filenameInput.value = nodeData.outputFilename || "output.md";
    filenameInput.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      this.updateNodeData({ outputFilename: target.value });
    });
    filenameSetting.appendChild(filenameInput);
    container.appendChild(filenameSetting);

    // Output Directory setting
    const directorySetting = this.createSettingElement("Output Directory:");
    const directoryInput = document.createElement("input");
    directoryInput.type = "text";
    directoryInput.style.width = "calc(100% - 110px)";
    directoryInput.style.padding = "2px";
    directoryInput.value = nodeData.outputDirectory || "";
    directoryInput.readOnly = true;

    const chooseDirectoryButton = document.createElement("button");
    chooseDirectoryButton.textContent = "Choose Directory";
    chooseDirectoryButton.style.marginLeft = "5px";
    chooseDirectoryButton.style.width = "125px";

    chooseDirectoryButton.addEventListener("click", () => {
      new DirectoryChooserModal(this.nodeSettings.app, (folder: TFolder) => {
        directoryInput.value = folder.path;
        this.updateNodeData({ outputDirectory: folder.path });
      }).open();
    });

    const directoryContainer = document.createElement("div");
    directoryContainer.style.display = "flex";
    directoryContainer.appendChild(directoryInput);
    directoryContainer.appendChild(chooseDirectoryButton);

    directorySetting.appendChild(directoryContainer);
    container.appendChild(directorySetting);
  }

  private toggleOutputFileSettings(container: HTMLElement, outputType: string) {
    const filenameSetting = container.querySelector(
      ".systemsculpt-node-setting:nth-last-child(2)"
    ) as HTMLElement;
    const directorySetting = container.querySelector(
      ".systemsculpt-node-setting:last-child"
    ) as HTMLElement;

    if (outputType === "file") {
      filenameSetting.style.display = "block";
      directorySetting.style.display = "block";
    } else {
      filenameSetting.style.display = "none";
      directorySetting.style.display = "none";
    }
  }

  private updateNodeData(newData: Partial<any>) {
    this.nodeSettings.updateNodeData(this.nodeId, newData);
  }

  private addModelSelectionSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement("AI Model:");
    const inputContainer = document.createElement("div");
    inputContainer.style.display = "flex";

    const input = document.createElement("input");
    input.type = "text";
    input.style.width = "100%";
    input.style.padding = "2px";
    input.value = nodeData.modelId || "";
    input.readOnly = true;

    const chooseModelButton = document.createElement("button");
    chooseModelButton.textContent = "Choose Model";
    chooseModelButton.style.marginLeft = "5px";

    chooseModelButton.addEventListener("click", () => {
      new NodeModelSelectionModal(
        this.nodeSettings.app,
        this.nodeSettings.plugin,
        (selectedModel) => {
          input.value = selectedModel.name;
          this.updateNodeData({ modelId: selectedModel.id });
        }
      ).open();
    });

    inputContainer.appendChild(input);
    inputContainer.appendChild(chooseModelButton);

    settingEl.appendChild(inputContainer);
    container.appendChild(settingEl);
  }

  private addTemperatureSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement("Temperature:");
    const sliderContainer = document.createElement("div");
    sliderContainer.style.display = "flex";
    sliderContainer.style.alignItems = "center";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "2";
    slider.step = "0.1";
    slider.value = nodeData.temperature || "0.2";
    slider.style.flex = "1";

    const valueDisplay = document.createElement("span");
    valueDisplay.textContent = slider.value;
    valueDisplay.style.marginLeft = "10px";

    slider.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      valueDisplay.textContent = target.value;
      this.updateNodeData({ temperature: parseFloat(target.value) });
    });

    sliderContainer.appendChild(slider);
    sliderContainer.appendChild(valueDisplay);
    settingEl.appendChild(sliderContainer);
    container.appendChild(settingEl);
  }

  private addSystemPromptSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement("System Prompt:");
    const inputContainer = document.createElement("div");
    inputContainer.style.display = "flex";

    const input = document.createElement("input");
    input.type = "text";
    input.style.width = "100%";
    input.style.padding = "2px";
    input.value = nodeData.systemPrompt || "";
    input.readOnly = true;

    const choosePromptButton = document.createElement("button");
    choosePromptButton.textContent = "Choose Prompt";
    choosePromptButton.style.marginLeft = "5px";

    choosePromptButton.addEventListener("click", () => {
      new SystemPromptModal(
        this.nodeSettings.app,
        this.nodeSettings.plugin.templatesModule,
        (selectedPrompt) => {
          input.value = selectedPrompt;
          this.updateNodeData({ systemPrompt: selectedPrompt });
        }
      ).open();
    });

    inputContainer.appendChild(input);
    inputContainer.appendChild(choosePromptButton);

    settingEl.appendChild(inputContainer);
    container.appendChild(settingEl);
  }

  private addAdditionalPromptSetting(container: HTMLElement, nodeData: any) {
    const settingEl = this.createSettingElement("Additional Prompt:");
    const textarea = document.createElement("textarea");
    textarea.style.width = "100%";
    textarea.style.padding = "2px";
    textarea.style.minHeight = "100px";
    textarea.value = nodeData.additionalPrompt || "";
    textarea.addEventListener("change", (e) => {
      const target = e.target as HTMLTextAreaElement;
      this.updateNodeData({ additionalPrompt: target.value });
    });

    settingEl.appendChild(textarea);
    container.appendChild(settingEl);
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
