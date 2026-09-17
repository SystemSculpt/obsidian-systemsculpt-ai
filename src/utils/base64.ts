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

export function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(base64));
}

export function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}
