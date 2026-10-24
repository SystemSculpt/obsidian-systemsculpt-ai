import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  createSha256,
  sha256HexFromArrayBuffer,
  sha256HexFromBytes,
  sha256HexFromBytesPortable,
} from "../sha256";

const vectors = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
  ["abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu", "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"],
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

describe("incremental SHA-256", () => {
  it.each(vectors)("hashes the known vector %j one byte at a time", (text, expected) => {
    const bytes = new TextEncoder().encode(text);
    const hasher = createSha256();
    for (let offset = 0; offset < bytes.length; offset += 1) {
      expect(hasher.update(bytes.subarray(offset, offset + 1))).toBe(hasher);
    }
    expect(hasher.digestHex()).toBe(expected);
  });

  it("hashes the million-a known vector without a whole-message buffer", () => {
    const chunk = new Uint8Array(1000).fill(0x61);
    const hasher = createSha256();
    for (let index = 0; index < 1000; index += 1) hasher.update(chunk);
    expect(hasher.digestHex()).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it.each([0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1024])(
    "matches native SHA-256 at every two-chunk split of %i bytes",
    (size) => {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 37 + 11) % 256);
      const expected = createHash("sha256").update(bytes).digest("hex");
      for (let split = 0; split <= size; split += 1) {
        const hasher = createSha256();
        hasher.update(bytes.subarray(0, split));
        hasher.update(new Uint8Array(0));
        hasher.update(bytes.subarray(split));
        expect(hasher.digestHex()).toBe(expected);
      }
    },
  );

  it("matches native SHA-256 across deterministic arbitrary chunk boundaries", () => {
    const bytes = Uint8Array.from({ length: 8193 }, (_, index) => (index * 23 + 197) % 256);
    const expected = createHash("sha256").update(bytes).digest("hex");
    for (let seed = 1; seed <= 20; seed += 1) {
      const hasher = createSha256();
      let random = seed;
      for (let offset = 0; offset < bytes.length;) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const end = Math.min(bytes.length, offset + 1 + random % 257);
        hasher.update(bytes.subarray(offset, end));
        offset = end;
      }
      expect(hasher.digestHex()).toBe(expected);
    }
  });

  it("hashes only selected subviews without changing their backing bytes", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
    const original = bytes.slice();
    const expected = createHash("sha256").update(bytes.subarray(11, 184)).digest("hex");
    const hasher = createSha256();
    hasher.update(bytes.subarray(11, 16));
    hasher.update(bytes.subarray(16, 120));
    hasher.update(bytes.subarray(120, 184));
    expect(hasher.digestHex()).toBe(expected);
    expect(sha256HexFromBytesPortable(bytes.subarray(11, 184))).toBe(expected);
    expect(bytes).toEqual(original);
  });

  it("accepts cross-window and shared-memory subviews", () => {
    const foreign = runInNewContext(
      "Uint8Array.from({ length: 139 }, (_, index) => index).subarray(3, 132)",
    ) as Uint8Array;
    const shared = new Uint8Array(new SharedArrayBuffer(139));
    shared.set(Uint8Array.from({ length: 139 }, (_, index) => index));
    const expected = createHash("sha256").update(foreign).digest("hex");
    expect(createSha256().update(foreign).digestHex()).toBe(expected);
    expect(createSha256().update(shared.subarray(3, 132)).digestHex()).toBe(expected);
  });

  it.each([1, 63, 64, 65, 137])("consumes %i-byte chunks before callers reuse or mutate them", (size) => {
    const chunk = new Uint8Array(size);
    const hasher = createSha256();
    const native = createHash("sha256");
    for (let round = 0; round < 128; round += 1) {
      for (let index = 0; index < chunk.length; index += 1) chunk[index] = (round + index) % 256;
      native.update(chunk);
      hasher.update(chunk);
      chunk.fill(0xff);
    }
    expect(hasher.digestHex()).toBe(native.digest("hex"));
  });

  it("keeps typed-array allocation bounded for streamed and whole-buffer portable hashing", () => {
    const chunk = new Uint8Array(4093).fill(0x61);
    const input = new Uint8Array(chunk.length * 257).fill(0x61);
    const expected = createHash("sha256").update(input).digest("hex");
    const originalUint8Array = globalThis.Uint8Array;
    const originalUint32Array = globalThis.Uint32Array;
    let allocatedBytes = 0;
    let streamedDigest: string;
    let wholeDigest: string;
    // Count owned typed-array storage, not borrowed input views. The budget is
    // constant across hundreds of updates and a single megabyte-sized update.
    globalThis.Uint8Array = new Proxy(originalUint8Array, {
      construct(target, args) {
        const array = Reflect.construct(target, args) as Uint8Array;
        allocatedBytes += array.byteLength;
        return array;
      },
    });
    globalThis.Uint32Array = new Proxy(originalUint32Array, {
      construct(target, args) {
        const array = Reflect.construct(target, args) as Uint32Array;
        allocatedBytes += array.byteLength;
        return array;
      },
    });
    try {
      const hasher = createSha256();
      for (let index = 0; index < 257; index += 1) hasher.update(chunk);
      streamedDigest = hasher.digestHex();
      wholeDigest = sha256HexFromBytesPortable(input);
    } finally {
      globalThis.Uint8Array = originalUint8Array;
      globalThis.Uint32Array = originalUint32Array;
    }
    expect(streamedDigest).toBe(expected);
    expect(wholeDigest).toBe(expected);
    expect(allocatedBytes).toBeLessThanOrEqual(2048);
  });

  it("keeps interleaved hasher instances independent", () => {
    const first = createSha256().update(new Uint8Array([0x61]));
    const second = createSha256().update(new Uint8Array([0x62]));
    first.update(new Uint8Array([0x62, 0x63]));
    expect(first.digestHex()).toBe(vectors[1][1]);
    second.update(new Uint8Array([0x63]));
    expect(second.digestHex()).toBe(createHash("sha256").update("bc").digest("hex"));
  });

  it.each([0, 3, 55, 56, 63, 64, 65, 120])("finalizes %i bytes once and rejects further updates", (size) => {
    const bytes = new Uint8Array(size).fill(0xa5);
    const hasher = createSha256().update(bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(hasher.digestHex()).toBe(expected);
    expect(hasher.digestHex()).toBe(expected);
    expect(() => hasher.update(new Uint8Array(0))).toThrow(/finalized/i);
    expect(() => hasher.update(new Uint8Array([1]))).toThrow(/finalized/i);
    expect(hasher.digestHex()).toBe(expected);
  });

  it("does not depend on native WebCrypto", () => {
    const digest = jest.fn(() => { throw new Error("Unexpected native digest"); });
    useCrypto({ subtle: { digest } });
    expect(createSha256().update(new TextEncoder().encode("abc")).digestHex()).toBe(vectors[1][1]);
    expect(digest).not.toHaveBeenCalled();
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
