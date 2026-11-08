import type { StudioProjectV1 } from "./types";

export type DeepReadonly<T> = T extends (...args: unknown[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type ReadonlyStudioProjectSnapshot = DeepReadonly<StudioProjectV1>;

export function cloneStudioProjectSnapshot(project: StudioProjectV1): StudioProjectV1 {
  return JSON.parse(JSON.stringify(project)) as StudioProjectV1;
}

/** Capture detached JSON, reusing unchanged branches from an owned snapshot.
 * Callers must keep the returned snapshot and its shared branches immutable. */
export function captureStudioProjectSnapshot(project: StudioProjectV1, previous?: StudioProjectV1): StudioProjectV1 {
  return captureJson(project, previous) as StudioProjectV1;
}

function captureJson(value: unknown, previous: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value === previous) return previous;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const prior = Array.isArray(previous) ? previous as unknown[] : undefined;
    let next: unknown[] | undefined = prior?.length === value.length ? undefined : [];
    for (let i = 0; i < value.length; i++) {
      const item = captureJson(value[i] ?? null, prior?.[i]);
      if (!next && item !== prior![i]) next = prior!.slice(0, i);
      if (next) next.push(item);
    }
    return next ?? prior;
  }
  const source = value as Record<string, unknown>;
  const prior = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown> : undefined;
  const keys = Object.keys(source).filter(key => source[key] !== undefined);
  const sameKeys = prior && keys.length === Object.keys(prior).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(prior, key));
  let next: Record<string, unknown> | undefined = sameKeys ? undefined : {};
  for (const key of keys) {
    const item = captureJson(source[key], prior && Object.prototype.hasOwnProperty.call(prior, key) ? prior[key] : undefined);
    if (!next && item !== prior![key]) next = { ...prior };
    if (next) Object.defineProperty(next, key, { value: item, enumerable: true, configurable: true, writable: true });
  }
  return next ?? prior;
}

export function readonlyStudioProjectSnapshot(project: StudioProjectV1): ReadonlyStudioProjectSnapshot {
  return cloneStudioProjectSnapshot(project);
}

export function serializeStudioProjectSnapshot(project: StudioProjectV1): string {
  return JSON.stringify(project);
}
