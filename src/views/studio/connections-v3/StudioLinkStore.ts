export type PortAnchor = {
  nodeId: string;
  portId: string;
};

export type EdgeIdentity = {
  id: string;
  source: PortAnchor;
  target: PortAnchor;
};

export type EdgeStatus = "idle" | "flowing" | "completed" | "failed";

export type EdgeState = EdgeIdentity & {
  status: EdgeStatus;
  flowPhase: number;
  flareT: number;
};

export type DragValidity = "valid" | "near" | "invalid";

export type DragState = {
  source: PortAnchor;
  cursorWorld: { x: number; y: number };
  snapTarget: PortAnchor | null;
  snapConfidence: number;
  validity: DragValidity;
};

export type LinkStoreListener = () => void;

type EdgeStatusOverrides = {
  flareT?: number;
  flowPhase?: number;
};

function edgeKey(edge: EdgeIdentity): string {
  return `${edge.id}|${edge.source.nodeId}:${edge.source.portId}->${edge.target.nodeId}:${edge.target.portId}`;
}

export class StudioLinkStore {
  private edges = new Map<string, EdgeState>();
  private dragState: DragState | null = null;
  private listeners = new Set<LinkStoreListener>();

  subscribe(listener: LinkStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listEdges(): EdgeState[] {
    return Array.from(this.edges.values());
  }

  getEdge(id: string): EdgeState | null {
    return this.edges.get(id) || null;
  }

  getDragState(): DragState | null {
    return this.dragState;
  }

  setEdges(next: EdgeIdentity[]): void {
    const nextKeys = next.map(edgeKey).sort().join(",");
    const prevKeys = this.listEdges().map(edgeKey).sort().join(",");
    if (nextKeys === prevKeys) {
      return;
    }
    const nextMap = new Map<string, EdgeState>();
    for (const identity of next) {
      const existing = this.edges.get(identity.id);
      if (existing && edgeKey(existing) === edgeKey(identity)) {
        nextMap.set(identity.id, existing);
      } else {
        nextMap.set(identity.id, {
          ...identity,
          status: "idle",
          flowPhase: 0,
          flareT: 0,
        });
      }
    }
    this.edges = nextMap;
    this.emit();
  }

  setEdgeStatus(id: string, status: EdgeStatus, overrides?: EdgeStatusOverrides): void {
    const edge = this.edges.get(id);
    if (!edge) {
      return;
    }
    const next: EdgeState = {
      ...edge,
      status,
      flowPhase: status === "flowing" ? 0 : overrides?.flowPhase ?? edge.flowPhase,
      flareT: status === "flowing" ? 0 : overrides?.flareT ?? edge.flareT,
    };
    if (
      next.status === edge.status &&
      next.flowPhase === edge.flowPhase &&
      next.flareT === edge.flareT
    ) {
      return;
    }
    this.edges.set(id, next);
    this.emit();
  }

  setEdgeFlowPhase(id: string, flowPhase: number): void {
    const edge = this.edges.get(id);
    if (!edge || edge.flowPhase === flowPhase) {
      return;
    }
    this.edges.set(id, { ...edge, flowPhase });
  }

  setEdgeFlareT(id: string, flareT: number): void {
    const edge = this.edges.get(id);
    if (!edge || edge.flareT === flareT) {
      return;
    }
    this.edges.set(id, { ...edge, flareT });
  }

  setDragState(next: DragState | null): void {
    const same =
      (next === null && this.dragState === null) ||
      (next !== null &&
        this.dragState !== null &&
        next.source.nodeId === this.dragState.source.nodeId &&
        next.source.portId === this.dragState.source.portId &&
        next.cursorWorld.x === this.dragState.cursorWorld.x &&
        next.cursorWorld.y === this.dragState.cursorWorld.y &&
        next.snapConfidence === this.dragState.snapConfidence &&
        next.validity === this.dragState.validity &&
        ((next.snapTarget === null && this.dragState.snapTarget === null) ||
          (next.snapTarget !== null &&
            this.dragState.snapTarget !== null &&
            next.snapTarget.nodeId === this.dragState.snapTarget.nodeId &&
            next.snapTarget.portId === this.dragState.snapTarget.portId)));
    if (same) {
      return;
    }
    this.dragState = next;
    this.emit();
  }

  removeEdgesForNode(nodeId: string): void {
    let changed = false;
    for (const [id, edge] of this.edges) {
      if (edge.source.nodeId === nodeId || edge.target.nodeId === nodeId) {
        this.edges.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  clear(): void {
    const hadState = this.edges.size > 0 || this.dragState !== null;
    this.edges.clear();
    this.dragState = null;
    if (hadState) {
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
