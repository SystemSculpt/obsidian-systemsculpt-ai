import { mentionsObsidianBases } from "../obsidianBases";

describe("mentionsObsidianBases", () => {
  it("returns false for empty input", () => {
    expect(mentionsObsidianBases("")).toBe(false);
  });

  it("detects .base extension", () => {
    expect(mentionsObsidianBases("Open Projects.base and update filters")).toBe(true);
    expect(mentionsObsidianBases("![[My Base.base]]")).toBe(true);
  });

  it("detects Obsidian Bases phrasing", () => {
    expect(mentionsObsidianBases("In Obsidian, update my bases view")).toBe(true);
    expect(mentionsObsidianBases("I used the bases prompt from the video")).toBe(true);
    expect(mentionsObsidianBases("Find my base files in this vault")).toBe(true);
    expect(mentionsObsidianBases("Create a bases database view for my vault")).toBe(true);
  });

  it("does not fire on common non-Bases uses of 'base'", () => {
    expect(mentionsObsidianBases("Decode this base64 string")).toBe(false);
    expect(mentionsObsidianBases("What's the base URL for the API?")).toBe(false);
    expect(mentionsObsidianBases("Calculate the base rate for this loan")).toBe(false);
  });
});

