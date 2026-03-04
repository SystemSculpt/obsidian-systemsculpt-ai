import type { StudioJsonValue, StudioNodeInstance } from "../../../studio/types";
import {
  coerceNotePreviewText,
  coercePromptBundleText,
  isTextGenerationOutputLocked,
  readFirstTextValue,
  resolveTextGenerationOutputSnapshot,
  wrapPromptBundleFence,
} from "../systemsculpt-studio-view/StudioPromptBundleUtils";

const buildTextGenerationNode = (config: Record<string, unknown>): StudioNodeInstance =>
  ({
    id: "node-1",
    kind: "studio.text_generation",
    label: "Text Generation",
    position: { x: 0, y: 0 },
    width: 320,
    config,
  }) as StudioNodeInstance;

describe("StudioPromptBundleUtils", () => {
  it("coerces prompt bundle values to stable text", () => {
    expect(coercePromptBundleText("  hello  ")).toBe("hello");
    expect(coercePromptBundleText(42)).toBe("42");
    expect(coercePromptBundleText(true)).toBe("true");
    expect(coercePromptBundleText(null)).toBe("");
    expect(coercePromptBundleText({ alpha: 1 })).toBe('{\n  "alpha": 1\n}');
  });

  it("coerces note previews with optional path decoration", () => {
    const pathList = ["Notes/a.md", "Notes/b.md"] as StudioJsonValue;
    const mixedEntries = ["", 42] as StudioJsonValue;
    expect(coerceNotePreviewText(" line one ", "Notes/a.md")).toBe("Path: Notes/a.md\nline one");
    expect(coerceNotePreviewText([" First ", "Second"], pathList)).toBe(
      "Path: Notes/a.md\nFirst\n\n---\n\nPath: Notes/b.md\nSecond"
    );
    expect(coerceNotePreviewText(mixedEntries, "Notes/a.md")).toBe("");
  });

  it("reads first non-empty text value from scalar or array", () => {
    const mixedList = [null, " ", "Doc.md"] as StudioJsonValue;
    const noTextList = [null, 3] as StudioJsonValue;
    expect(readFirstTextValue("  Path.md  ")).toBe("Path.md");
    expect(readFirstTextValue(mixedList)).toBe("Doc.md");
    expect(readFirstTextValue(noTextList)).toBe("");
  });

  it("detects and snapshots locked text generation output", () => {
    const lockedNode = buildTextGenerationNode({ lockOutput: true, value: "Configured value" });
    const unlockedNode = buildTextGenerationNode({ lockOutput: false });

    expect(isTextGenerationOutputLocked(lockedNode)).toBe(true);
    expect(isTextGenerationOutputLocked(unlockedNode)).toBe(false);

    expect(
      resolveTextGenerationOutputSnapshot({
        node: lockedNode,
        runtimeText: "Runtime value",
      })
    ).toBe("Configured value");

    expect(
      resolveTextGenerationOutputSnapshot({
        node: buildTextGenerationNode({ value: "   " }),
        runtimeText: "Runtime value",
      })
    ).toBe("Runtime value");
  });

  it("wraps prompt bundle content with a safe markdown fence", () => {
    expect(wrapPromptBundleFence("json", '{"a":1}')).toBe("```json\n{\"a\":1}\n```");
    expect(wrapPromptBundleFence("text", "contains ``` fence")).toBe("~~~~text\ncontains ``` fence\n~~~~");
  });
});
