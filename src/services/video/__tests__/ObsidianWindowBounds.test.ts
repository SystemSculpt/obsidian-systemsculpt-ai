/**
 * @jest-environment node
 */

import { parseObsidianWindowBounds, probeObsidianFrontWindowBounds } from "../ObsidianWindowBounds";

describe("ObsidianWindowBounds", () => {
  it("parses osascript output into rounded bounds", () => {
    const parsed = parseObsidianWindowBounds("209, 37, 1471, 936");
    expect(parsed).toEqual({
      x: 209,
      y: 37,
      width: 1471,
      height: 936,
    });
  });

  it("returns null for invalid output", () => {
    expect(parseObsidianWindowBounds("")).toBeNull();
    expect(parseObsidianWindowBounds("abc")).toBeNull();
  });

  it("returns runtime-missing when execFileSync is unavailable", () => {
    const result = probeObsidianFrontWindowBounds(null);
    expect(result.state).toBe("unavailable");
    if (result.state === "unavailable") {
      expect(result.reason).toBe("runtime-missing");
    }
  });

  it("returns available for valid window bounds", () => {
    const execFileSync = jest.fn(() => "209, 37, 1471, 936");
    const result = probeObsidianFrontWindowBounds(execFileSync);
    expect(result).toEqual({
      state: "available",
      bounds: {
        x: 209,
        y: 37,
        width: 1471,
        height: 936,
      },
    });
  });

  it("classifies automation permission denial", () => {
    const execFileSync = jest.fn(() => {
      throw new Error("Not authorized to send Apple events to System Events.");
    });
    const result = probeObsidianFrontWindowBounds(execFileSync);
    expect(result.state).toBe("unavailable");
    if (result.state === "unavailable") {
      expect(result.reason).toBe("automation-denied");
    }
  });

  it("classifies missing window conditions", () => {
    const execFileSync = jest.fn(() => {
      throw new Error("Can’t get process \"Obsidian\".");
    });
    const result = probeObsidianFrontWindowBounds(execFileSync);
    expect(result.state).toBe("unavailable");
    if (result.state === "unavailable") {
      expect(result.reason).toBe("not-open");
    }
  });
});
