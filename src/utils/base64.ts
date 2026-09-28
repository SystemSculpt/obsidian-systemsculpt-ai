import { arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";

/**
 * Base64 helpers backed by Obsidian's own codecs.
 *
 * Every hand-rolled copy of `btoa(String.fromCharCode(...bytes))` has to
 * remember to chunk the array, or it blows the argument limit on buffers over
 * a few hundred kilobytes. Obsidian ships tested codecs for exactly this, so
 * these wrappers only adapt the byte-view types callers already hold.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // arrayBufferToBase64 encodes a whole buffer, so a view that does not span
  // its buffer has to be copied out first.
  const spansBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return arrayBufferToBase64((spansBuffer ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer);
}

/**
 * True when `value` is non-empty, padded, standard-alphabet base64.
 *
 * A single linear scan. The obvious regex,
 * `^(?:[A-Za-z0-9+/]{4})*(?:…)?$`, backtracks once per four-character group
 * and exhausts V8's stack on multi-megabyte payloads such as pinned images.
 */
export function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.charCodeAt(value.length - 1) === 0x3d) {
    padding = value.charCodeAt(value.length - 2) === 0x3d ? 2 : 1;
  }
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!(
      (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f
    )) return false;
  }
  return true;
}

export function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(base64));
}

export function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}
