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

  it("inlines prompt-template nodes into downstream generation nodes and rewires inputs", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "source_text",
        kind: "studio.input",
        version: "1.0.0",
        title: "Source Text",
        position: { x: -300, y: 0 },
        config: { value: "Generate from transcript." },
      },
      {
        id: "source_image",
        kind: "studio.media_ingest",
        version: "1.0.0",
        title: "Source Image",
        position: { x: -300, y: 240 },
        config: { sourcePath: "SystemSculpt/Assets/reference.png" },
      },
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
        position: { x: 220, y: -60 },
        config: {},
      },
      {
        id: "image",
        kind: "studio.image_generation",
        version: "1.0.0",
        title: "Image",
        position: { x: 220, y: 160 },
        config: {},
      }
    );
    project.graph.edges.push(
      {
        id: "e1",
        fromNodeId: "source_text",
        fromPortId: "text",
        toNodeId: "prompt",
        toPortId: "text",
      },
      {
        id: "e2",
        fromNodeId: "source_image",
        fromPortId: "path",
        toNodeId: "prompt",
        toPortId: "images",
      },
      {
        id: "e3",
        fromNodeId: "prompt",
        fromPortId: "prompt_text",
        toNodeId: "text",
        toPortId: "prompt",
      },
      {
        id: "e4",
        fromNodeId: "prompt",
        fromPortId: "system_prompt",
        toNodeId: "image",
        toPortId: "prompt",
      },
    );
    project.graph.entryNodeIds = ["source_text", "source_image", "prompt"];
    project.graph.groups = [
      {
        id: "group_1",
        name: "Group",
        nodeIds: ["source_text", "prompt", "text", "image"],
      },
    ];

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    expect(migrated.project.graph.nodes.some((node) => node.id === "prompt")).toBe(false);

    const textNode = migrated.project.graph.nodes.find((node) => node.id === "text");
    expect(textNode?.config.systemPrompt).toBe("System instruction");

    const imageNode = migrated.project.graph.nodes.find((node) => node.id === "image");
    expect(imageNode?.config.systemPrompt).toBeUndefined();

    const signature = migrated.project.graph.edges
      .map(
        (edge) => `${edge.fromNodeId}:${edge.fromPortId}->${edge.toNodeId}:${edge.toPortId}`
      )
      .sort();
    expect(signature).toEqual([
      "source_image:path->image:images",
      "source_text:text->image:prompt",
      "source_text:text->text:prompt",
    ]);

    expect(migrated.project.graph.entryNodeIds).toEqual(["source_text", "source_image"]);
    expect(migrated.project.graph.groups).toEqual([
      {
        id: "group_1",
        name: "Group",
        nodeIds: ["source_text", "text", "image"],
      },
    ]);

    expect(
      migrated.project.migrations.applied.some((entry) => entry.id === "studio.inline-prompt-template.v1")
    ).toBe(true);

    expect(
      migrated.project.migrations.applied.some((entry) => entry.id === "studio.path-only-ports.v1")
    ).toBe(true);
  });

  it("remaps legacy split prompt ports before inlining", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "source_text",
        kind: "studio.input",
        version: "1.0.0",
        title: "Source",
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: "prompt",
        kind: "studio.prompt_template",
        version: "1.0.0",
        title: "Prompt",
        position: { x: 220, y: 0 },
        config: { template: "System instruction" },
      },
      {
        id: "text",
        kind: "studio.text_generation",
        version: "1.0.0",
        title: "Text",
        position: { x: 440, y: 0 },
        config: {},
      },
    );
    project.graph.edges.push(
      {
        id: "e1",
        fromNodeId: "source_text",
        fromPortId: "text",
        toNodeId: "prompt",
        toPortId: "text",
      },
      {
        id: "e2",
        fromNodeId: "prompt",
        fromPortId: "prompt_text",
        toNodeId: "text",
        toPortId: "prompt",
      },
      {
        id: "e3",
        fromNodeId: "prompt",
        fromPortId: "system_prompt",
        toNodeId: "text",
        toPortId: "system_prompt",
      },
    );

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const signature = migrated.project.graph.edges
      .map(
        (edge) => `${edge.fromNodeId}:${edge.fromPortId}->${edge.toNodeId}:${edge.toPortId}`
      )
      .sort();
    expect(signature).toEqual(["source_text:text->text:prompt"]);
    expect(migrated.project.graph.nodes.some((node) => node.kind === "studio.prompt_template")).toBe(false);
  });

  it("migrates resend audience sync nodes to generic batch HTTP request nodes", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "dataset",
        kind: "studio.dataset",
        version: "1.0.0",
        title: "Dataset",
        position: { x: 0, y: 0 },
        config: {
          workingDirectory: "/Users/systemsculpt/gits/systemsculpt-website",
          customQuery: "select 1",
        },
      },
      {
        id: "resend",
        kind: "studio.resend_audience_sync",
        version: "1.0.0",
        title: "Resend Audience Sync",
        position: { x: 220, y: 0 },
        config: {
          apiKeySource: "keychain_ref",
          apiKeyRef: "resend.marketing",
          apiBaseUrl: "https://api.resend.com",
          segmentId: "segment_123",
          maxContacts: 250,
          throttleMs: 500,
          maxRetries: 2,
          unsubscribed: false,
        },
      }
    );
    project.graph.edges.push({
      id: "e1",
      fromNodeId: "dataset",
      fromPortId: "email",
      toNodeId: "resend",
      toPortId: "emails",
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const migratedNode = migrated.project.graph.nodes.find((node) => node.id === "resend");
    expect(migratedNode?.kind).toBe("studio.http_request");
    expect(migratedNode?.config).toEqual(
      expect.objectContaining({
        mode: "batch_items",
        method: "POST",
        url: "https://api.resend.com/contacts",
        authSource: "keychain_ref",
        authTokenRef: "resend.marketing",
        itemBodyField: "email",
        maxRequests: 250,
        throttleMs: 500,
        maxRetries: 2,
      })
    );
    expect(migratedNode?.config.body).toEqual({
      unsubscribed: false,
      segments: [{ id: "segment_123" }],
    });

    const signature = migrated.project.graph.edges
      .map((edge) => `${edge.fromNodeId}:${edge.fromPortId}->${edge.toNodeId}:${edge.toPortId}`)
      .sort();
    expect(signature).toEqual(["dataset:email->resend:items"]);

    expect(
      migrated.project.migrations.applied.some((entry) => entry.id === "studio.resend-http-request.v1")
    ).toBe(true);
  });
});
