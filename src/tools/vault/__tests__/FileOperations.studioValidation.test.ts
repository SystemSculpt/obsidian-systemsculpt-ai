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
      schema: "studio.project.v1",
      graph: {
        nodes: [expect.objectContaining({ id: "overview" })],
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
      edits: [{ oldText: '"kind": "studio.text"', newText: '"kind": "studio.unknown"' }],
    } as any)).rejects.toThrow("Studio project edit rejected before write");

    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("rejects raw positions and sizes that Studio would otherwise normalize", async () => {
    const missingPosition = JSON.parse(original);
    delete missingPosition.graph.nodes[0].position.y;
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(missingPosition, null, 2),
    } as any)).rejects.toThrow("position.y must be a finite number");

    const nonFinitePosition = original.replace('"x": 80', '"x": 1e309');
    await expect(operations.writeFile({
      path: file.path,
      content: nonFinitePosition,
    } as any)).rejects.toThrow("position.x must be a finite number");

    const invalidSize = JSON.parse(original);
    invalidSize.graph.nodes[0].size.width = "wide";
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(invalidSize, null, 2),
    } as any)).rejects.toThrow("size.width must be a finite number");

    expect(persisted).toBe(original);
  });

  it("rejects unknown node, position, size, and group fields", async () => {
    const cases = [
      (document: any) => { document.graph.nodes[0].postion = { x: 500, y: 500 }; },
      (document: any) => { document.graph.nodes[0].position.z = 1; },
      (document: any) => { document.graph.nodes[0].size.depth = 1; },
      (document: any) => { document.graph.groups[0].bounds = { x: 0, y: 0 }; },
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

  it("rejects missing, duplicate, and overlapping group membership", async () => {
    const missingMember = JSON.parse(original);
    missingMember.graph.groups[0].nodeIds.push("missing-node");
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(missingMember, null, 2),
    } as any)).rejects.toThrow('references missing node "missing-node"');

    const duplicateMember = JSON.parse(original);
    duplicateMember.graph.groups[0].nodeIds.push("overview");
    await expect(operations.writeFile({
      path: file.path,
      content: JSON.stringify(duplicateMember, null, 2),
    } as any)).rejects.toThrow('contains duplicate node ID "overview"');

    const overlappingMember = JSON.parse(original);
    overlappingMember.graph.groups.push({
      id: "second-group",
      name: "Second",
      nodeIds: ["overview"],
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
      mutate: (document: any) => { document.schema = "studio.project.v2"; },
      error: "schema must be studio.project.v1",
    },
    {
      contract: "unknown root fields",
      mutate: (document: any) => { document.authorityRevision = 884; },
      error: 'Studio project root contains unsupported field "authorityRevision"',
    },
    {
      contract: "a closed graph object",
      mutate: (document: any) => { document.graph.lanes = []; },
      error: 'graph contains unsupported field "lanes"',
    },
    {
      contract: "all required graph arrays",
      mutate: (document: any) => { delete document.graph.edges; },
      error: "graph.edges is required",
    },
    {
      contract: "graph fields being arrays",
      mutate: (document: any) => { document.graph.groups = {}; },
      error: "graph.groups must be an array",
    },
    {
      contract: "all required edge fields",
      mutate: (document: any) => {
        document.graph.edges = [{
          id: "overview-link",
          fromNodeId: "overview",
          fromPortId: "out",
          toNodeId: "overview",
        }];
      },
      error: "graph.edges[0].toPortId is required",
    },
    {
      contract: "closed edge objects",
      mutate: (document: any) => {
        document.graph.edges = [{
          id: "overview-link",
          fromNodeId: "overview",
          fromPortId: "out",
          toNodeId: "overview",
          toPortId: "in",
          label: "Architecture",
        }];
      },
      error: 'graph.edges[0] contains unsupported field "label"',
    },
    {
      contract: "edge IDs without surrounding whitespace",
      mutate: (document: any) => {
        document.graph.edges = [{
          id: " overview-link ",
          fromNodeId: "overview",
          fromPortId: "out",
          toNodeId: "overview",
          toPortId: "in",
        }];
      },
      error: "graph.edges[0].id must not contain surrounding whitespace",
    },
    {
      contract: "unique entry node IDs",
      mutate: (document: any) => { document.graph.entryNodeIds = ["overview", "overview"]; },
      error: 'graph.entryNodeIds contains duplicate node ID "overview"',
    },
    {
      contract: "entry IDs that reference existing nodes",
      mutate: (document: any) => { document.graph.entryNodeIds = ["missing"]; },
      error: 'graph.entryNodeIds[0] references missing node "missing"',
    },
    {
      contract: "entry IDs with a strict string type",
      mutate: (document: any) => { document.graph.entryNodeIds = [7]; },
      error: "graph.entryNodeIds[0] must be a non-empty string",
    },
    {
      contract: "node versions with a strict string type",
      mutate: (document: any) => { document.graph.nodes[0].version = 1; },
      error: "graph.nodes[0].version must be a non-empty string",
    },
    {
      contract: "node titles without surrounding whitespace",
      mutate: (document: any) => { document.graph.nodes[0].title = " Overview "; },
      error: "graph.nodes[0].title must not contain surrounding whitespace",
    },
    {
      contract: "node config as an object",
      mutate: (document: any) => { document.graph.nodes[0].config = []; },
      error: "graph.nodes[0].config must be an object",
    },
    {
      contract: "node booleans with strict types",
      mutate: (document: any) => { document.graph.nodes[0].disabled = "false"; },
      error: "graph.nodes[0].disabled must be a boolean when present",
    },
    {
      contract: "non-empty group names",
      mutate: (document: any) => { document.graph.groups[0].name = " "; },
      error: "graph.groups[0].name must be a non-empty string",
    },
    {
      contract: "group colors in the documented hex format",
      mutate: (document: any) => { document.graph.groups[0].color = "blue"; },
      error: "graph.groups[0].color must be #rgb or #rrggbb",
    },
  ])("rejects raw Studio JSON that violates $contract", ({ mutate, error }) => {
    const document = JSON.parse(original);
    mutate(document);

    expect(() => assertValidStudioProjectAgentDocumentStructure(document)).toThrow(error);
  });

  it("rejects a visual-only text node as an entry point through the ordinary file guard", () => {
    const document = JSON.parse(original);
    document.graph.entryNodeIds = ["overview"];

    expect(() => assertValidStudioProjectAgentFileMutation({
      path: file.path,
      exists: true,
      mode: "overwrite",
      previousContent: original,
      content: JSON.stringify(document),
    })).toThrow('Entry node "overview" must be executable, not visual-only.');
  });

  it("keeps Studio-owned identity and authoring reference fields stable", async () => {
    const projectId = JSON.parse(original).projectId as string;
    await expect(operations.editFile({
      path: file.path,
      edits: [{ oldText: projectId, newText: `${projectId}-changed` }],
    } as any)).rejects.toThrow("projectId is Studio-owned");

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
