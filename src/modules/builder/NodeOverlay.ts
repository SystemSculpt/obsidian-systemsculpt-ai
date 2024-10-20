export class NodeOverlay {
  private element: HTMLElement;

  constructor(nodeType: string, nodeData: any) {
    this.element = document.createElement("div");
    this.element.className = "systemsculpt-node-overlay";

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
        this.addSetting(
          settingsEl,
          "Input File",
          nodeData.inputFile || "Not set"
        );
        break;
      case "processing":
        // Add processing node specific settings here
        this.addSetting(
          settingsEl,
          "Processing Type",
          nodeData.processingType || "Not set"
        );
        break;
      case "output":
        // Add output node specific settings here
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

  public getElement(): HTMLElement {
    return this.element;
  }
}
