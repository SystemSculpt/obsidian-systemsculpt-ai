import { App } from "obsidian";
import SystemSculptPlugin from "../../main";

interface NodeData {
  inputSource?: string;
  inputFile?: string;
  // Add more properties as needed for different node types
}

export class NodeSettings {
  public app: App;
  public plugin: SystemSculptPlugin;
  private nodeData: Map<string, NodeData> = new Map();
  private saveCallback: () => void;

  constructor(app: App, plugin: SystemSculptPlugin, saveCallback: () => void) {
    this.app = app;
    this.plugin = plugin;
    this.saveCallback = saveCallback;
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
