const HEX = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i];
    out += HEX[(value >> 4) & 0x0f];
    out += HEX[value & 0x0f];
  }
  return out;
}

function fallbackHashFromBytes(bytes: Uint8Array): string {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export async function sha256HexFromArrayBuffer(arrayBuffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(arrayBuffer);
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return bytesToHex(new Uint8Array(digest));
    }
  } catch {}

  return fallbackHashFromBytes(bytes);
}

