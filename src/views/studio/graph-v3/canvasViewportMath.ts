export interface NodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgeEndpoints {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
}

export interface VisibleSet {
  nodeIds: string[];
  edgeIds: string[];
}

export interface FrameRenderResult {
  visibleNodes: number;
  visibleEdges: number;
  totalNodes: number;
  totalEdges: number;
}

export interface ScriptedPanResult {
  totalMs: number;
  frameCount: number;
  meanVisibleNodes: number;
  meanVisibleEdges: number;
  totalNodes: number;
  totalEdges: number;
  framesMs: number[];
  visibleNodesPerFrame: number[];
  visibleEdgesPerFrame: number[];
  visibleNodeIdsPerFrame: string[][];
}

const DEFAULT_NODE_WIDTH = 240;
const DEFAULT_NODE_HEIGHT = 120;
const VISIBLE_PADDING_PX = 200;

export function createSyntheticProject(
  nodeCount: number,
  worldWidth: number,
  worldHeight: number,
  seed: number,
): { nodes: NodeRect[]; edges: EdgeEndpoints[] } {
  const rng = makeLcg(seed);
  const nodes: NodeRect[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `n${i}`,
      x: rng() * worldWidth - worldWidth / 2,
      y: rng() * worldHeight - worldHeight / 2,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    });
  }
  const edges: EdgeEndpoints[] = [];
  for (let i = 0; i < nodeCount - 1; i++) {
    const from = nodes[i];
    const toIdx = Math.min(nodeCount - 1, i + 1 + Math.floor(rng() * 3));
    const to = nodes[toIdx];
    edges.push({ id: `e${i}`, fromNodeId: from.id, toNodeId: to.id });
    if (i % 7 === 0 && i + 5 < nodeCount) {
      edges.push({ id: `e${i}-cross`, fromNodeId: from.id, toNodeId: nodes[i + 5].id });
    }
  }
  return { nodes, edges };
}

export function createViewport(
  width: number,
  height: number,
  scrollX = 0,
  scrollY = 0,
  zoom = 1,
): Viewport {
  return { width, height, scrollX, scrollY, zoom };
}

export function getVisibleNodes(
  nodes: NodeRect[],
  viewport: Viewport,
  padding: number = VISIBLE_PADDING_PX,
): NodeRect[] {
  const worldPad = padding / viewport.zoom;
  const minX = viewport.scrollX - worldPad;
  const maxX = viewport.scrollX + viewport.width / viewport.zoom + worldPad;
  const minY = viewport.scrollY - worldPad;
  const maxY = viewport.scrollY + viewport.height / viewport.zoom + worldPad;
  const result: NodeRect[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.x + n.width < minX) continue;
    if (n.x > maxX) continue;
    if (n.y + n.height < minY) continue;
    if (n.y > maxY) continue;
    result.push(n);
  }
  return result;
}

export function getVisibleEdges(
  edges: EdgeEndpoints[],
  visibleNodeIds: Set<string>,
  nodes: Map<string, NodeRect>,
  viewport: Viewport,
  padding: number = VISIBLE_PADDING_PX,
): EdgeEndpoints[] {
  const worldPad = padding / viewport.zoom;
  const minX = viewport.scrollX - worldPad;
  const maxX = viewport.scrollX + viewport.width / viewport.zoom + worldPad;
  const minY = viewport.scrollY - worldPad;
  const maxY = viewport.scrollY + viewport.height / viewport.zoom + worldPad;
  const result: EdgeEndpoints[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (visibleNodeIds.has(edge.fromNodeId) || visibleNodeIds.has(edge.toNodeId)) {
      result.push(edge);
      continue;
    }
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) continue;
    const eMinX = Math.min(from.x, to.x);
    const eMaxX = Math.max(from.x + from.width, to.x + to.width);
    const eMinY = Math.min(from.y, to.y);
    const eMaxY = Math.max(from.y + from.height, to.y + to.height);
    if (eMaxX < minX) continue;
    if (eMinX > maxX) continue;
    if (eMaxY < minY) continue;
    if (eMinY > maxY) continue;
    result.push(edge);
  }
  return result;
}

export function computeNodeTransformString(node: NodeRect, viewport: Viewport): string {
  const screenX = (node.x - viewport.scrollX) * viewport.zoom;
  const screenY = (node.y - viewport.scrollY) * viewport.zoom;
  return `translate(${screenX.toFixed(2)}px, ${screenY.toFixed(2)}px) scale(${viewport.zoom.toFixed(3)})`;
}

