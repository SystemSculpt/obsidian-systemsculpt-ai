export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Incident JSON contains a non-finite number.");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return jsonStringLiteral(value);
  if (Array.isArray(value)) {
    let serialized = "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) serialized += ",";
      serialized += canonicalJsonStringify(value[index]);
    }
    return `${serialized}]`;
  }
  if (!value || typeof value !== "object") throw new Error("Incident JSON contains an unsupported value.");

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareText);
  let serialized = "{";
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) serialized += ",";
    const key = keys[index];
    serialized += `${jsonStringLiteral(key)}:${canonicalJsonStringify(record[key])}`;
  }
  return `${serialized}}`;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonStringLiteral(value: string): string {
  let serialized = "\"";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error("Incident JSON contains malformed Unicode.");
      }
      serialized += value.slice(index, index + 2);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Incident JSON contains malformed Unicode.");
    } else if (code === 0x22) serialized += "\\\"";
    else if (code === 0x5c) serialized += "\\\\";
    else if (code === 0x08) serialized += "\\b";
    else if (code === 0x09) serialized += "\\t";
    else if (code === 0x0a) serialized += "\\n";
    else if (code === 0x0c) serialized += "\\f";
    else if (code === 0x0d) serialized += "\\r";
    else if (code <= 0x1f) serialized += `\\u${code.toString(16).padStart(4, "0")}`;
    else serialized += value[index];
  }
  return `${serialized}\"`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
