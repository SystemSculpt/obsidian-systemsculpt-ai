import type { StudioProjectV1 } from "../../../studio/types";
import {
  assignNodesToGroup,
  createGroupFromSelection,
  normalizeGroupColor,
  removeNodesFromGroups,
  removeShapesFromGroups,
  setGroupColor,
  sanitizeGraphGroups,
} from "../../../studio/StudioGraphGroupModel";

function withShapes(project: StudioProjectV1): StudioProjectV1 {
  project.diagram = {
    shapes: [
      {
        id: "s1",
        shape: "rectangle",
        position: { x: 400, y: 400 },
        size: { width: 180, height: 120 },
        label: "One",
      },
      {
        id: "s2",
        shape: "ellipse",
        position: { x: 700, y: 400 },
        size: { width: 180, height: 120 },
        label: "Two",
      },
    ],
    arrows: [],
  };
  return project;
}

function createProject(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_1",
    name: "Grouping",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [
        {
          id: "a",
          kind: "studio.input",
          version: "1.0.0",
          title: "A",
          position: { x: 100, y: 100 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "b",
          kind: "studio.input",
          version: "1.0.0",
          title: "B",
          position: { x: 200, y: 120 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "c",
          kind: "studio.input",
          version: "1.0.0",
          title: "C",
          position: { x: 300, y: 140 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: ["a", "b", "c"],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "SystemSculpt/Studio/Grouping.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 100,
        maxArtifactsMb: 1024,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

describe("StudioGraphGroupModel", () => {
  it("creates a group with next available Group N name", () => {
    const project = createProject();
    project.graph.groups = [
      {
        id: "group_existing",
        name: "Group 1",
        nodeIds: ["a"],
      },
    ];

    const created = createGroupFromSelection(project, ["b", "c"], () => "group_new");
    expect(created?.id).toBe("group_new");
    expect(created?.name).toBe("Group 2");
    expect(created?.nodeIds).toEqual(["b", "c"]);
  });

  it("re-homes selected nodes from existing groups and prunes empty groups", () => {
    const project = createProject();
    project.graph.groups = [
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["a", "b"],
      },
      {
        id: "group_2",
        name: "Group 2",
        nodeIds: ["c"],
      },
    ];

    const created = createGroupFromSelection(project, ["b", "c"], () => "group_3");
    expect(created?.id).toBe("group_3");
    expect(project.graph.groups).toEqual([
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["a"],
      },
      {
        id: "group_3",
        name: "Group 2",
        nodeIds: ["b", "c"],
      },
    ]);
  });

  it("removes deleted nodes from groups", () => {
    const project = createProject();
    project.graph.groups = [
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["a", "b"],
      },
    ];

    const changed = removeNodesFromGroups(project, ["a", "missing"]);
    expect(changed).toBe(true);
    expect(project.graph.groups).toEqual([
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["b"],
      },
    ]);
  });

  it("re-homes nodes into an existing group", () => {
    const project = createProject();
    project.graph.groups = [
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["a"],
      },
      {
        id: "group_2",
        name: "Group 2",
        nodeIds: ["b", "c"],
      },
    ];

    const changed = assignNodesToGroup(project, "group_2", ["a", "c"]);
    expect(changed).toBe(true);
    expect(project.graph.groups).toEqual([
      {
        id: "group_2",
        name: "Group 2",
        nodeIds: ["b", "c", "a"],
      },
    ]);
  });

  it("does not update groups when assignment is unchanged", () => {
    const project = createProject();
    project.graph.groups = [
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["a", "b"],
      },
    ];

    const changed = assignNodesToGroup(project, "group_1", ["a"]);
    expect(changed).toBe(false);
    expect(project.graph.groups).toEqual([
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["a", "b"],
      },
    ]);
  });

  it("sanitizes malformed groups", () => {
    const project = createProject();
    project.graph.groups = [
      {
        id: " ",
        name: "Nope",
        nodeIds: ["a"],
      },
      {
        id: "group_1",
        name: "Group 1",
        color: "#8De",
        nodeIds: ["a", "missing", "a"],
      },
      {
        id: "group_1",
        name: "Duplicate ID",
        nodeIds: ["b"],
      },
    ];

    const changed = sanitizeGraphGroups(project);
    expect(changed).toBe(true);
    expect(project.graph.groups).toEqual([
      {
        id: "group_1",
        name: "Group 1",
        color: "#88ddee",
        nodeIds: ["a"],
      },
    ]);
  });

  it("sets and clears group color", () => {
    const project = createProject();
    project.graph.groups = [
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["a", "b"],
      },
    ];

    const changed = setGroupColor(project, "group_1", "#A1B2C3");
    expect(changed).toBe(true);
    expect(project.graph.groups[0]?.color).toBe("#a1b2c3");

    const unchanged = setGroupColor(project, "group_1", "#a1b2c3");
    expect(unchanged).toBe(false);

    const cleared = setGroupColor(project, "group_1", null);
    expect(cleared).toBe(true);
    expect(project.graph.groups[0]?.color).toBeUndefined();
  });

  it("normalizes group color only when valid", () => {
    expect(normalizeGroupColor("#abc")).toBe("#aabbcc");
    expect(normalizeGroupColor("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeGroupColor("invalid")).toBeNull();
  });

  it("groups a node and a shape together", () => {
    const project = withShapes(createProject());

    const created = createGroupFromSelection(project, ["a"], () => "group_mixed", ["s1"]);

    expect(created).toEqual({
      id: "group_mixed",
      name: "Group 1",
      nodeIds: ["a"],
      shapeIds: ["s1"],
    });
  });

  it("groups shapes alone and ignores shapes that do not exist", () => {
    const project = withShapes(createProject());

    const created = createGroupFromSelection(project, [], () => "group_shapes", [
      "s1",
      "s2",
      "missing",
    ]);

    expect(created?.nodeIds).toEqual([]);
    expect(created?.shapeIds).toEqual(["s1", "s2"]);
    // One shape is not a group, the same bar a lone node has to clear.
    expect(createGroupFromSelection(project, [], () => "group_single", ["s1"])).toBeNull();
  });

  it("keeps a group alive while it still frames a shape", () => {
    const project = withShapes(createProject());
    project.graph.groups = [
      { id: "group_1", name: "Group 1", nodeIds: ["a"], shapeIds: ["s1"] },
    ];

    expect(removeNodesFromGroups(project, ["a"])).toBe(true);
    expect(project.graph.groups).toEqual([
      { id: "group_1", name: "Group 1", nodeIds: [], shapeIds: ["s1"] },
    ]);

    expect(removeShapesFromGroups(project, ["s1"])).toBe(true);
    expect(project.graph.groups).toEqual([]);
  });

  it("sanitizes shape members against the diagram", () => {
    const project = withShapes(createProject());
    project.graph.groups = [
      { id: "group_1", name: "Group 1", nodeIds: ["a"], shapeIds: ["s1", "gone"] },
      { id: "group_2", name: "Group 2", nodeIds: ["missing"], shapeIds: ["gone"] },
    ];

    expect(sanitizeGraphGroups(project)).toBe(true);
    expect(project.graph.groups).toEqual([
      { id: "group_1", name: "Group 1", nodeIds: ["a"], shapeIds: ["s1"] },
    ]);
  });
});
