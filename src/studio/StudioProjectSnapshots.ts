import { getStudioLayoutAnchoredNodeIds } from "./StudioGraphLayout";
import type { StudioNodeInstance, StudioProjectV1 } from "./types";

export type DeepReadonly<T> = T extends (...args: unknown[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type ReadonlyStudioProjectSnapshot = DeepReadonly<StudioProjectV1>;
export type ReadonlyStudioNodeSnapshot = DeepReadonly<StudioNodeInstance>;

export function cloneStudioProjectSnapshot(project: StudioProjectV1): StudioProjectV1 {
  return JSON.parse(JSON.stringify(project)) as StudioProjectV1;
}

export function readonlyStudioProjectSnapshot(project: StudioProjectV1): ReadonlyStudioProjectSnapshot {
  return cloneStudioProjectSnapshot(project);
}

export function serializeStudioProjectSnapshot(project: StudioProjectV1): string {
  if (project.graph.layout?.mode !== "managed") return JSON.stringify(project);
  const snapshot = cloneStudioProjectSnapshot(project);
  const anchored = getStudioLayoutAnchoredNodeIds(project);
  for (const node of snapshot.graph.nodes) if (!anchored.has(node.id)) node.position = { x: 0, y: 0 };
  return JSON.stringify(snapshot);
}
