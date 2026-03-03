import type { StudioNodeInstance } from "../../../../studio/types";
import {
  isStudioCollapsedSectionApplicableToNode,
  normalizeStudioNodeDetailMode,
  readStudioNodeCollapsedVisibilityOverrides,
  resolveStudioNodeDetailSectionVisibility,
  writeStudioCollapsedSectionVisibilityOverride,
} from "../StudioGraphNodeDetailMode";

function nodeFixture(kind: string): StudioNodeInstance {
  return {
    id: `node_${kind.replace(/[^\w]+/g, "_")}`,
    kind,
    version: "1.0.0",
    title: "Node",
    position: { x: 0, y: 0 },
    config: {},
    continueOnError: false,
    disabled: false,
  };
}

describe("StudioGraphNodeDetailMode", () => {
  it("normalizes invalid node detail modes to expanded", () => {
    expect(normalizeStudioNodeDetailMode("collapsed")).toBe("collapsed");
    expect(normalizeStudioNodeDetailMode("Expanded")).toBe("expanded");
    expect(normalizeStudioNodeDetailMode("unknown")).toBe("expanded");
    expect(normalizeStudioNodeDetailMode(undefined)).toBe("expanded");
  });

  it("hides text editor by default in collapsed mode and shows it in expanded mode", () => {
    const node = nodeFixture("studio.text");
    expect(
      resolveStudioNodeDetailSectionVisibility({
        node,
        mode: "collapsed",
        section: "textEditor",
      })
    ).toBe(false);
    expect(
      resolveStudioNodeDetailSectionVisibility({
        node,
        mode: "expanded",
        section: "textEditor",
      })
    ).toBe(true);
  });

  it("writes sparse collapsed overrides and removes default-value entries", () => {
    const node = nodeFixture("studio.text");
    const changedToVisible = writeStudioCollapsedSectionVisibilityOverride({
      node,
      section: "textEditor",
      visibleInCollapsed: true,
    });
    expect(changedToVisible).toBe(true);
    expect(
      resolveStudioNodeDetailSectionVisibility({
        node,
        mode: "collapsed",
        section: "textEditor",
      })
    ).toBe(true);

    const changedBackToDefault = writeStudioCollapsedSectionVisibilityOverride({
      node,
      section: "textEditor",
      visibleInCollapsed: false,
    });
    expect(changedBackToDefault).toBe(true);
    expect(readStudioNodeCollapsedVisibilityOverrides(node)).toEqual({});
  });

  it("marks section applicability by node kind", () => {
    const textNode = nodeFixture("studio.text_generation");
    const noteNode = nodeFixture("studio.note");
    const labelNode = nodeFixture("studio.label");

    expect(isStudioCollapsedSectionApplicableToNode(textNode, "systemPrompt")).toBe(true);
    expect(isStudioCollapsedSectionApplicableToNode(noteNode, "systemPrompt")).toBe(false);
    expect(isStudioCollapsedSectionApplicableToNode(labelNode, "outputPreview")).toBe(false);
  });
});
