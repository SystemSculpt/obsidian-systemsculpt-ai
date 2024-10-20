import { TFile, Vault } from "obsidian";

export class NodeOverlay {
  private element: HTMLElement;
  private vault: Vault;

  constructor(nodeType: string, nodeData: any, vault: Vault) {
    this.element = document.createElement("div");
    this.element.className = "systemsculpt-node-overlay";
    this.vault = vault;

    const titleEl = document.createElement("h3");
    titleEl.textContent = `${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)} Node`;
    titleEl.className = "systemsculpt-node-title";

    this.element.appendChild(titleEl);

    const settingsEl = document.createElement("div");
    settingsEl.className = "systemsculpt-node-settings";

    // Display settings based on node type
    switch (nodeType) {
      case "input":
        this.addSetting(
          settingsEl,
          "Input Source",
          nodeData.inputSource || "Not set"
        );
        this.addInputFileSetting(settingsEl, nodeData.inputFile);
        break;
      case "processing":
        this.addSetting(
          settingsEl,
          "Processing Type",
          nodeData.processingType || "Not set"
        );
        break;
      case "output":
        this.addSetting(
          settingsEl,
          "Output Type",
          nodeData.outputType || "Not set"
        );
        break;
    }

    this.element.appendChild(settingsEl);
  }

  private addSetting(container: HTMLElement, label: string, value: string) {
    const settingEl = document.createElement("div");
    settingEl.className = "systemsculpt-node-setting";

    const labelEl = document.createElement("span");
    labelEl.className = "systemsculpt-node-setting-label";
    labelEl.textContent = label + ":";

    const valueEl = document.createElement("span");
    valueEl.className = "systemsculpt-node-setting-value";
    valueEl.textContent = value;

    settingEl.appendChild(labelEl);
    settingEl.appendChild(valueEl);

    container.appendChild(settingEl);
  }

  private async addInputFileSetting(
    container: HTMLElement,
    filePath: string | undefined
  ) {
    const settingEl = document.createElement("div");
    settingEl.className =
      "systemsculpt-node-setting systemsculpt-input-file-setting";

    const labelEl = document.createElement("span");
    labelEl.className = "systemsculpt-node-setting-label";
    labelEl.textContent = "Input File:";

    const valueEl = document.createElement("span");
    valueEl.className = "systemsculpt-node-setting-value";
    valueEl.textContent = filePath || "Not set";

    settingEl.appendChild(labelEl);
    settingEl.appendChild(valueEl);

    container.appendChild(settingEl);

    if (filePath) {
      const fileContentEl = document.createElement("div");
      fileContentEl.className = "systemsculpt-file-content";

      const file = this.vault.getAbstractFileByPath(filePath);
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

  public getElement(): HTMLElement {
    return this.element;
  }
}
