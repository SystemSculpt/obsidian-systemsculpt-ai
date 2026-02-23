import type { StudioProjectV1 } from "../types";
import { migrateStudioProjectToPathOnlyPorts } from "../StudioGraphMigrations";

function baseProject(): StudioProjectV1 {
  const now = new Date().toISOString();
  return {
    schema: "studio.project.v1",
    projectId: "proj_migrate",
    name: "Migration Test",
    createdAt: now,
    updatedAt: now,
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [],
      edges: [],
      entryNodeIds: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Migration.systemsculpt-assets/policy/grants.json",
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

describe("migrateStudioProjectToPathOnlyPorts", () => {
  it("maps legacy media/audio/transcription ports to path-only edges and deduplicates", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "media",
        kind: "studio.media_ingest",
        version: "1.0.0",
        title: "Media",
        position: { x: 0, y: 0 },
        config: {
          sourcePath: "/Users/systemsculpt/Movies/input.mp4",
          sourceMode: "local",
          assetMode: "auto",
          mediaKind: "video",
        },
      },
      {
        id: "audio",
        kind: "studio.audio_extract",
        version: "1.0.0",
        title: "Audio",
        position: { x: 250, y: 0 },
        config: {},
      },
      {
        id: "transcribe",
        kind: "studio.transcription",
        version: "1.0.0",
        title: "Transcribe",
        position: { x: 500, y: 0 },
        config: {},
      },
      {
        id: "prompt",
        kind: "studio.prompt_template",
        version: "1.0.0",
        title: "Prompt",
        position: { x: 760, y: 0 },
        config: {},
      }
    );

    project.graph.edges.push(
      {
        id: "e1",
        fromNodeId: "media",
        fromPortId: "asset",
        toNodeId: "audio",
        toPortId: "asset",
      },
      {
        id: "e2",
        fromNodeId: "media",
        fromPortId: "path",
        toNodeId: "audio",
        toPortId: "path",
      },
      {
        id: "e3",
        fromNodeId: "audio",
        fromPortId: "audio",
        toNodeId: "transcribe",
        toPortId: "audio",
      },
      {
        id: "e4",
        fromNodeId: "audio",
        fromPortId: "asset",
        toNodeId: "transcribe",
        toPortId: "asset",
      },
      {
        id: "e5",
        fromNodeId: "transcribe",
        fromPortId: "text",
        toNodeId: "prompt",
        toPortId: "text",
      }
    );

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const mediaNode = migrated.project.graph.nodes.find((node) => node.id === "media");
    expect(mediaNode?.config).toEqual({
      sourcePath: "/Users/systemsculpt/Movies/input.mp4",
    });

    const signature = migrated.project.graph.edges
      .map((edge) => `${edge.fromNodeId}:${edge.fromPortId}->${edge.toNodeId}:${edge.toPortId}`)
      .sort();
    expect(signature).toEqual([
      "audio:path->transcribe:path",
      "media:path->audio:path",
      "transcribe:text->prompt:text",
    ]);

    expect(
      migrated.project.migrations.applied.some((entry) => entry.id === "studio.path-only-ports.v1")
    ).toBe(true);
  });

  it("is idempotent once a project already uses path-only ports", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "media",
        kind: "studio.media_ingest",
        version: "1.0.0",
        title: "Media",
        position: { x: 0, y: 0 },
        config: { sourcePath: "/Users/systemsculpt/Movies/input.mp4" },
      },
      {
        id: "audio",
        kind: "studio.audio_extract",
        version: "1.0.0",
        title: "Audio",
        position: { x: 250, y: 0 },
        config: {},
      }
    );
    project.graph.edges.push({
      id: "edge",
      fromNodeId: "media",
      fromPortId: "path",
      toNodeId: "audio",
      toPortId: "path",
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(false);
    expect(migrated.project).toBe(project);
  });

  it("remaps legacy prompt-template/text-generation split ports back to single prompt ports", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "prompt",
        kind: "studio.prompt_template",
        version: "1.0.0",
        title: "Prompt",
        position: { x: 0, y: 0 },
        config: { template: "System instruction" },
      },
      {
        id: "text",
        kind: "studio.text_generation",
        version: "1.0.0",
        title: "Text",
        position: { x: 220, y: 0 },
        config: {},
      }
    );
    project.graph.edges.push(
      {
        id: "e1",
        fromNodeId: "prompt",
        fromPortId: "prompt_text",
        toNodeId: "text",
        toPortId: "prompt",
      },
      {
        id: "e2",
        fromNodeId: "prompt",
        fromPortId: "system_prompt",
        toNodeId: "text",
        toPortId: "system_prompt",
      }
    );

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const signature = migrated.project.graph.edges.map(
      (edge) => `${edge.fromNodeId}:${edge.fromPortId}->${edge.toNodeId}:${edge.toPortId}`
    );
    expect(signature).toEqual(["prompt:prompt->text:prompt"]);
  });
});
