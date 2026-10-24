import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  sha256HexFromArrayBuffer,
  sha256HexFromBytes,
  sha256HexFromBytesPortable,
} from "../sha256";

const vectors = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
] as const;

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function useCrypto(value: unknown): void {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
}

afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
  else Reflect.deleteProperty(globalThis, "crypto");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe.each(["native", "without subtle", "without crypto"] as const)("SHA-256 %s", (runtime) => {
  beforeEach(() => {
    useCrypto(runtime === "native" ? webcrypto : runtime === "without subtle" ? {} : undefined);
  });

  it.each(vectors)("hashes the known vector %j", async (text, expected) => {
    const bytes = new TextEncoder().encode(text);
    await expect(sha256HexFromBytes(bytes)).resolves.toBe(expected);
    await expect(sha256HexFromArrayBuffer(bytes.buffer)).resolves.toBe(expected);
    expect(sha256HexFromBytesPortable(bytes)).toBe(expected);
  });

  it("hashes only the selected view, including its offset and length", async () => {
    const bytes = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]);
    await expect(sha256HexFromBytes(bytes.subarray(1, 4))).resolves.toBe(vectors[1][1]);
    expect(bytes).toEqual(new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]));
  });

  it.each([55, 56, 63, 64, 65, 1024])("matches SHA-256 for %i binary bytes", async (size) => {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 256);
    await expect(sha256HexFromBytes(bytes)).resolves.toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

it("passes the existing byte view to native WebCrypto without making a full input copy", async () => {
  const digest = jest.fn(async (_algorithm: string, bytes: Uint8Array<ArrayBuffer>) =>
    webcrypto.subtle.digest("SHA-256", bytes));
  useCrypto({ subtle: { digest } });
  const input = new Uint8Array([0, 0x61, 0x62, 0x63, 0]).subarray(1, 4);
  await expect(sha256HexFromBytes(input)).resolves.toBe(vectors[1][1]);
  expect(digest).toHaveBeenCalledTimes(1);
  expect(digest.mock.calls[0][0]).toBe("SHA-256");
  expect(digest.mock.calls[0][1]).toBe(input);
});

it("passes cross-window byte views to native WebCrypto without copying", async () => {
  const digest = jest.fn(async (_algorithm: string, bytes: Uint8Array<ArrayBuffer>) =>
    webcrypto.subtle.digest("SHA-256", bytes));
  useCrypto({ subtle: { digest } });
  const input = runInNewContext("new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4)") as Uint8Array;
  expect(input.buffer instanceof ArrayBuffer).toBe(false);
  await expect(sha256HexFromBytes(input)).resolves.toBe(vectors[1][1]);
  expect(digest.mock.calls[0][1]).toBe(input);
});

it("copies only the selected shared-memory bytes into a native-compatible buffer", async () => {
  const digest = jest.fn(async (_algorithm: string, bytes: Uint8Array<ArrayBuffer>) =>
    webcrypto.subtle.digest("SHA-256", bytes));
  useCrypto({ subtle: { digest } });
  const shared = new Uint8Array(new SharedArrayBuffer(5));
  shared.set([0, 97, 98, 99, 0]);
  const input = shared.subarray(1, 4);
  await expect(sha256HexFromBytes(input)).resolves.toBe(vectors[1][1]);
  expect(digest.mock.calls[0][1]).not.toBe(input);
  expect(digest.mock.calls[0][1].buffer).toBeInstanceOf(ArrayBuffer);
  expect(digest.mock.calls[0][1]).toEqual(new Uint8Array([97, 98, 99]));
});

it("uses the global crypto in runtimes without a window", async () => {
  useCrypto(webcrypto);
  Reflect.deleteProperty(globalThis, "window");
  await expect(sha256HexFromBytes(new TextEncoder().encode("abc"))).resolves.toBe(vectors[1][1]);
});

it("does not hide a native digest failure behind synchronous fallback work", async () => {
  const failure = new Error("Native digest failed");
  const digest = jest.fn().mockRejectedValue(failure);
  useCrypto({ subtle: { digest } });
  await expect(sha256HexFromBytes(new Uint8Array([1, 2]))).rejects.toBe(failure);
  await expect(sha256HexFromArrayBuffer(new ArrayBuffer(2))).rejects.toBe(failure);
  expect(digest).toHaveBeenCalledTimes(2);
});