export function computeEdgeBezierPath(
  from: NodeRect,
  to: NodeRect,
  viewport: Viewport,
): string {
  const fx = (from.x + from.width) * viewport.zoom - viewport.scrollX * viewport.zoom;
  const fy = (from.y + from.height / 2) * viewport.zoom - viewport.scrollY * viewport.zoom;
  const tx = to.x * viewport.zoom - viewport.scrollX * viewport.zoom;
  const ty = (to.y + to.height / 2) * viewport.zoom - viewport.scrollY * viewport.zoom;
  const dx = Math.max(40, Math.abs(tx - fx) * 0.5);
  const c1x = fx + dx;
  const c1y = fy;
  const c2x = tx - dx;
  const c2y = ty;
  return `M${fx.toFixed(2)},${fy.toFixed(2)} C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${tx.toFixed(2)},${ty.toFixed(2)}`;
}

export interface SimulatedFrame {
  visibleNodeIds: string[];
  visibleEdgeIds: string[];
  totalNodes: number;
  totalEdges: number;
}

export function simulateRenderFrame(
  nodes: NodeRect[],
  edges: EdgeEndpoints[],
  nodeIndex: Map<string, NodeRect>,
  viewport: Viewport,
): SimulatedFrame {
  const visibleNodes = getVisibleNodes(nodes, viewport);
  const visibleNodeIdSet = new Set<string>();
  const visibleNodeIds: string[] = new Array(visibleNodes.length);
  for (let i = 0; i < visibleNodes.length; i++) {
    visibleNodeIds[i] = visibleNodes[i].id;
    visibleNodeIdSet.add(visibleNodes[i].id);
    void computeNodeTransformString(visibleNodes[i], viewport);
  }
  const visibleEdges = getVisibleEdges(edges, visibleNodeIdSet, nodeIndex, viewport);
  const visibleEdgeIds: string[] = new Array(visibleEdges.length);
  for (let i = 0; i < visibleEdges.length; i++) {
    const edge = visibleEdges[i];
    visibleEdgeIds[i] = edge.id;
    const from = nodeIndex.get(edge.fromNodeId);
    const to = nodeIndex.get(edge.toNodeId);
    if (!from || !to) continue;
    void computeEdgeBezierPath(from, to, viewport);
  }
  return {
    visibleNodeIds,
    visibleEdgeIds,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  };
}

export function runScriptedPan(
  nodes: NodeRect[],
  edges: EdgeEndpoints[],
  frameCount: number,
  startViewport: Viewport,
  panFn: (frameIdx: number, viewport: Viewport) => Viewport,
): ScriptedPanResult {
  const nodeIndex = new Map<string, NodeRect>();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i].id, nodes[i]);
  let viewport = startViewport;
  const framesMs: number[] = new Array(frameCount);
  const visibleNodesPerFrame: number[] = new Array(frameCount);
  const visibleEdgesPerFrame: number[] = new Array(frameCount);
  const visibleNodeIdsPerFrame: string[][] = new Array(frameCount);
  let visibleNodesSum = 0;
  let visibleEdgesSum = 0;
  const start = performance.now();
  for (let f = 0; f < frameCount; f++) {
    viewport = panFn(f, viewport);
    const frameStart = performance.now();
    const result = simulateRenderFrame(nodes, edges, nodeIndex, viewport);
    const frameEnd = performance.now();
    framesMs[f] = frameEnd - frameStart;
    visibleNodesPerFrame[f] = result.visibleNodeIds.length;
    visibleEdgesPerFrame[f] = result.visibleEdgeIds.length;
    visibleNodeIdsPerFrame[f] = result.visibleNodeIds;
    visibleNodesSum += result.visibleNodeIds.length;
    visibleEdgesSum += result.visibleEdgeIds.length;
  }
  const totalMs = performance.now() - start;
  return {
    totalMs,
    frameCount,
    meanVisibleNodes: visibleNodesSum / frameCount,
    meanVisibleEdges: visibleEdgesSum / frameCount,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    framesMs,
    visibleNodesPerFrame,
    visibleEdgesPerFrame,
    visibleNodeIdsPerFrame,
  };
}

function makeLcg(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}
