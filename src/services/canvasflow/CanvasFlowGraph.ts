export type CanvasNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  file?: string;
  subpath?: string;
  text?: string;
  label?: string;
  url?: string;
  [key: string]: unknown;
};

export type CanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
  [key: string]: unknown;
};

export type CanvasDocument = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function generateId(prefix = "ss"): string {
  try {
    const globalCrypto: any = (globalThis as any).crypto;
    if (typeof globalCrypto?.randomUUID === "function") {
      return `${prefix}-${globalCrypto.randomUUID()}`;
    }
  } catch {}
  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function parseCanvasDocument(raw: string): CanvasDocument | null {
  const src = String(raw ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(src);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const nodesRaw = (parsed as any).nodes;
  const edgesRaw = (parsed as any).edges;
  const nodesArr = Array.isArray(nodesRaw) ? nodesRaw : [];
  const edgesArr = Array.isArray(edgesRaw) ? edgesRaw : [];

  const nodes: CanvasNode[] = nodesArr
    .map((n: any) => {
      if (!isRecord(n)) return null;
      const id = typeof n.id === "string" ? n.id : "";
      const type = typeof n.type === "string" ? n.type : "";
      const x = readNumber(n.x) ?? 0;
      const y = readNumber(n.y) ?? 0;
      if (!id || !type) return null;
      const node: CanvasNode = {
        ...n,
        id,
        type,
        x,
        y,
      };
      const width = readNumber(n.width);
      const height = readNumber(n.height);
      if (width !== null) node.width = width;
      if (height !== null) node.height = height;
      if (typeof n.file === "string") node.file = n.file;
      if (typeof n.subpath === "string") node.subpath = n.subpath;
      if (typeof n.text === "string") node.text = n.text;
      if (typeof n.label === "string") node.label = n.label;
      if (typeof n.url === "string") node.url = n.url;
      return node;
    })
    .filter(Boolean) as CanvasNode[];

  const edges: CanvasEdge[] = edgesArr
    .map((e: any) => {
      if (!isRecord(e)) return null;
      const id = typeof e.id === "string" ? e.id : "";
      const fromNode = typeof e.fromNode === "string" ? e.fromNode : "";
      const toNode = typeof e.toNode === "string" ? e.toNode : "";
      if (!id || !fromNode || !toNode) return null;
      const edge: CanvasEdge = {
        ...e,
        id,
        fromNode,
        toNode,
      };
      if (typeof e.label === "string") edge.label = e.label;
      return edge;
    })
    .filter(Boolean) as CanvasEdge[];

  return {
    ...(parsed as any),
    nodes,
    edges,
  } satisfies CanvasDocument;
}

export function serializeCanvasDocument(doc: CanvasDocument): string {
  // Keep Canvas files readable; Obsidian Canvas tolerates pretty JSON.
  return JSON.stringify(doc, null, 2);
}

export function indexCanvas(doc: CanvasDocument): {
  nodesById: Map<string, CanvasNode>;
  edgesByToNode: Map<string, CanvasEdge[]>;
  edgesByFromNode: Map<string, CanvasEdge[]>;
} {
  const nodesById = new Map<string, CanvasNode>();
  for (const node of doc.nodes) {
    nodesById.set(node.id, node);
  }

  const edgesByToNode = new Map<string, CanvasEdge[]>();
  const edgesByFromNode = new Map<string, CanvasEdge[]>();
  for (const edge of doc.edges) {
    const to = edge.toNode;
    const from = edge.fromNode;
    const toList = edgesByToNode.get(to) || [];
    toList.push(edge);
    edgesByToNode.set(to, toList);

    const fromList = edgesByFromNode.get(from) || [];
    fromList.push(edge);
    edgesByFromNode.set(from, fromList);
  }

  return { nodesById, edgesByToNode, edgesByFromNode };
}

export function isCanvasFileNode(node: CanvasNode): node is CanvasNode & { file: string } {
  return node.type === "file" && typeof node.file === "string" && node.file.length > 0;
}

export function isImagePath(path: string): boolean {
  const ext = String(path.split(".").pop() || "").toLowerCase();
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "bmp" || ext === "tiff";
}

export function findIncomingImageFilesForNode(
  doc: CanvasDocument,
  nodeId: string
): Array<{ fromNodeId: string; imagePath: string; edgeId: string }> {
  const { nodesById, edgesByToNode } = indexCanvas(doc);
  const incoming = edgesByToNode.get(nodeId) || [];
  const out: Array<{ fromNodeId: string; imagePath: string; edgeId: string }> = [];
  const seen = new Set<string>();

  for (const edge of incoming) {
    const from = nodesById.get(edge.fromNode);
    if (!from || !isCanvasFileNode(from)) continue;
    if (!isImagePath(from.file)) continue;

    const key = `${from.id}\u0000${from.file}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      fromNodeId: from.id,
      imagePath: from.file,
      edgeId: edge.id,
    });
  }

  return out;
}

export function findIncomingImageFileForNode(
  doc: CanvasDocument,
  nodeId: string
): { fromNodeId: string; imagePath: string } | null {
  const incoming = findIncomingImageFilesForNode(doc, nodeId);
  const first = incoming[0];
  if (!first) return null;
  return { fromNodeId: first.fromNodeId, imagePath: first.imagePath };
}

export function addFileNode(
  doc: CanvasDocument,
  options: {
    filePath: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    nodeId?: string;
  }
): { doc: CanvasDocument; nodeId: string } {
  const nodeId = options.nodeId || generateId("ss-node");
  const node: CanvasNode = {
    id: nodeId,
    type: "file",
    file: options.filePath,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
  };

  const nextNodes = [...doc.nodes, node];
  return {
    doc: { ...doc, nodes: nextNodes },
    nodeId,
  };
}

export function addTextNode(
  doc: CanvasDocument,
  options: {
    text: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    nodeId?: string;
  }
): { doc: CanvasDocument; nodeId: string } {
  const nodeId = options.nodeId || generateId("ss-node");
  const node: CanvasNode = {
    id: nodeId,
    type: "text",
    text: String(options.text || ""),
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
  };

  const nextNodes = [...doc.nodes, node];
  return {
    doc: { ...doc, nodes: nextNodes },
    nodeId,
  };
}

export function addEdge(
  doc: CanvasDocument,
  options: {
    fromNode: string;
    toNode: string;
    label?: string;
    edgeId?: string;
  }
): { doc: CanvasDocument; edgeId: string } {
  const edgeId = options.edgeId || generateId("ss-edge");
  const edge: CanvasEdge = {
    id: edgeId,
    fromNode: options.fromNode,
    toNode: options.toNode,
    ...(options.label ? { label: options.label } : {}),
  };
  const nextEdges = [...doc.edges, edge];
  return { doc: { ...doc, edges: nextEdges }, edgeId };
}

export function computeNextNodePosition(
  baseNode: CanvasNode,
  options?: { dx?: number; dy?: number; defaultWidth?: number; defaultHeight?: number }
): { x: number; y: number; width: number; height: number } {
  const dx = Number.isFinite(options?.dx) ? (options?.dx as number) : 420;
  const dy = Number.isFinite(options?.dy) ? (options?.dy as number) : 0;
  const width = Math.max(160, Math.floor(options?.defaultWidth ?? 320));
  const height = Math.max(160, Math.floor(options?.defaultHeight ?? 320));

  const baseWidth = Number.isFinite(baseNode.width) ? (baseNode.width as number) : 320;
  const baseHeight = Number.isFinite(baseNode.height) ? (baseNode.height as number) : 240;
  return {
    x: baseNode.x + baseWidth + dx,
    y: baseNode.y + dy,
    width,
    height,
  };
}

export function computeNewNodePositionNearRightEdge(doc: CanvasDocument): { x: number; y: number } {
  if (doc.nodes.length === 0) return { x: 0, y: 0 };
  let maxX = doc.nodes[0].x;
  let y = doc.nodes[0].y;
  for (const node of doc.nodes) {
    if (node.x > maxX) {
      maxX = node.x;
      y = node.y;
    }
  }
  return { x: maxX + 420, y };
}
