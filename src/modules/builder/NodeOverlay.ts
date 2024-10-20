export class NodeOverlay {
  private element: HTMLElement;

  constructor(nodeType: string) {
    this.element = document.createElement("div");
    this.element.className = "systemsculpt-node-overlay";

    const titleEl = document.createElement("h3");
    titleEl.textContent = `${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)} Node`;
    titleEl.className = "systemsculpt-node-title";

    this.element.appendChild(titleEl);
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
