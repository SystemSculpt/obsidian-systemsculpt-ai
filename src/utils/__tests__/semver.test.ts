import { compareNumericVersions, parseNumericVersion } from "../semver";

describe("parseNumericVersion", () => {
  it("parses dotted integer versions, optionally v-prefixed", () => {
    expect(parseNumericVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseNumericVersion("v5.8.1")).toEqual([5, 8, 1]);
    expect(parseNumericVersion("1")).toEqual([1]);
    expect(parseNumericVersion("1.2.3.4")).toEqual([1, 2, 3, 4]);
    expect(parseNumericVersion(" 1.4.0 ")).toEqual([1, 4, 0]);
  });

  it("returns null for non-numeric / malformed input", () => {
    for (const bad of ["", "   ", "latest", "1.2.3-beta", "v", "1.x.0", "abc", "1.2.3.beta"]) {
      expect(parseNumericVersion(bad)).toBeNull();
    }
    expect(parseNumericVersion(undefined)).toBeNull();
    expect(parseNumericVersion(null)).toBeNull();
    expect(parseNumericVersion(123)).toBeNull();
  });
});

describe("compareNumericVersions", () => {
  it("orders numeric versions correctly", () => {
    expect(compareNumericVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareNumericVersions("2.0.0", "1.0.0")).toBe(1);
    expect(compareNumericVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareNumericVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareNumericVersions("1.0", "1.0.0")).toBe(0);
    expect(compareNumericVersions("1.0.1", "1.0")).toBe(1);
  });

  it("returns 0 (no ordering) when either side is unparseable", () => {
    expect(compareNumericVersions("1.0.0", "latest")).toBe(0);
    expect(compareNumericVersions("garbage", "1.0.0")).toBe(0);
    expect(compareNumericVersions("1.0.0", "")).toBe(0);
    expect(compareNumericVersions("1.0.0-beta", "1.0.0")).toBe(0);
  });
});
