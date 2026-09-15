import type { StudioNodeInstance, StudioProjectV1 } from "./types";
import { resolveStudioGraphNodeWidth, resolveStudioGraphNodeMinHeight } from "./StudioNodeGeometry";

export type StudioLayoutSize = { width: number; height: number };
export type StudioLayoutBounds = StudioLayoutSize & { id: string; x: number; y: number };
export type StudioLayoutMeasurements = ReadonlyMap<string, StudioLayoutSize>;
export type StudioLayoutReport = {
  mode: "manual" | "managed";
  nodes: StudioLayoutBounds[];
  overlaps: { first: string; second: string }[];
  truncated: boolean;
  unmeasuredNodeIds: string[];
};
type Link = { from: string; to: string };
type Block = StudioLayoutBounds & { members: StudioLayoutBounds[]; fixed: boolean };
const MAX_NODES = 2500;
const MAX_LINKS = 20000;
const MARGIN = 48;
const GROUP_PADDING = 32;
const GROUP_FOOTER = 48;

export function getStudioLayoutAnchoredNodeIds(project: StudioProjectV1): Set<string> {
  const anchored = new Set(project.graph.layout?.pinnedNodeIds || []);
  for (const group of project.graph.groups || []) {
    if (group.shapeIds?.length || group.nodeIds.some((id) => anchored.has(id))) {
      for (const id of group.nodeIds) anchored.add(id);
    }
  }
  return anchored;
}

