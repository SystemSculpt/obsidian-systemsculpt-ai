/**
 * The single owner of incident JSON bytes.
 *
 * canonicalJsonStringify is the only projection and encoding applied to an
 * incident report: the recorder sizes its reports with it and the store
 * persists exactly the bytes it returns, so the two cannot drift. It reads own
 * data properties through descriptors and never invokes getters, toJSON hooks
 * and fails closed when object inspection throws. It rejects cycles, symbol keys, accessors, non-plain
 * prototypes, reserved keys, sparse arrays, non-finite numbers and malformed
 * UTF-16, and emits RFC 8785 output (property names sorted by UTF-16 code
 * unit, arrays in order, shortest round-trip numbers).
 */

const MAX_DEPTH = 64;
const MAX_VALUES = 100_000;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

export type CanonicalJsonFailure = "invalid" | "too_large";

export class CanonicalJsonError extends Error {
  constructor(public readonly reason: CanonicalJsonFailure, message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export interface CanonicalJsonLimits {
  /** Stop early once strings and property names exceed this many UTF-16 code units. */
  readonly maximumCodeUnits?: number;
}

export function canonicalJsonStringify(value: unknown, limits: CanonicalJsonLimits = {}): string {
  const maximumCodeUnits = limits.maximumCodeUnits ?? Number.POSITIVE_INFINITY;
  const seen = new Set<object>();
  let values = 0;
  let codeUnits = 0;

  const countText = (text: string): void => {
    codeUnits += text.length;
    if (codeUnits > maximumCodeUnits) throw new CanonicalJsonError("too_large", "Incident JSON exceeds the size limit.");
    if (!hasWellFormedUtf16(text)) throw new CanonicalJsonError("invalid", "Incident JSON contains malformed Unicode.");
  };

  const ownValue = (target: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    return descriptor.value;
  };

  const visit = (current: unknown, depth: number): string => {
    values += 1;
    if (values > MAX_VALUES || depth > MAX_DEPTH) invalid();
    if (current === null) return "null";
    if (current === true) return "true";
    if (current === false) return "false";
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new CanonicalJsonError("invalid", "Incident JSON contains a non-finite number.");
      return Object.is(current, -0) ? "0" : String(current);
    }
    if (typeof current === "string") {
      countText(current);
      return jsonStringLiteral(current);
    }
    if (typeof current !== "object") throw new CanonicalJsonError("invalid", "Incident JSON contains an unsupported value.");
    if (seen.has(current)) invalid();

    const prototype = Object.getPrototypeOf(current) as object | null;
    const keys = Reflect.ownKeys(current);
    if (keys.length > MAX_VALUES - values || keys.some((key) => typeof key === "symbol")) invalid();
    const names = keys as string[];
    seen.add(current);
    let serialized: string;
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) invalid();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
      const length: unknown = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || names.length !== length + 1) invalid();
      for (const name of names) {
        if (name !== "length" && (!ARRAY_INDEX.test(name) || Number(name) >= length)) invalid();
      }
      serialized = "[";
      for (let index = 0; index < length; index += 1) {
        if (index > 0) serialized += ",";
        serialized += visit(ownValue(current, String(index)), depth + 1);
      }
      serialized += "]";
    } else {
      if (prototype !== Object.prototype && prototype !== null) invalid();
      for (const name of names) {
        if (RESERVED_KEYS.has(name)) invalid();
        countText(name);
      }
      names.sort(compareText);
      serialized = "{";
      for (let index = 0; index < names.length; index += 1) {
        if (index > 0) serialized += ",";
        serialized += `${jsonStringLiteral(names[index])}:${visit(ownValue(current, names[index]), depth + 1)}`;
      }
      serialized += "}";
    }
    seen.delete(current);
    return serialized;
  };

  try {
    return visit(value, 0);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw error;
    invalid();
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(): never {
  throw new CanonicalJsonError("invalid", "Incident JSON contains an unsupported value.");
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      // A high surrogate at the very end has no pair: charCodeAt returns NaN
      // there, and NaN fails both range comparisons below.
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Escape an already well-formed string as a JSON literal. */
function jsonStringLiteral(value: string): string {
  let serialized = "\"";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) serialized += '\\"';
    else if (code === 0x5c) serialized += "\\\\";
    else if (code === 0x08) serialized += "\\b";
    else if (code === 0x09) serialized += "\\t";
    else if (code === 0x0a) serialized += "\\n";
    else if (code === 0x0c) serialized += "\\f";
    else if (code === 0x0d) serialized += "\\r";
    else if (code <= 0x1f) serialized += `\\u${code.toString(16).padStart(4, "0")}`;
    else serialized += value[index];
  }
  return `${serialized}"`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
