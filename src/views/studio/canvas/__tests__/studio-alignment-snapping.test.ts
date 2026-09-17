import { createStudioMovementSnap, STUDIO_ALIGNMENT_SNAP_THRESHOLD_PX } from "../StudioGraphAlignmentGuides";
const moving = { left: 0, top: 0, right: 100, bottom: 100 };
const others = [{ left: 400, top: 200, right: 600, bottom: 400 }];
it.each([0.5, 1, 2])("uses a 5 screen pixel radius at zoom %s and releases from raw pointer movement", zoom => {
  const snap = createStudioMovementSnap({ moving, others, threshold: STUDIO_ALIGNMENT_SNAP_THRESHOLD_PX / zoom });
  expect(snap({ x: 300 - 5 / zoom, y: 100 - 5 / zoom })).toEqual({ x: 300, y: 100 });
  expect(snap({ x: 300 - 6 / zoom, y: 100 - 6 / zoom })).toEqual({ x: 300 - 6 / zoom, y: 100 - 6 / zoom });
  expect(snap({ x: 300 + 6 / zoom, y: 100 + 6 / zoom })).toEqual({ x: 300 + 6 / zoom, y: 100 + 6 / zoom });
});
it("snaps selection centers and leaves an out-of-range axis alone", () => {
  const snap = createStudioMovementSnap({ moving, others, threshold: 5 });
  expect(snap({ x: 446, y: 17 })).toEqual({ x: 450, y: 17 });
});
it("uses the nearest target and never changes the captured origin", () => {
  const snap = createStudioMovementSnap({ moving, others: [...others, { left: 403, right: 603, top: 203, bottom: 403 }], threshold: 5 });
  expect(snap({ x: 302, y: 102 })).toEqual({ x: 303, y: 103 });
  expect(snap({ x: 299, y: 99 })).toEqual({ x: 300, y: 100 });
  expect(moving).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
});
