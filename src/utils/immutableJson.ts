/**
 * Helpers for sharing deeply frozen JSON-like graphs instead of cloning them.
 *
 * A graph whose every reachable object is frozen can never change, so owners
 * may hand it out by reference, compare it by identity, and memoize values
 * derived from it per object.
 */

const deeplyFrozen = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** True when every object reachable from `value` is frozen. Memoized per object. */
export function isDeeplyFrozen(value: unknown): boolean {
  if (!isObject(value)) return true;
  if (deeplyFrozen.has(value)) return true;
  const visited = new Set<object>();
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current) || deeplyFrozen.has(current)) continue;
    if (!Object.isFrozen(current)) return false;
    visited.add(current);
    for (const child of Object.values(current)) {
      if (isObject(child)) pending.push(child);
    }
  }
  for (const current of visited) deeplyFrozen.add(current);
  return true;
}

/**
 * Freezes every object reachable from `value` in place and returns it. Only
 * use this on graphs the caller owns; already frozen subtrees are skipped.
 */
export function deepFreeze<T>(value: T): T {
  if (!isObject(value) || deeplyFrozen.has(value)) return value;
  const visited = new Set<object>();
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current) || deeplyFrozen.has(current)) continue;
    visited.add(current);
    for (const child of Object.values(current)) {
      if (isObject(child)) pending.push(child);
    }
    Object.freeze(current);
  }
  for (const current of visited) deeplyFrozen.add(current);
  return value;
}

/**
 * Structural equality for JSON-like values. Shared references short-circuit,
 * key order is ignored and keys whose value is `undefined` count as absent,
 * which matches comparing the two values' JSON serializations.
 */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isObject(left) || !isObject(right)) {
    return typeof left === "number" && typeof right === "number"
      && Number.isNaN(left) && Number.isNaN(right);
  }
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  if (leftArray) {
    const leftItems = left as readonly unknown[];
    const rightItems = right as readonly unknown[];
    if (leftItems.length !== rightItems.length) return false;
    for (let index = 0; index < leftItems.length; index += 1) {
      if (!sameJsonValue(leftItems[index], rightItems[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  let leftCount = 0;
  for (const key of Object.keys(leftRecord)) {
    const value = leftRecord[key];
    if (value === undefined) continue;
    leftCount += 1;
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!sameJsonValue(value, rightRecord[key])) return false;
  }
  let rightCount = 0;
  for (const key of Object.keys(rightRecord)) {
    if (rightRecord[key] !== undefined) rightCount += 1;
  }
  return leftCount === rightCount;
}

/**
 * A comparison key per value: a deeply frozen value stands for itself, and
 * anything a caller could still mutate is captured as its JSON text now.
 */
export function contentKeys(values: readonly unknown[]): readonly unknown[] {
  return Object.freeze(values.map((value) =>
    isDeeplyFrozen(value) ? value : JSON.stringify(value) ?? "undefined"));
}

/** True when two `contentKeys` results describe equal content. */
export function sameContentKeys(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return left === right || (left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return entry === other || (
      typeof entry !== "string"
      && typeof other !== "string"
      && sameJsonValue(entry, other)
    );
  }));
}
