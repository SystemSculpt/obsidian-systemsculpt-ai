import { EdgeColors } from "./EdgeColors";

export class EdgeStyleManager {
  private canvasView: any;

  constructor(canvasView: any) {
    this.canvasView = canvasView;
  }

  public setupEdgeObserver() {
    this.applyCustomEdgeStyles();

    const observer = new MutationObserver(() => {
      this.applyCustomEdgeStyles();
    });

    if (this.canvasView.canvas?.edgeContainerEl) {
      observer.observe(this.canvasView.canvas.edgeContainerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "d"],
      });
    }
  }

  private applyCustomEdgeStyles() {
    if (!this.canvasView.canvas?.edges) return;

    this.canvasView.canvas.edges.forEach((edge: any) => {
      const sourceNode = this.canvasView.canvas.nodes.get(edge.from.node.id);
      const targetNode = this.canvasView.canvas.nodes.get(edge.to.node.id);

      const color = this.getEdgeColor(sourceNode, targetNode);

      this.styleEdgePaths(edge, color);
    });
  }

  private styleEdgePaths(edge: any, color: string) {
    if (edge.path?.display) {
      edge.path.display.style.stroke = color;
      edge.path.display.style.strokeWidth = "2px";
    }

    if (edge.path?.interaction) {
      edge.path.interaction.style.stroke = color;
      edge.path.interaction.style.strokeWidth = "4px";
      edge.path.interaction.style.opacity = "0.5";
    }
  }

  private getEdgeColor(sourceNode: any, targetNode: any): string {
    if (
      sourceNode?.unknownData?.systemsculptNodeType === "input" &&
      targetNode?.unknownData?.systemsculptNodeType === "processing"
    ) {
      return EdgeColors.INPUT_TO_PROCESSING;
    }
    if (
      sourceNode?.unknownData?.systemsculptNodeType === "processing" &&
      targetNode?.unknownData?.systemsculptNodeType === "output"
    ) {
      return EdgeColors.PROCESSING_TO_OUTPUT;
    }
    return EdgeColors.DEFAULT;
  }
}
