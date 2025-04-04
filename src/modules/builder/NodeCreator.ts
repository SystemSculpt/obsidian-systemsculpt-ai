import { NodeSettings } from "./NodeSettings";
import { NodeOverlay } from "./NodeOverlay";
import { Vault } from "obsidian";

export class NodeCreator {
  private nodeSettings: NodeSettings;
  private vault: Vault;

  constructor(nodeSettings: NodeSettings, vault: Vault) {
    this.nodeSettings = nodeSettings;
    this.vault = vault;
  }

  public addNode(
    canvasView: any,
    parentNode: HTMLElement | null,
    nodeType: "input" | "processing" | "output"
  ) {
    console.log("Adding node. Parent node:", parentNode);
    console.log("Node type:", nodeType);

    if (!canvasView) {
      console.error("No active canvas view found");
      return;
    }

    console.log("Canvas view:", canvasView);

    const newNodeData = this.createNodeData(nodeType);
    const nodeId = this.ensureUniqueNodeId(canvasView, newNodeData);

    let parentNodePosition = { x: 0, y: 0 };
    if (parentNode) {
      parentNodePosition = this.getNodePosition(parentNode);
    } else {
      parentNodePosition = this.getMostRecentNodePosition(canvasView);
    }

    console.log("Parent node position:", parentNodePosition);

    newNodeData.pos = {
      x: parentNodePosition.x + 275,
      y: parentNodePosition.y,
    };

    console.log("New node data:", newNodeData);

    if (
      canvasView.canvas &&
      typeof canvasView.canvas.createTextNode === "function"
    ) {
      const newNode = canvasView.canvas.createTextNode(newNodeData);
      console.log("New node created:", newNode);

      setTimeout(() => {
        this.addClassAndDataToNewNode(newNode, nodeType, nodeId);
        this.applyNodeOverlay(newNode, nodeType);
        this.saveCanvasData(canvasView);
      }, 100);

      canvasView.canvas.requestSave();
    } else {
      console.error("Canvas or createTextNode method not found");
    }
  }

  private createNodeData(nodeType: "input" | "processing" | "output") {
    return {
      text: "", // Empty text content
      size: {
        width: 250,
        height: 120,
      },
      pos: {
        x: 0,
        y: 0,
      },
      systemsculptNodeType: nodeType,
    };
  }

  private addClassAndDataToNewNode(
    newNode: any,
    nodeType: string,
    nodeId: string
  ) {
    if (newNode && newNode.nodeEl) {
      newNode.nodeEl.classList.add(`systemsculpt-node-${nodeType}`);
      newNode.nodeEl.classList.add(`systemsculpt-node-color-${nodeType}`);
      if (!newNode.unknownData) {
        newNode.unknownData = {};
      }
      newNode.unknownData.systemsculptNodeType = nodeType;
      newNode.unknownData.systemsculptNodeId = nodeId;
      console.log(
        `Class and data added to node: systemsculpt-node-${nodeType}, ID: ${nodeId}`
      );
    } else {
      console.error("Unable to add class and data to new node:", newNode);
    }
  }

  private getNodePosition(node: HTMLElement): { x: number; y: number } {
    const transformStyle = node.style.transform;
    const matches = transformStyle.match(
      /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/
    );

    if (matches && matches.length === 3) {
      return {
        x: parseFloat(matches[1]),
        y: parseFloat(matches[2]),
      };
    } else {
      console.error("Unable to parse node position");
      return { x: 0, y: 0 };
    }
  }

  private getMostRecentNodePosition(canvasView: any): { x: number; y: number } {
    let mostRecentTimestamp = 0;
    let mostRecentPosition = { x: 0, y: 0 };

    canvasView.canvas.nodes.forEach((node: any) => {
      if (node.unknownData && node.unknownData.systemsculptNodeId) {
        const timestamp = parseInt(
          node.unknownData.systemsculptNodeId.split("-")[1]
        );
        if (timestamp > mostRecentTimestamp) {
          mostRecentTimestamp = timestamp;
          mostRecentPosition = this.getNodePosition(node.nodeEl);
        }
      }
    });

    return mostRecentPosition;
  }

  private saveCanvasData(canvasView: any) {
    if (
      canvasView.canvas &&
      typeof canvasView.canvas.requestSave === "function"
    ) {
      canvasView.canvas.requestSave();
    }
  }

  private ensureUniqueNodeId(canvasView: any, newNodeData: any): string {
    let nodeId = this.nodeSettings.assignUniqueNodeId(newNodeData);
    const existingNodeIds = new Set();

    if (canvasView.canvas && Array.isArray(canvasView.canvas.nodes)) {
      canvasView.canvas.nodes.forEach((node: any) => {
        if (node.id) {
          existingNodeIds.add(node.id);
        }
      });
    }

    while (existingNodeIds.has(nodeId)) {
      console.log(`Duplicate node ID found: ${nodeId}. Regenerating...`);
      nodeId = this.nodeSettings.assignUniqueNodeId(newNodeData);
    }

    console.log(`Unique node ID assigned: ${nodeId}`);
    return nodeId;
  }

  public async applyNodeOverlay(node: any, nodeType: string) {
    if (node && node.nodeEl) {
      const contentEl = node.nodeEl.querySelector(".canvas-node-content");
      if (contentEl) {
        // Remove all child elements
        while (contentEl.firstChild) {
          contentEl.removeChild(contentEl.firstChild);
        }

        // Get node data from the NodeSettings
        const nodeId = node.unknownData.systemsculptNodeId;
        const nodeData = this.nodeSettings.getNodeData(nodeId);

        // Create and append the NodeOverlay
        const overlay = new NodeOverlay(
          nodeType,
          nodeData,
          this.vault,
          this.nodeSettings,
          nodeId
        );
        contentEl.appendChild(await overlay.getElement());

        // Make the content uneditable
        contentEl.setAttribute("contenteditable", "false");
      }
    }
  }
}
