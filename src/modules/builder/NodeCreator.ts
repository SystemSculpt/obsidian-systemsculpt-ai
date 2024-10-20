import { NodeSettings } from "./NodeSettings";

export class NodeCreator {
  private nodeSettings: NodeSettings;

  constructor(nodeSettings: NodeSettings) {
    this.nodeSettings = nodeSettings;
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

    // Assign a unique ID to the new node
    const nodeId = this.nodeSettings.assignUniqueNodeId(newNodeData);

    // Get the parent node's position or use the position of the most recently added node
    let parentNodePosition = { x: 0, y: 0 };
    if (parentNode) {
      parentNodePosition = this.getNodePosition(parentNode);
    } else {
      parentNodePosition = this.getMostRecentNodePosition(canvasView);
    }

    console.log("Parent node position:", parentNodePosition);

    // Set the position for the new node
    newNodeData.pos = {
      x: parentNodePosition.x + 275,
      y: parentNodePosition.y,
    };

    console.log("New node data:", newNodeData);

    // Add the new node to the canvas
    if (
      canvasView.canvas &&
      typeof canvasView.canvas.createTextNode === "function"
    ) {
      const newNode = canvasView.canvas.createTextNode(newNodeData);
      console.log("New node created:", newNode);

      // Add the class and save node data directly to the new node after a short delay
      setTimeout(() => {
        this.addClassAndDataToNewNode(newNode, nodeType, nodeId);
        this.saveCanvasData(canvasView);
      }, 100);

      // Trigger a canvas update
      canvasView.canvas.requestSave();
    } else {
      console.error("Canvas or createTextNode method not found");
    }
  }

  private createNodeData(nodeType: "input" | "processing" | "output") {
    return {
      text: `# ${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)} Node\n\nAdd your content here`,
      size: {
        width: 250,
        height: 120,
      },
      pos: {
        x: 0,
        y: 0,
      },
      systemsculptNodeType: nodeType,
      id: `systemsculpt-${nodeType}-${Date.now()}`,
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
}
