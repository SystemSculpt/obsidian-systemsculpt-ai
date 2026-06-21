import { checkObsidianCompatibility, MINIMUM_OBSIDIAN_VERSION } from "../ObsidianCompat";

describe("checkObsidianCompatibility (#212 min-version fail-soft)", () => {
  it("supports a current version at or above the minimum", () => {
    expect(checkObsidianCompatibility("1.4.0").supported).toBe(true);
    expect(checkObsidianCompatibility("1.5.0").supported).toBe(true);
    expect(checkObsidianCompatibility("2.0.0").supported).toBe(true);
  });

  it("rejects a current version below the minimum", () => {
    expect(checkObsidianCompatibility("1.3.9").supported).toBe(false);
    expect(checkObsidianCompatibility("1.0.0").supported).toBe(false);
    expect(checkObsidianCompatibility("0.15.9").supported).toBe(false);
  });

  it("fails soft — an unknown/unreadable version is treated as supported", () => {
    // We never block on a version we cannot parse (e.g. apiVersion missing on a host).
    expect(checkObsidianCompatibility(undefined).supported).toBe(true);
    expect(checkObsidianCompatibility(null).supported).toBe(true);
    expect(checkObsidianCompatibility("").supported).toBe(true);
    expect(checkObsidianCompatibility("unknown").supported).toBe(true);
  });

  it("honors a custom minimum and reports both versions", () => {
    const result = checkObsidianCompatibility("1.5.0", "1.6.0");
    expect(result.supported).toBe(false);
    expect(result.currentVersion).toBe("1.5.0");
    expect(result.minimumVersion).toBe("1.6.0");
  });

  it("defaults the minimum to MINIMUM_OBSIDIAN_VERSION", () => {
    expect(checkObsidianCompatibility("99.0.0").minimumVersion).toBe(MINIMUM_OBSIDIAN_VERSION);
  });

  it("stays in sync with manifest.json minAppVersion (drift guard, #212)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifest = require("../../../../../manifest.json");
    expect(MINIMUM_OBSIDIAN_VERSION).toBe(manifest.minAppVersion);
  });
});
