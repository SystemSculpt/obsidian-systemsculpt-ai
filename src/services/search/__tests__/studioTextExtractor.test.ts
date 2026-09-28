import { extractStudioText } from "../studioTextExtractor";

const extract = (document: unknown, maxChars = 10_000) =>
  extractStudioText(JSON.stringify(document), { maxChars });

describe("extractStudioText", () => {
  it("extracts authored content from legacy v1 projects", () => {
    expect(extract({
      schema: "studio.project.v1",
      projectId: "project-identity",
      name: "Interview pipeline",
      graph: {
        nodes: [{
          id: "node-identity", kind: "studio.text_generation", version: "1.0.0",
          title: "Summarize interview", position: { x: 20, y: 30 },
          config: { systemPrompt: "Find the key insights", context: ["Research notes", { text: "Customer feedback" }] },
        }],
        groups: [{ id: "group-identity", name: "Research", nodeIds: ["node-identity"] }],
        edges: [{ id: "edge-identity", fromNodeId: "source-identity" }],
      },
      diagram: {
        shapes: [{ id: "shape-identity", shape: "note", label: "Review before publishing", style: { fill: "magenta" } }],
        arrows: [{ id: "arrow-identity", fromShapeId: "shape-identity", toShapeId: "node-identity", label: "Next step" }],
      },
    })).toBe("Interview pipeline\nSummarize interview\nFind the key insights\nResearch notes\nCustomer feedback\nResearch\nReview before publishing\nNext step");
  });

  it("extracts v2 canvas nodes, groups, shapes and labeled arrows", () => {
    expect(extract({
      schema: "studio.project.v2", id: "project-identity", name: "Launch checklist", docs: "SystemSculpt/Studio/AGENTS.md",
      canvas: {
        layout: { mode: "managed", direction: "down" },
        nodes: [
          { id: "brief", kind: "text", title: "Brief", config: { text: "Prepare the announcement" } },
          { id: "script", kind: "script", config: { source: "return 'launch';", arguments: ["--preview"] } },
          { id: "notes", kind: "note", config: { path: "Projects/Launch.md" } },
        ],
        groups: [{ id: "team", name: "Marketing", nodes: ["brief", "script"] }],
        shapes: [{ id: "decision", shape: "diamond", label: "Ready to ship?" }],
        arrows: ["brief -> script", { from: "script", to: "decision", label: "Review" }],
        edges: ["brief.text -> script.prompt"],
      },
    })).toBe("Launch checklist\nBrief\nPrepare the announcement\nreturn 'launch';\n--preview\nProjects/Launch.md\nMarketing\nReady to ship?\nReview");
  });

  it("ignores structural keys, internal config and persisted execution records", () => {
    expect(extract({
      schema: "studio.project.v2", id: "hidden-id",
      runs: [{ text: "hidden-run" }], artifacts: [{ path: "hidden-artifact" }],
      canvas: {
        nodes: [{
          id: "hidden-node", kind: "hidden-kind", outputs: { text: "hidden-output" },
          config: {
            __studio_managed_by: "hidden-owner",
            __studio_presentation: { text: "hidden-view" },
            outputs: [{ text: "hidden-config-output" }], runs: ["hidden-config-run"], artifacts: ["hidden-config-artifact"],
            value: { message: "Visible text", id: "hidden-value-id", nested: { __studio_state: "hidden-state" } },
            inputs: [{ id: "hidden-port", type: "hidden-port-type", description: "Input description" }],
          },
        }],
      },
    })).toBe("Visible text\nInput description");
  });

  it.each(["", "{broken", "null", "[]", '"text"', "{}", '{"schema":"studio.project.v3","name":"Future"}', '{"schema":"studio.entry.v1","name":"Entry"}'])("ignores malformed or unsupported documents: %s", (raw) => {
    expect(extractStudioText(raw, { maxChars: 100 })).toBe("");
  });

  it("tolerates malformed fields without indexing unrelated fields", () => {
    expect(extract({
      schema: "studio.project.v2", name: 123,
      canvas: {
        nodes: [null, "noise", [], { title: ["noise"], config: "noise" }, { title: "Valid", config: { text: "  Body  " } }],
        groups: "noise", shapes: [{ text: "not-a-shape-label" }], arrows: [null, { label: 123 }],
      },
    })).toBe("Valid\nBody");
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("returns no text for invalid character budget %s", (maxChars) => {
    expect(extract({ schema: "studio.project.v2", name: "Name" }, maxChars)).toBe("");
  });

  it("bounds output across fields and handles fractional budgets", () => {
    const document = { schema: "studio.project.v2", name: "Name", canvas: { nodes: [{ title: "Long title" }] } };
    expect(extract(document, 4)).toBe("Name");
    expect(extract(document, 5)).toBe("Name");
    expect(extract(document, 9.5)).toBe("Name\nLong");
    expect(extract(document, 2)).toBe("Na");
  });

  it("bounds config depth and traversal even when values produce no text", () => {
    let nested: unknown = "Unreachable depth";
    for (let index = 0; index < 100; index += 1) nested = { nested };
    expect(extract({ schema: "studio.project.v2", canvas: { nodes: [{ config: { nested, text: "Reachable" } }] } })).toBe("Reachable");
    expect(extract({ schema: "studio.project.v2", canvas: { nodes: [{ config: { values: Array(25_000).fill(null), text: "Beyond visit budget" } }] } })).toBe("");
  });
});
