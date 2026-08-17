import { readStudioDiagramFromProject } from "./StudioShapes";
import type { StudioNodeGroup, StudioProjectV1 } from "./types";

const DEFAULT_GROUP_BASENAME = "Group";
const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeNodeIds(nodeIds: string[]): string[] {
  return Array.from(
    new Set(
      nodeIds
        .map((nodeId) => String(nodeId || "").trim())
        .filter((nodeId) => nodeId.length > 0)
    )
  );
}

function readShapeIds(group: StudioNodeGroup): string[] {
  return normalizeNodeIds(group.shapeIds || []);
}

/** A group is worth keeping while it still frames anything on either layer. */
function withMembers(group: StudioNodeGroup): StudioNodeGroup {
  const shapeIds = readShapeIds(group);
  const next = { ...group, nodeIds: normalizeNodeIds(group.nodeIds || []) };
  if (shapeIds.length > 0) {
    next.shapeIds = shapeIds;
  } else {
    delete next.shapeIds;
  }
  return next;
}

function groupIsEmpty(group: StudioNodeGroup): boolean {
  return group.nodeIds.length === 0 && readShapeIds(group).length === 0;
}

function normalizeGroupName(name: string): string {
  return String(name || "").trim();
}

export function normalizeGroupColor(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.length === 4) {
    const r = lower.charAt(1);
    const g = lower.charAt(2);
    const b = lower.charAt(3);
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return lower;
}

function ensureGraphGroups(project: StudioProjectV1): StudioNodeGroup[] {
  if (!Array.isArray(project.graph.groups)) {
    project.graph.groups = [];
  }
  return project.graph.groups;
}

export function sanitizeGraphGroups(project: StudioProjectV1): boolean {
  const nodeIdSet = new Set(project.graph.nodes.map((node) => node.id));
  const shapeIdSet = new Set(readStudioDiagramFromProject(project).shapes.map((shape) => shape.id));
  const nextGroups: StudioNodeGroup[] = [];
  const seenGroupIds = new Set<string>();

  for (const group of ensureGraphGroups(project)) {
    const groupId = String(group.id || "").trim();
    const groupName = normalizeGroupName(group.name);
    const groupColor = normalizeGroupColor(group.color);
    if (!groupId || !groupName || seenGroupIds.has(groupId)) {
      continue;
    }

    const nodeIds = normalizeNodeIds(group.nodeIds || []).filter((nodeId) => nodeIdSet.has(nodeId));
    const shapeIds = readShapeIds(group).filter((shapeId) => shapeIdSet.has(shapeId));
    if (nodeIds.length === 0 && shapeIds.length === 0) {
      continue;
    }

    seenGroupIds.add(groupId);
    nextGroups.push({
      id: groupId,
      name: groupName,
      ...(groupColor ? { color: groupColor } : {}),
      nodeIds,
      ...(shapeIds.length > 0 ? { shapeIds } : {}),
    });
  }

  const previousGroups = ensureGraphGroups(project);
  const previousSerialized = JSON.stringify(previousGroups);
  const nextSerialized = JSON.stringify(nextGroups);
  if (previousSerialized === nextSerialized) {
    return false;
  }
  project.graph.groups = nextGroups;
  return true;
}

