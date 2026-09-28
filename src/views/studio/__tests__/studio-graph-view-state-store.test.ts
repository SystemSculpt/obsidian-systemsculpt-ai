import {
  getSavedGraphViewState,
  getSavedNodeDetailMode,
  parseGraphViewStateByProject,
  parseNodeDetailModeByProject,
  serializeGraphViewStateByProject,
  serializeNodeDetailModeByProject,
  upsertGraphViewStateForProject,
} from "../canvas/StudioGraphViewStateStore";

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

describe("StudioGraphViewStateStore graph view (world coordinates)", () => {
  it("keeps negative world coordinates: the canvas has no corner", () => {
    const parsed = parseGraphViewStateByProject({ "A.systemsculpt": { x: -4200.5, y: -300, zoom: 0.5 } });
    expect(parsed["A.systemsculpt"]).toEqual({ x: -4200.5, y: -300, zoom: 0.5 });
    expect(serializeGraphViewStateByProject(parsed)["A.systemsculpt"]).toEqual({ x: -4200.5, y: -300, zoom: 0.5 });
    expect(getSavedGraphViewState(parsed, "A.systemsculpt")).toEqual({ x: -4200.5, y: -300, zoom: 0.5 });
  });

  it("converts legacy fixed-canvas scroll offsets into world coordinates", () => {
    const parsed = parseGraphViewStateByProject({ "Old.systemsculpt": { scrollLeft: 800, scrollTop: 400, zoom: 2 } });
    expect(parsed["Old.systemsculpt"]).toEqual({ x: 400, y: 200, zoom: 2 });
  });

  it("only reports a change when the view really moved", () => {
    const first = upsertGraphViewStateForProject({}, "A", { x: 10, y: 20, zoom: 1 });
    expect(first.changed).toBe(true);
    const same = upsertGraphViewStateForProject(first.nextStateByProjectPath, "A", { x: 10.2, y: 20, zoom: 1 });
    expect(same.changed).toBe(false);
    const moved = upsertGraphViewStateForProject(first.nextStateByProjectPath, "A", { x: -50, y: 20, zoom: 1 });
    expect(moved.changed).toBe(true);
  });
});
