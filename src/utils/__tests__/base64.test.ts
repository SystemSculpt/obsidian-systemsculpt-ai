/**
 * @jest-environment node
 */
import { isBase64 } from "../base64";

// The backtracking pattern isBase64 replaced. It is kept here only as the
// reference for short inputs, where it cannot exhaust the stack.
const LEGACY_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function* stringsOver(alphabet: readonly string[], length: number): Generator<string> {
  if (length === 0) {
    yield "";
    return;
  }
  for (const prefix of stringsOver(alphabet, length - 1)) {
    for (const character of alphabet) yield prefix + character;
  }
}

describe("isBase64", () => {
  it("accepts exactly what the legacy pattern accepted for non-empty inputs", () => {
    const mismatches: string[] = [];
    const compare = (candidate: string) => {
      if (isBase64(candidate) !== LEGACY_BASE64_PATTERN.test(candidate)) {
        mismatches.push(candidate);
      }
    };
    const alphabet = ["A", "z", "9", "+", "/", "=", "-", " "];
    for (let length = 1; length <= 4; length += 1) {
      for (const candidate of stringsOver(alphabet, length)) compare(candidate);
    }
    for (const candidate of stringsOver(["A", "=", "-"], 8)) compare(candidate);
    expect(mismatches).toEqual([]);
    expect(isBase64("")).toBe(false);
  });

  it("validates multi-megabyte payloads in one linear pass", () => {
    const sixMebibytes = Buffer.alloc(6 * 1024 * 1024, 0xa5).toString("base64");
    expect(isBase64(sixMebibytes)).toBe(true);
    expect(isBase64(Buffer.alloc(6 * 1024 * 1024 - 1, 7).toString("base64"))).toBe(true);
    expect(isBase64(`${sixMebibytes.slice(0, -4)}AA-=`)).toBe(false);
    expect(isBase64(`${sixMebibytes.slice(0, 1024)}.${sixMebibytes.slice(1025)}`)).toBe(false);
    expect(isBase64(sixMebibytes.slice(1))).toBe(false);
  });
});