export function nextDefaultGroupName(project: StudioProjectV1): string {
  const names = new Set(
    ensureGraphGroups(project)
      .map((group) => normalizeGroupName(group.name).toLowerCase())
      .filter((name) => name.length > 0)
  );
  let index = 1;
  while (names.has(`${DEFAULT_GROUP_BASENAME} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${DEFAULT_GROUP_BASENAME} ${index}`;
}

/**
 * Groups whatever the canvas selection holds. Two members is the bar, and a
 * node and a shape count the same — grouping is a selection action, not a
 * graph one.
 */
export function createGroupFromSelection(
  project: StudioProjectV1,
  selectedNodeIds: string[],
  createGroupId: () => string,
  selectedShapeIds: string[] = []
): StudioNodeGroup | null {
  const nodeIdSet = new Set(project.graph.nodes.map((node) => node.id));
  const nodeIds = normalizeNodeIds(selectedNodeIds).filter((nodeId) => nodeIdSet.has(nodeId));
  const shapeIdSet = new Set(readStudioDiagramFromProject(project).shapes.map((shape) => shape.id));
  const shapeIds = normalizeNodeIds(selectedShapeIds).filter((shapeId) => shapeIdSet.has(shapeId));
  if (nodeIds.length + shapeIds.length < 2) {
    return null;
  }

  const selectedSet = new Set(nodeIds);
  const selectedShapeSet = new Set(shapeIds);
  const groups = ensureGraphGroups(project);
  const nextGroups = groups
    .map((group) =>
      withMembers({
        ...group,
        nodeIds: normalizeNodeIds(group.nodeIds || []).filter((nodeId) => !selectedSet.has(nodeId)),
        shapeIds: readShapeIds(group).filter((shapeId) => !selectedShapeSet.has(shapeId)),
      })
    )
    .filter((group) => !groupIsEmpty(group));

  const nextGroup: StudioNodeGroup = {
    id: createGroupId(),
    name: nextDefaultGroupName({ ...project, graph: { ...project.graph, groups: nextGroups } }),
    nodeIds,
    ...(shapeIds.length > 0 ? { shapeIds } : {}),
  };
  project.graph.groups = [...nextGroups, nextGroup];
  return nextGroup;
}

export function assignNodesToGroup(
  project: StudioProjectV1,
  groupId: string,
  nodeIds: string[]
): boolean {
  const normalizedGroupId = String(groupId || "").trim();
  if (!normalizedGroupId) {
    return false;
  }

  const existingNodeIds = new Set(project.graph.nodes.map((node) => node.id));
  const normalizedNodeIds = normalizeNodeIds(nodeIds).filter((nodeId) => existingNodeIds.has(nodeId));
  if (normalizedNodeIds.length === 0) {
    return false;
  }

  const previousGroups = ensureGraphGroups(project);
  const targetGroupIndex = previousGroups.findIndex((group) => group.id === normalizedGroupId);
  if (targetGroupIndex < 0) {
    return false;
  }

  const targetGroupNodeIds = normalizeNodeIds(previousGroups[targetGroupIndex].nodeIds || []);
  const movingIds = new Set(normalizedNodeIds);
  const nextGroups = previousGroups
    .map((group, index) => {
      if (index === targetGroupIndex) {
        const nextNodeIds = [...targetGroupNodeIds];
        nextNodeIds.push(...normalizedNodeIds.filter((nodeId) => !nextNodeIds.includes(nodeId)));
        return {
          ...group,
          nodeIds: nextNodeIds,
        };
      }
      const nextNodeIds = normalizeNodeIds(group.nodeIds || []).filter((nodeId) => !movingIds.has(nodeId));
      return {
        ...group,
        nodeIds: nextNodeIds,
      };
    })
    .filter((group, index) => !groupIsEmpty(group) || index === targetGroupIndex);

  const previousSerialized = JSON.stringify(previousGroups);
  const nextSerialized = JSON.stringify(nextGroups);
  if (previousSerialized === nextSerialized) {
    return false;
  }
  project.graph.groups = nextGroups;
  return true;
}

export function renameGroup(project: StudioProjectV1, groupId: string, name: string): boolean {
  const normalizedGroupId = String(groupId || "").trim();
  const normalizedName = normalizeGroupName(name);
  if (!normalizedGroupId || !normalizedName) {
    return false;
  }
  const groups = ensureGraphGroups(project);
  const index = groups.findIndex((group) => group.id === normalizedGroupId);
  if (index < 0) {
    return false;
  }
  if (groups[index].name === normalizedName) {
    return false;
  }
  groups[index] = {
    ...groups[index],
    name: normalizedName,
  };
  return true;
}

export function setGroupColor(
  project: StudioProjectV1,
  groupId: string,
  color: string | null | undefined
): boolean {
  const normalizedGroupId = String(groupId || "").trim();
  if (!normalizedGroupId) {
    return false;
  }
  const groups = ensureGraphGroups(project);
  const index = groups.findIndex((group) => group.id === normalizedGroupId);
  if (index < 0) {
    return false;
  }

  const normalizedColor = normalizeGroupColor(color);
  const previousColor = normalizeGroupColor(groups[index].color);
  if (normalizedColor === previousColor) {
    return false;
  }

  if (normalizedColor) {
    groups[index] = {
      ...groups[index],
      color: normalizedColor,
    };
    return true;
  }

  const nextGroup = { ...groups[index] };
  delete nextGroup.color;
  groups[index] = nextGroup;
  return true;
}

export function removeNodesFromGroups(project: StudioProjectV1, nodeIds: string[]): boolean {
  return removeMembersFromGroups(project, { nodeIds });
}

/** Deleting a shape drops it from its group, exactly like deleting a node. */
export function removeShapesFromGroups(project: StudioProjectV1, shapeIds: string[]): boolean {
  return removeMembersFromGroups(project, { shapeIds });
}

function removeMembersFromGroups(
  project: StudioProjectV1,
  members: { nodeIds?: string[]; shapeIds?: string[] }
): boolean {
  const nodesToRemove = new Set(normalizeNodeIds(members.nodeIds || []));
  const shapesToRemove = new Set(normalizeNodeIds(members.shapeIds || []));
  if (nodesToRemove.size === 0 && shapesToRemove.size === 0) {
    return false;
  }
  const previousGroups = ensureGraphGroups(project);
  const nextGroups = previousGroups
    .map((group) =>
      withMembers({
        ...group,
        nodeIds: normalizeNodeIds(group.nodeIds || []).filter((nodeId) => !nodesToRemove.has(nodeId)),
        shapeIds: readShapeIds(group).filter((shapeId) => !shapesToRemove.has(shapeId)),
      })
    )
    .filter((group) => !groupIsEmpty(group));
  const previousSerialized = JSON.stringify(previousGroups);
  const nextSerialized = JSON.stringify(nextGroups);
  if (previousSerialized === nextSerialized) {
    return false;
  }
  project.graph.groups = nextGroups;
  return true;
}