function checkBudget(project: StudioProjectV1): void {
  if (project.graph.nodes.length + (project.diagram?.shapes.length || 0) > MAX_NODES || project.graph.edges.length > MAX_LINKS) {
    throw new Error(`Automatic layout supports at most ${MAX_NODES} canvas items and ${MAX_LINKS} connections.`);
  }
}
function dimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.ceil(Number(value)) : fallback;
}
function boundsFor(node: StudioNodeInstance, measurements: StudioLayoutMeasurements): StudioLayoutBounds {
  const measured = measurements.get(node.id);
  return { id: node.id, ...node.position,
    width: dimension(measured?.width, resolveStudioGraphNodeWidth(node)),
    height: dimension(measured?.height, resolveStudioGraphNodeMinHeight(node)) };
}
function intersects(a: StudioLayoutBounds, b: StudioLayoutBounds, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

/** Deterministic layered placement. Cycles become feedback edges, never an endless traversal. */
function layer(items: StudioLayoutBounds[], links: Link[], direction: "right" | "down", columnGap: number, rowGap: number): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  const successors = new Map(items.map((item) => [item.id, new Set<string>()]));
  const incoming = new Map(items.map((item) => [item.id, 0]));
  const rank = new Map(items.map((item) => [item.id, 0]));
  for (const link of links) {
    if (link.from === link.to || !byId.has(link.from) || !byId.has(link.to) || successors.get(link.from)?.has(link.to)) continue;
    successors.get(link.from)?.add(link.to);
    incoming.set(link.to, (incoming.get(link.to) || 0) + 1);
  }
  const pending = new Set(byId.keys());
  const queue = items.filter((item) => incoming.get(item.id) === 0).map((item) => item.id);
  let cursor = 0;
  while (pending.size) {
    if (cursor === queue.length) queue.push(pending.values().next().value as string);
    const id = queue[cursor++];
    if (!pending.delete(id)) continue;
    for (const next of successors.get(id) || []) {
      if (!pending.has(next)) continue;
      rank.set(next, Math.max(rank.get(next) || 0, (rank.get(id) || 0) + 1));
      incoming.set(next, (incoming.get(next) || 0) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  const layers = new Map<number, StudioLayoutBounds[]>();
  for (const item of items) {
    const index = rank.get(item.id) || 0;
    const entries = layers.get(index) || [];
    entries.push(item); layers.set(index, entries);
  }
  let major = 0;
  for (const [, entries] of [...layers].sort(([a], [b]) => a - b)) {
    let minor = 0, extent = 0;
    for (const item of entries) {
      item.x = direction === "right" ? major : minor;
      item.y = direction === "right" ? minor : major;
      minor += (direction === "right" ? item.height : item.width) + rowGap;
      extent = Math.max(extent, direction === "right" ? item.width : item.height);
    }
    major += extent + columnGap;
  }
}


/** Parent-only collections read as a compact outline, not a column of empty space beside each heading. */
function outline(items: StudioLayoutBounds[], nodes: Map<string, StudioNodeInstance>, gap: number): void {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, StudioLayoutBounds[]>();
  const roots: StudioLayoutBounds[] = [];
  for (const item of items) {
    const parent = nodes.get(item.id)?.parentId;
    if (parent && ids.has(parent)) {
      const siblings = children.get(parent) || [];
      siblings.push(item); children.set(parent, siblings);
    } else roots.push(item);
  }
  const visited = new Set<string>();
  const stack = roots.slice().reverse().map((item) => ({ item, depth: 0 }));
  let y = 0;
  while (visited.size < items.length) {
    if (!stack.length) stack.push({ item: items.find((item) => !visited.has(item.id))!, depth: 0 });
    const { item, depth } = stack.pop()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id); item.x = Math.min(depth, 12) * 32; item.y = y;
    y += item.height + gap;
    for (const child of (children.get(item.id) || []).slice().reverse()) stack.push({ item: child, depth: depth + 1 });
  }
}

/** Coordinates are derived from structure and measured geometry, never from previous free placement. */
export function arrangeStudioGraph(project: StudioProjectV1, measurements: StudioLayoutMeasurements = new Map()): string[] {
  checkBudget(project);
  const layout = project.graph.layout;
  const columnGap = dimension(layout?.columnGap, 96), rowGap = dimension(layout?.rowGap, 40);
  const sectionGap = dimension(layout?.sectionGap, 112);
  const pinned = new Set(layout?.pinnedNodeIds || []);
  const nodes = new Map(project.graph.nodes.map((node) => [node.id, node]));
  const geometry = new Map(project.graph.nodes.map((node) => [node.id, boundsFor(node, measurements)]));
  const links: Link[] = project.graph.edges.map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId }));
  for (const node of nodes.values()) if (node.parentId && nodes.has(node.parentId)) links.push({ from: node.parentId, to: node.id });
  const blocks: Block[] = [];
  const groupRoots = new Set<string>();
  const blockByNode = new Map<string, string>();
  for (const group of project.graph.groups || []) {
    const members = group.nodeIds.filter((id) => geometry.has(id) && !blockByNode.has(id)).map((id) => ({ ...geometry.get(id)! }));
    if (!members.length) continue;
    const fixed = members.some((member) => pinned.has(member.id)) || Boolean(group.shapeIds?.length);
    const id = `group:${group.id}`;
    for (const member of members) blockByNode.set(member.id, id);
    groupRoots.add(members[0].id);
    if (!fixed) {
      const memberIds = new Set(members.map((member) => member.id));
      const hasDataFlow = project.graph.edges.some((edge) => memberIds.has(edge.fromNodeId) && memberIds.has(edge.toNodeId));
      if (hasDataFlow) layer(members, links, "right", columnGap, rowGap);
      else if (members.some(member => memberIds.has(nodes.get(member.id)?.parentId || ''))) outline(members, nodes, rowGap);
      // Unconnected peers share a rank. A frame alone must not imply a serial flow.
      else layer(members, [], layout?.direction || 'down', columnGap, rowGap);
    }
    const minX = Math.min(...members.map((member) => member.x)), minY = Math.min(...members.map((member) => member.y));
    const maxX = Math.max(...members.map((member) => member.x + member.width));
    const maxY = Math.max(...members.map((member) => member.y + member.height));
    const block = { id, x: minX - GROUP_PADDING, y: minY - GROUP_PADDING,
      width: maxX - minX + GROUP_PADDING * 2, height: maxY - minY + GROUP_PADDING * 2 + GROUP_FOOTER, members, fixed };
    for (const member of members) { member.x -= block.x; member.y -= block.y; }
    blocks.push(block);
  }
  for (const bound of geometry.values()) {
    if (blockByNode.has(bound.id)) continue;
    const id = `node:${bound.id}`;
    blockByNode.set(bound.id, id);
    blocks.push({ ...bound, id, members: [{ ...bound, x: 0, y: 0 }], fixed: pinned.has(bound.id) });
  }
  const movable = blocks.filter((block) => !block.fixed);
  // A ticket's cross-group parent is a cross-reference, not ancestry of its entire lane.
  // Data-flow connections and section roots determine placement between sections.
  const outerLinks = project.graph.edges.map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId }));
  for (const node of nodes.values()) if (node.parentId && (!blockByNode.get(node.id)?.startsWith("group:") || groupRoots.has(node.id))) {
    outerLinks.push({ from: node.parentId, to: node.id });
  }
  layer(movable, outerLinks.map((link) => ({ from: blockByNode.get(link.from) || "", to: blockByNode.get(link.to) || "" })), layout?.direction || "down", sectionGap, sectionGap);
  movable.sort((a, b) => layout?.direction === "right" ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x);
  const occupied: StudioLayoutBounds[] = blocks.filter((block) => block.fixed);
  for (const shape of project.diagram?.shapes || []) occupied.push({ id: `shape:${shape.id}`, ...shape.position, ...shape.size });
  // Fixed drawings and pinned groups are obstacles. Resolve by moving whole sections so their members stay together.
  for (const block of movable) {
    block.x += MARGIN; block.y += MARGIN;
    for (let attempt = 0; attempt <= occupied.length; attempt++) {
      let bottom = block.y;
      for (const obstacle of occupied) if (intersects(block, obstacle, sectionGap)) bottom = Math.max(bottom, obstacle.y + obstacle.height + sectionGap);
      if (bottom === block.y) break;
      block.y = bottom;
    }
    occupied.push(block);
  }
  const moved: string[] = [];
  for (const block of blocks) for (const member of block.members) {
    const node = nodes.get(member.id)!;
    const x = Math.round(block.x + member.x), y = Math.round(block.y + member.y);
    if (node.position.x !== x || node.position.y !== y) { node.position = { x, y }; moved.push(node.id); }
  }
  return moved;
}

/** Bounded diagnostics for agents and the view; missing measurements are explicit. */
export function inspectStudioGraphLayout(project: StudioProjectV1, measurements: StudioLayoutMeasurements = new Map()): StudioLayoutReport {
  checkBudget(project);
  const nodes = project.graph.nodes.map((node) => boundsFor(node, measurements));
  const all = [...nodes, ...(project.diagram?.shapes || []).map((shape) => ({ id: `shape:${shape.id}`, ...shape.position, ...shape.size }))].sort((a, b) => a.x - b.x);
  const overlaps: StudioLayoutReport["overlaps"] = [];
  let truncated = false, comparisons = 0;
  outer: for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length && all[j].x < all[i].x + all[i].width; j++) {
    if (++comparisons > 200000 || overlaps.length >= 200) { truncated = true; break outer; }
    if (intersects(all[i], all[j])) overlaps.push({ first: all[i].id, second: all[j].id });
  }
  return { mode: project.graph.layout?.mode || "manual", nodes, overlaps, truncated,
    unmeasuredNodeIds: nodes.filter((node) => !measurements.has(node.id)).map((node) => node.id) };
}
