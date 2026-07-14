import { collectSuccessfulToolArtifactPaths, collectToolArtifactPaths } from "../toolArtifacts";

describe("collectToolArtifactPaths", () => {
  it("collects every destination from a batch move", () => {
    expect(collectToolArtifactPaths(
      "move",
      { items: [
        { source: "Drafts/One.md", destination: "Archive/One.md" },
        { source: "Drafts/Two.md", destination: "Archive/Two.md" },
      ] },
      { results: [
        { success: true, path: "Archive/One.md" },
        { success: true, path: "Archive/Two.md" },
      ] },
    )).toEqual(expect.arrayContaining(["Archive/One.md", "Archive/Two.md"]));
  });

  it("collects every file from multi-file reads and edits", () => {
    expect(collectToolArtifactPaths(
      "read",
      { paths: ["One.md", "Two.md"] },
      { results: [{ path: "One.md" }, { path: "Two.md" }] },
    )).toEqual(["One.md", "Two.md"]);
    expect(collectToolArtifactPaths(
      "multi_edit",
      { files: [{ path: "One.md", edits: [] }, { path: "Two.md", edits: [] }] },
      undefined,
    )).toEqual(["One.md", "Two.md"]);
  });

  it("does not turn search results into artifact-card spam", () => {
    expect(collectToolArtifactPaths(
      "search",
      { patterns: ["TODO"] },
      { results: [{ path: "One.md" }, { path: "Two.md" }] },
    )).toEqual([]);
  });

  it("reports only explicitly successful paths from partial mutations", () => {
    expect(collectSuccessfulToolArtifactPaths("multi_edit", {
      results: [
        { path: "Changed.md", success: true },
        { path: "Failed.md", success: false, error: "Conflict" },
      ],
    })).toEqual(["Changed.md"]);
    expect(collectSuccessfulToolArtifactPaths("move", {
      results: [
        { source: "A.md", destination: "Archive/A.md", success: true },
        { source: "B.md", destination: "Archive/B.md", success: false, error: "Conflict" },
      ],
    })).toEqual(["Archive/A.md"]);
  });
});
