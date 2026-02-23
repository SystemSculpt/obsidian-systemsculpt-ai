import type { StudioNodeGroup, StudioProjectV1 } from "../../../studio/types";

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

export function ensureGraphGroups(project: StudioProjectV1): StudioNodeGroup[] {
  if (!Array.isArray(project.graph.groups)) {
    project.graph.groups = [];
  }
  return project.graph.groups;
}

export function sanitizeGraphGroups(project: StudioProjectV1): boolean {
  const nodeIdSet = new Set(project.graph.nodes.map((node) => node.id));
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
    if (nodeIds.length === 0) {
      continue;
    }

    seenGroupIds.add(groupId);
    nextGroups.push({
      id: groupId,
      name: groupName,
      ...(groupColor ? { color: groupColor } : {}),
      nodeIds,
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

export function createGroupFromSelection(
  project: StudioProjectV1,
  selectedNodeIds: string[],
  createGroupId: () => string
): StudioNodeGroup | null {
  const nodeIdSet = new Set(project.graph.nodes.map((node) => node.id));
  const nodeIds = normalizeNodeIds(selectedNodeIds).filter((nodeId) => nodeIdSet.has(nodeId));
  if (nodeIds.length < 2) {
    return null;
  }

  const selectedSet = new Set(nodeIds);
  const groups = ensureGraphGroups(project);
  const nextGroups = groups
    .map((group) => ({
      ...group,
      nodeIds: normalizeNodeIds(group.nodeIds || []).filter((nodeId) => !selectedSet.has(nodeId)),
    }))
    .filter((group) => group.nodeIds.length > 0);

  const nextGroup: StudioNodeGroup = {
    id: createGroupId(),
    name: nextDefaultGroupName({ ...project, graph: { ...project.graph, groups: nextGroups } }),
    nodeIds,
  };
  project.graph.groups = [...nextGroups, nextGroup];
  return nextGroup;
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
  const toRemove = new Set(normalizeNodeIds(nodeIds));
  if (toRemove.size === 0) {
    return false;
  }
  const previousGroups = ensureGraphGroups(project);
  const nextGroups = previousGroups
    .map((group) => ({
      ...group,
      nodeIds: normalizeNodeIds(group.nodeIds || []).filter((nodeId) => !toRemove.has(nodeId)),
    }))
    .filter((group) => group.nodeIds.length > 0);
  const previousSerialized = JSON.stringify(previousGroups);
  const nextSerialized = JSON.stringify(nextGroups);
  if (previousSerialized === nextSerialized) {
    return false;
  }
  project.graph.groups = nextGroups;
  return true;
}
