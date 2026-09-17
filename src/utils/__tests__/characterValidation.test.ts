import {
  containsControlCharacters,
  containsNonAscii,
  replaceControlCharacters,
} from "../characterValidation";

describe("character validation", () => {
  it("detects and replaces C0, delete, and optional C1 controls", () => {
    expect(containsControlCharacters("safe\u0000value")).toBe(true);
    expect(containsControlCharacters("safe\u0085value")).toBe(false);
    expect(containsControlCharacters("safe\u0085value", true)).toBe(true);
    expect(replaceControlCharacters("a\u0000b\u007fc", "-")).toBe("a-b-c");
  });

  it("detects non-ASCII code points", () => {
    expect(containsNonAscii("plain ASCII")).toBe(false);
    expect(containsNonAscii("café")).toBe(true);
  });
});
