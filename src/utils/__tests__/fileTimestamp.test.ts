import { formatFileTimestamp } from "../fileTimestamp";

describe("formatFileTimestamp", () => {
  it.each([
    [new Date(2026, 0, 2, 3, 4, 5), "20260102-030405"],
    [new Date(2026, 11, 31, 23, 59, 58), "20261231-235958"],
  ])("keeps local calendar fields and filename padding for %s", (date, expected) => {
    expect(formatFileTimestamp(date)).toBe(expected);
  });
});
