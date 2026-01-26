import { validateObsidianBasesYaml } from "../obsidianBasesYaml";

describe("validateObsidianBasesYaml", () => {
  it("accepts a valid .base YAML file", () => {
    const yaml = [
      "filters:",
      "  and:",
      "    - file.inFolder(\"Projects\")",
      "    - 'status != \"done\"'",
      "views:",
      "  - type: table",
      "    name: \"Active\"",
      "    order:",
      "      - file.name",
      "      - status",
      "",
    ].join("\n");

    expect(validateObsidianBasesYaml(yaml)).toEqual({ ok: true });
  });

  it("rejects unresolved YAML tags from unquoted leading '!'", () => {
    const yaml = [
      "filters:",
      "  and:",
      "    - !status",
      "views:",
      "  - type: table",
      "    name: \"Active\"",
      "",
    ].join("\n");

    const result = validateObsidianBasesYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join("\n")).toContain("Unresolved tag");
      expect(result.hint).toContain("quote");
    }
  });

  it("rejects tag/anchor parse errors from unquoted '!file.*()' expressions", () => {
    const yaml = [
      "filters:",
      "  - !file.inFolder(\"Projects\")",
      "views:",
      "  - type: table",
      "    name: \"Active\"",
      "",
    ].join("\n");

    const result = validateObsidianBasesYaml(yaml);
    expect(result.ok).toBe(false);
  });
});

