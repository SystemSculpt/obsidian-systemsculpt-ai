/** @jest-environment jsdom */

import { readAllStudioNotePaths, serializeStudioNoteItems } from "../../../studio/StudioNoteConfig";
import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

const handleVaultItemRenamed = (SystemSculptStudioView as any).prototype.handleVaultItemRenamed as (
  this: any,
  file: any,
  oldPath: string
) => Promise<void>;
const handleVaultItemDeleted = (SystemSculptStudioView as any).prototype.handleVaultItemDeleted as (
  this: any,
  file: any
) => Promise<void>;

function noteNodeFixture(path: string): StudioNodeInstance {
  return {
    id: "note_1",
    kind: "studio.note",
    version: "1.0.0",
    title: "Old",
    position: { x: 0, y: 0 },
    config: {
      notes: serializeStudioNoteItems([{ path, enabled: true }]),
    },
    continueOnError: false,
    disabled: false,
  };
}

function projectFixture(node: StudioNodeInstance): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "project_vault_sync",
    name: "Vault Sync",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes: [node],
      edges: [],
      entryNodeIds: [],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 10,
        maxArtifactsMb: 128,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

function createVaultSyncContext(project: StudioProjectV1) {
  return {
    currentProject: project,
    currentProjectPath: "Studio/Test.systemsculpt",
    projectLiveSyncWarning: null,
    graphViewStateByProjectPath: {},
    nodeDetailModeByProjectPath: {},
    graphInteraction: {
      getSelectedNodeIds: jest.fn(() => []),
    },
    isMarkdownVaultFile: jest.fn(() => true),
    isVaultFolder: jest.fn(() => false),
    normalizeNoteNodeConfig: jest.fn(() => false),
    refreshNoteNodePreviewsFromVault: jest.fn(async () => true),
    commitCurrentProjectMutationAsync: jest.fn(async (_reason: string, mutator: (project: StudioProjectV1) => Promise<boolean | void>, _options: unknown) => {
      return (await mutator(project)) !== false;
    }),
    readAllNotePathsFromConfig: (node: StudioNodeInstance) => readAllStudioNotePaths(node.config),
    loadProjectFromPath: jest.fn(async () => {}),
    applySelectionToCurrentProject: jest.fn(),
    readStudioProjectRawText: jest.fn(async () => null),
    currentProjectSession: {
      markAcceptedProjectText: jest.fn(),
    },
    render: jest.fn(),
  };
}

describe("SystemSculptStudioView vault sync persistence", () => {
  it("commits note path renames through the session mutation seam", async () => {
    const node = noteNodeFixture("Notes/Old.md");
    const project = projectFixture(node);
    const context = createVaultSyncContext(project);

    await handleVaultItemRenamed.call(
      context,
      { path: "Notes/Renamed.md", basename: "Renamed" },
      "Notes/Old.md"
    );

    expect(context.commitCurrentProjectMutationAsync).toHaveBeenCalledWith(
      "vault.sync",
      expect.any(Function),
      { captureHistory: false }
    );
    expect(readAllStudioNotePaths(node.config)).toEqual(["Notes/Renamed.md"]);
    expect(node.title).toBe("Renamed");
    expect(context.refreshNoteNodePreviewsFromVault).toHaveBeenCalledWith(project, {
      onlyNodeIds: new Set([node.id]),
    });
    expect(context.render).toHaveBeenCalledTimes(1);
  });

  it("commits note deletions through the session mutation seam", async () => {
    const node = noteNodeFixture("Notes/Deleted.md");
    const project = projectFixture(node);
    const context = createVaultSyncContext(project);

    await handleVaultItemDeleted.call(context, { path: "Notes/Deleted.md" });

    expect(context.commitCurrentProjectMutationAsync).toHaveBeenCalledWith(
      "vault.sync",
      expect.any(Function),
      { captureHistory: false }
    );
    expect(context.refreshNoteNodePreviewsFromVault).toHaveBeenCalledWith(project, {
      onlyNodeIds: new Set([node.id]),
    });
    expect(context.render).toHaveBeenCalledTimes(1);
  });
});
