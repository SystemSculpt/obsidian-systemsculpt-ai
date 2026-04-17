import type { StudioRunEvent } from "../../../studio/types";
import type { StudioLinkStore, EdgeState } from "./StudioLinkStore";

export class StudioLinkFlowBridge {
  constructor(private readonly store: StudioLinkStore) {}

  applyRunEvent(event: StudioRunEvent): void {
    switch (event.type) {
      case "run.started":
        return;
      case "node.started":
        this.forEachOutgoing(event.nodeId, (edge) => {
          this.store.setEdgeStatus(edge.id, "flowing");
        });
        return;
      case "node.output":
      case "node.cache_hit":
        this.forEachOutgoing(event.nodeId, (edge) => {
          this.store.setEdgeStatus(edge.id, "completed", { flareT: 0 });
        });
        return;
      case "node.failed":
        this.forEachOutgoing(event.nodeId, (edge) => {
          this.store.setEdgeStatus(edge.id, "failed", { flareT: 0 });
        });
        return;
      case "run.failed":
        this.forEachFlowing((edge) => {
          this.store.setEdgeStatus(edge.id, "failed", { flareT: 0 });
        });
        return;
      case "run.completed":
        this.forEachFlowing((edge) => {
          this.store.setEdgeStatus(
            edge.id,
            event.status === "success" ? "completed" : "failed",
            { flareT: 0 }
          );
        });
        return;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        return;
      }
    }
  }

  resetAll(): void {
    for (const edge of this.store.listEdges()) {
      if (edge.status !== "idle") {
        this.store.setEdgeStatus(edge.id, "idle");
      }
    }
  }

  private forEachOutgoing(nodeId: string, visit: (edge: EdgeState) => void): void {
    for (const edge of this.store.listEdges()) {
      if (edge.source.nodeId === nodeId) {
        visit(edge);
      }
    }
  }

  private forEachFlowing(visit: (edge: EdgeState) => void): void {
    for (const edge of this.store.listEdges()) {
      if (edge.status === "flowing") {
        visit(edge);
      }
    }
  }
}
