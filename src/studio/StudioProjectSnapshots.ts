import type { StudioNodeInstance, StudioProjectV1 } from "./types";

export type DeepReadonly<T> = T extends (...args: any[]) => any
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

export function cloneStudioProjectSnapshots(projects: StudioProjectV1[]): StudioProjectV1[] {
  return projects.map((project) => cloneStudioProjectSnapshot(project));
}

export function readonlyStudioProjectSnapshot(project: StudioProjectV1): ReadonlyStudioProjectSnapshot {
  return cloneStudioProjectSnapshot(project) as ReadonlyStudioProjectSnapshot;
}

export function serializeStudioProjectSnapshot(project: StudioProjectV1): string {
  return JSON.stringify(project);
}
