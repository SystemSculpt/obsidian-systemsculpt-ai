import { describe, expect, it } from "@jest/globals";
import type { TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { evaluateQuickEditReadiness } from "../capabilities";

const createPlugin = (overrides: Partial<SystemSculptPlugin["settings"]> = {}): SystemSculptPlugin => {
  return {
    settings: {
      selectedModelId: "openrouter/gpt-4.1-mini",
      ...overrides,
    },
  } as unknown as SystemSculptPlugin;
};

const createFile = (path: string): TFile => {
  return new (require("obsidian").TFile)({ path });
};

describe("evaluateQuickEditReadiness", () => {
  it("returns ok when model is selected and file is supported", async () => {
    const plugin = createPlugin();
    const file = createFile("Notes/Example.md");

    const result = await evaluateQuickEditReadiness({ plugin, file });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("flags missing model selection", async () => {
    const plugin = createPlugin({ selectedModelId: "" });
    const file = createFile("Docs/Example.md");

    const result = await evaluateQuickEditReadiness({ plugin, file });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-model" })
      ])
    );
  });

  it("ignores unrelated settings and still reports ready", async () => {
    const plugin = createPlugin({ debugMode: true } as any);
    const file = createFile("Docs/Example.md");

    const result = await evaluateQuickEditReadiness({ plugin, file });

    expect(result.ok).toBe(true);
  });

  it("flags unsupported file extensions", async () => {
    const plugin = createPlugin();
    const file = createFile("Images/photo.png");

    const result = await evaluateQuickEditReadiness({ plugin, file });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported-file" })
      ])
    );
  });
});
