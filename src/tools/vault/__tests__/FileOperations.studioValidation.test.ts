/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { assertValidStudioProjectAgentDocumentStructure } from "../../../studio/StudioProjectAgentDocumentValidation";
import { assertValidStudioProjectAgentFileMutation } from "../../../studio/StudioProjectAgentFileGuard";
import { createEmptyStudioProject, serializeStudioProject } from "../../../studio/schema";
import { FileOperations } from "../tools/FileOperations";

function studioProjectText(): string {
  const project = createEmptyStudioProject({
    name: "Agent canvas",
    policyPath: "SystemSculpt/Studio/Agent canvas.systemsculpt-assets/policy/grants.json",
    minPluginVersion: "6.0.2",
    maxRuns: 100,
    maxArtifactsMb: 1024,
  });
  project.graph.nodes.push({
    id: "overview",
    kind: "studio.text",
    version: "1.0.0",
    title: "Overview",
    position: { x: 80, y: 80 },
    size: { width: 320 },
    config: { value: "Current architecture" },
    continueOnError: false,
    disabled: false,
  });
  project.graph.groups = [{
    id: "overview-group",
    name: "Overview",
    nodeIds: ["overview"],
  }];
  return serializeStudioProject(project);
}

describe("FileOperations Studio agent edits", () => {
  let app: App;
  let file: TFile;
  let operations: FileOperations;
  let original: string;
  let persisted: string;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new App();
    file = new TFile({ path: "SystemSculpt/Studio/Agent canvas.systemsculpt" });
    original = studioProjectText();
    persisted = original;
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(file);
    (app.vault.read as jest.Mock).mockImplementation(async () => persisted);
    (app.vault.modify as jest.Mock).mockResolvedValue(undefined);
    (app.vault as any).process = jest.fn(async (_file: TFile, update: (data: string) => string) => {
      persisted = update(persisted);
      return persisted;
    });
    operations = new FileOperations(app, ["/"]);
  });

  it("applies a valid project edit through the ordinary chat edit tool", async () => {
    const result = await operations.editFile({
      path: file.path,
      edits: [{ oldText: "Current architecture", newText: "Updated architecture" }],
    } as any);

    expect(result.appliedCount).toBe(1);
    expect(persisted).toContain("Updated architecture");
    expect((app.vault as any).process).toHaveBeenCalledWith(file, expect.any(Function));
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("reads a small Studio project as complete parseable JSON in one ordinary read", async () => {
    const result = await operations.readFiles({ paths: [file.path] } as any);
    const read = result.files[0];

    expect(read.error).toBeUndefined();
    expect(read.metadata?.hasMore).toBe(false);
    expect(read.content).toBe(original);
    expect(JSON.parse(read.content)).toMatchObject({
      schema: "studio.project.v2",
      docs: "SystemSculpt/Studio/AGENTS.md",
      canvas: {
        nodes: [expect.objectContaining({ id: "overview", kind: "text" })],
        groups: [expect.objectContaining({ id: "overview-group" })],
      },
    });
  });

  it("does not overwrite a canvas autosave that races an ordinary edit", async () => {
    const canvasAutosave = original.replace("Current architecture", "Canvas autosave won");
    (app.vault.read as jest.Mock).mockResolvedValueOnce(original);
    persisted = canvasAutosave;

    await expect(operations.editFile({
      path: file.path,
      edits: [{ oldText: "Current architecture", newText: "Agent edit" }],
    } as any)).rejects.toThrow("nothing was overwritten");

    expect(persisted).toBe(canvasAutosave);
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("applies a valid batch edit to a CRLF Studio project", async () => {
    persisted = original.replace(/\n/g, "\r\n");

    const result = await operations.multiEditFiles({
      files: [{
        path: file.path,
        edits: [{ oldText: "Current architecture", newText: "Batch architecture" }],
      }],
    } as any);

    expect(result).toMatchObject({ success: true, appliedFiles: 1 });
    expect(persisted).toContain("Batch architecture");
    expect((app.vault as any).process).toHaveBeenCalledWith(file, expect.any(Function));
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer project when an ordinary overwrite races it", async () => {
    const replacement = original.replace("Current architecture", "Agent overwrite");
    const canvasAutosave = original.replace("Current architecture", "Newer canvas state");
    (app.vault.read as jest.Mock).mockResolvedValueOnce(original);
    persisted = canvasAutosave;

    await expect(operations.writeFile({
      path: file.path,
      content: replacement,
    } as any)).rejects.toThrow("Read the file again and retry");

    expect(persisted).toBe(canvasAutosave);
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("rejects an invalid node kind before the vault is modified", async () => {
    await expect(operations.editFile({
      path: file.path,
      edits: [{ oldText: '"kind": "text"', newText: '"kind": "unknown"' }],
    } as any)).rejects.toThrow("Studio project edit rejected before write");

    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("rejects raw positions and sizes that Studio would otherwise normalize", async () => {
    const missingPosition = JSON.parse(original);
    delete missingPosition.canvas.nodes[0].y;
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(missingPosition, null, 2),
    } as any)).rejects.toThrow("canvas.nodes[0].y is required");

    const nonFinitePosition = original.replace('"x": 80', '"x": 1e309');
    await expect(operations.writeFile({
      path: file.path,
      content: nonFinitePosition,
    } as any)).rejects.toThrow("canvas.nodes[0].x must be a finite number");

    const invalidSize = JSON.parse(original);
    invalidSize.canvas.nodes[0].width = "wide";
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(invalidSize, null, 2),
    } as any)).rejects.toThrow("canvas.nodes[0].width must be a finite number");

    expect(persisted).toBe(original);
  });

  it("rejects unknown node and group fields", async () => {
    const cases = [
      (document: any) => { document.canvas.nodes[0].postion = { x: 500, y: 500 }; },
      (document: any) => { document.canvas.nodes[0].z = 1; },
      (document: any) => { document.canvas.nodes[0].version = "1.0.0"; },
      (document: any) => { document.canvas.groups[0].bounds = { x: 0, y: 0 }; },
    ];

    for (const mutate of cases) {
      const document = JSON.parse(original);
      mutate(document);
      await expect(operations.writeFile({
        path: file.path,
        content: JSON.stringify(document, null, 2),
      } as any)).rejects.toThrow("contains unsupported field");
    }

    expect(persisted).toBe(original);
  });

  it("accepts a group that frames shapes and rejects broken shape membership", async () => {
    const withShapes = JSON.parse(original);
    withShapes.canvas.shapes = [
      {
        id: "shape-1",
        shape: "rectangle",
        x: 400,
        y: 400,
        width: 180,
        height: 120,
        label: "Region",
      },
    ];
    withShapes.canvas.groups[0].shapes = ["shape-1"];
    assertValidStudioProjectAgentDocumentStructure(withShapes);

    // A group may drop every node and live on its shapes alone.
    const shapeOnly = JSON.parse(JSON.stringify(withShapes));
    shapeOnly.canvas.groups[0].nodes = [];
    assertValidStudioProjectAgentDocumentStructure(shapeOnly);

    const missingShape = JSON.parse(JSON.stringify(withShapes));
    missingShape.canvas.groups[0].shapes = ["gone"];
    expect(() => assertValidStudioProjectAgentDocumentStructure(missingShape)).toThrow(
      'references missing shape "gone"'
    );

    const emptyGroup = JSON.parse(JSON.stringify(withShapes));
    emptyGroup.canvas.groups[0].nodes = [];
    emptyGroup.canvas.groups[0].shapes = [];
    expect(() => assertValidStudioProjectAgentDocumentStructure(emptyGroup)).toThrow(
      "must contain at least one node or shape"
    );

    const sharedShape = JSON.parse(JSON.stringify(withShapes));
    sharedShape.canvas.groups.push({
      id: "second-group",
      name: "Second",
      shapes: ["shape-1"],
    });
    expect(() => assertValidStudioProjectAgentDocumentStructure(sharedShape)).toThrow(
      'Shape "shape-1" belongs to both group "overview-group" and group "second-group"'
    );
  });

  it("accepts labeled arrows in the object form and rejects malformed ones", () => {
    const base = JSON.parse(original);
    base.canvas.shapes = [
      { id: "a", shape: "rectangle", x: 0, y: 0, width: 180, height: 120, label: "A" },
      { id: "b", shape: "ellipse", x: 300, y: 0, width: 180, height: 120, label: "B" },
    ];
    base.canvas.groups[0].shapes = ["a", "b"];
    base.canvas.arrows = ["a -> b", { from: "b", to: "a", label: "returns\nresults" }];
    assertValidStudioProjectAgentDocumentStructure(base);

    const rejects: Array<{ arrow: unknown; error: string }> = [
      {
        arrow: { from: "a", to: "b", note: "x" },
        error: 'canvas.arrows[0] contains unsupported field "note"',
      },
      { arrow: { from: "a" }, error: "canvas.arrows[0].to is required" },
      { arrow: { from: "a", to: "b", label: 7 }, error: "canvas.arrows[0].label must be a string" },
      {
        arrow: 42,
        error:
          'canvas.arrows[0] must be the string "fromShape -> toShape" or an object { from, to, label }',
      },
      { arrow: { from: "a", to: "a", label: "x" }, error: "must connect two different shapes" },
      { arrow: { from: "a", to: "ghost" }, error: 'references missing shape "ghost"' },
    ];
    for (const { arrow, error } of rejects) {
      const document = JSON.parse(JSON.stringify(base));
      document.canvas.arrows = [arrow];
      expect(() => assertValidStudioProjectAgentDocumentStructure(document)).toThrow(error);
    }

    // The pair-uniqueness rule sees through the two spellings of an arrow.
    const duplicate = JSON.parse(JSON.stringify(base));
    duplicate.canvas.arrows = ["a -> b", { from: "a", to: "b", label: "again" }];
    expect(() => assertValidStudioProjectAgentDocumentStructure(duplicate)).toThrow(
      'canvas.arrows already connects "a" to "b"'
    );
  });

  it("rejects missing, duplicate, and overlapping group membership", async () => {
    const missingMember = JSON.parse(original);
    missingMember.canvas.groups[0].nodes.push("missing-node");
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(missingMember, null, 2),
    } as any)).rejects.toThrow('references missing node "missing-node"');

    const duplicateMember = JSON.parse(original);
    duplicateMember.canvas.groups[0].nodes.push("overview");
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(duplicateMember, null, 2),
    } as any)).rejects.toThrow('contains duplicate node ID "overview"');

    const overlappingMember = JSON.parse(original);
    overlappingMember.canvas.groups.push({
      id: "second-group",
      name: "Second",
      nodes: ["overview"],
    });
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(overlappingMember, null, 2),
    } as any)).rejects.toThrow('belongs to both group "overview-group" and group "second-group"');

    expect(persisted).toBe(original);
  });

  it.each([
    {
      contract: "the root schema literal",
      mutate: (document: any) => { document.schema = "studio.workflow.v2"; },
      error: "schema must be studio.project.v2",
    },
    {
      contract: "unknown root fields",
      mutate: (document: any) => { document.authorityRevision = 884; },
      error: 'Studio project root contains unsupported field "authorityRevision"',
    },
    {
      contract: "a closed canvas object",
      mutate: (document: any) => { document.canvas.lanes = []; },
      error: 'canvas contains unsupported field "lanes"',
    },
    {
      contract: "the required canvas object",
      mutate: (document: any) => { delete document.canvas; },
      error: "Studio project root.canvas is required",
    },
    {
      contract: "canvas fields being arrays",
      mutate: (document: any) => { document.canvas.groups = {}; },
      error: "canvas.groups must be an array",
    },
    {
      contract: "edges written as arrow strings",
      mutate: (document: any) => {
        document.canvas.edges = [{ fromNodeId: "overview", toNodeId: "overview" }];
      },
      error: 'canvas.edges[0] must be the string "fromNode.port -> toNode.port"',
    },
    {
      contract: "edges with exactly one arrow",
      mutate: (document: any) => {
        document.canvas.edges = ["overview.text -> overview.in -> overview"];
      },
      error: 'canvas.edges[0] must contain exactly one "->"',
    },
    {
      contract: "edges naming existing nodes",
      mutate: (document: any) => { document.canvas.edges = ["overview.text -> ghost.in"]; },
      error: 'canvas.edges[0] references missing node "ghost.in"',
    },
    {
      contract: "unique edges",
      mutate: (document: any) => {
        document.canvas.edges = [
          "overview.text -> overview.text",
          "overview.text  ->  overview.text",
        ];
      },
      error: 'canvas.edges contains duplicate edge "overview.text -> overview.text"',
    },
    {
      contract: "duplicate node IDs",
      mutate: (document: any) => { document.canvas.nodes.push({ ...document.canvas.nodes[0] }); },
      error: 'canvas.nodes contains duplicate node ID "overview"',
    },
    {
      contract: "node titles without surrounding whitespace",
      mutate: (document: any) => { document.canvas.nodes[0].title = " Overview "; },
      error: "canvas.nodes[0].title must not contain surrounding whitespace",
    },
    {
      contract: "node config as an object",
      mutate: (document: any) => { document.canvas.nodes[0].config = []; },
      error: "canvas.nodes[0].config must be an object",
    },
    {
      contract: "node booleans with strict types",
      mutate: (document: any) => { document.canvas.nodes[0].disabled = "false"; },
      error: "canvas.nodes[0].disabled must be a boolean when present",
    },
    {
      contract: "node sizes carrying width before height",
      mutate: (document: any) => {
        delete document.canvas.nodes[0].width;
        document.canvas.nodes[0].height = 200;
      },
      error: "canvas.nodes[0].height requires width",
    },
    {
      contract: "non-empty group names",
      mutate: (document: any) => { document.canvas.groups[0].name = " "; },
      error: "canvas.groups[0].name must be a non-empty string",
    },
    {
      contract: "group colors in the documented hex format",
      mutate: (document: any) => { document.canvas.groups[0].color = "blue"; },
      error: "canvas.groups[0].color must be #rgb or #rrggbb",
    },
  ])("rejects raw Studio JSON that violates $contract", ({ mutate, error }) => {
    const document = JSON.parse(original);
    mutate(document);

    expect(() => assertValidStudioProjectAgentDocumentStructure(document)).toThrow(error);
  });

  it("accepts a one-way upgrade of a v1 file to the v2 dialect", () => {
    const project = createEmptyStudioProject({
      name: "Agent canvas",
      policyPath: "SystemSculpt/Studio/Agent canvas.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "6.0.2",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    const v1Document = `${JSON.stringify(project, null, 2)}\n`;
    const upgraded = serializeStudioProject(project);

    expect(() => assertValidStudioProjectAgentFileMutation({
      path: file.path,
      exists: true,
      mode: "overwrite",
      previousContent: v1Document,
      content: upgraded,
    })).not.toThrow();

    expect(() => assertValidStudioProjectAgentFileMutation({
      path: file.path,
      exists: true,
      mode: "overwrite",
      previousContent: upgraded,
      content: v1Document,
    })).toThrow("schema may only move from studio.project.v1 to studio.project.v2");
  });

  it("keeps the Studio-owned project identity stable", async () => {
    const projectId = JSON.parse(original).id as string;
    await expect(operations.editFile({
      path: file.path,
      edits: [{ oldText: projectId, newText: `${projectId}-changed` }],
    } as any)).rejects.toThrow("The project identity is Studio-owned");

    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("rejects malformed overwrite, append, creation, and sidecar writes", async () => {
    await expect(operations.writeFile({ path: file.path, content: "{" } as any))
      .rejects.toThrow("Studio project edit rejected before write");
    await expect(operations.writeFile({
      path: file.path,
      content: "{}",
      ifExists: "append",
    } as any)).rejects.toThrow("cannot be appended");

    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    await expect(operations.writeFile({
      path: "SystemSculpt/Studio/New.systemsculpt",
      content: original,
    } as any)).rejects.toThrow("Create this project in Studio once");

    const sidecar = new TFile({
      path: "SystemSculpt/Studio/Agent canvas.systemsculpt.identity.json",
    });
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(sidecar);
    await expect(operations.writeFile({
      path: sidecar.path,
      content: "{}",
    } as any)).rejects.toThrow("private project files");

    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
  });
});
