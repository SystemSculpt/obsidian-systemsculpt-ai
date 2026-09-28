import type { StudioNodeInstance } from "../../../../studio/types";
import {
  normalizeStudioNodeDetailMode,
  readStudioNodeCollapsedVisibilityOverrides,
  resolveStudioNodeDetailSectionVisibility,
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
    const node = nodeFixture("studio.text_output");
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

  it("preserves saved overrides and ignores unknown or malformed entries", () => {
    const node = nodeFixture("studio.text_output");
    node.config.__studioCollapsedVisibility = { textEditor: true, fieldHelp: false, outputPreview: "yes", future: true };
    expect(readStudioNodeCollapsedVisibilityOverrides(node)).toEqual({ textEditor: true, fieldHelp: false });
    expect(resolveStudioNodeDetailSectionVisibility({ node, mode: "collapsed", section: "textEditor" })).toBe(true);
    expect(resolveStudioNodeDetailSectionVisibility({ node, mode: "collapsed", section: "outputPreview" })).toBe(false);
    expect(node.config.__studioCollapsedVisibility).toEqual({ textEditor: true, fieldHelp: false, outputPreview: "yes", future: true });
  });
});
