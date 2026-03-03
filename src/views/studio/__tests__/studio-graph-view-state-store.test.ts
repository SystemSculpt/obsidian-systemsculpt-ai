import {
  getSavedNodeDetailMode,
  parseNodeDetailModeByProject,
  serializeNodeDetailModeByProject,
} from "../graph-v3/StudioGraphViewStateStore";

describe("StudioGraphViewStateStore node detail mode", () => {
  it("parses per-project node detail mode map and normalizes invalid entries", () => {
    const parsed = parseNodeDetailModeByProject({
      "SystemSculpt/Studio/A.systemsculpt": "collapsed",
      "SystemSculpt/Studio/B.systemsculpt": "unknown",
      "": "collapsed",
    });

    expect(parsed).toEqual({
      "SystemSculpt/Studio/A.systemsculpt": "collapsed",
      "SystemSculpt/Studio/B.systemsculpt": "expanded",
    });
  });

  it("serializes detail mode map and falls back to expanded when project is missing", () => {
    const serialized = serializeNodeDetailModeByProject({
      "SystemSculpt/Studio/A.systemsculpt": "collapsed",
    });

    expect(serialized).toEqual({
      "SystemSculpt/Studio/A.systemsculpt": "collapsed",
    });
    expect(
      getSavedNodeDetailMode(serialized, "SystemSculpt/Studio/A.systemsculpt")
    ).toBe("collapsed");
    expect(getSavedNodeDetailMode(serialized, "SystemSculpt/Studio/Unknown.systemsculpt")).toBe("expanded");
  });
});
