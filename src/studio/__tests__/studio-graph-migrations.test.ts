import type { StudioProjectV1 } from "../types";
import { migrateStudioProjectToPathOnlyPorts } from "../StudioGraphMigrations";
import { STUDIO_GRAPH_TEXT_NODE_DEFAULT_HEIGHT } from "../StudioNodeGeometry";

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
      // Modern fixture: text-node kinds already canonical, so the text-kind
      // rename pass never touches these projects. Legacy-kind tests strip
      // this stamp explicitly.
      applied: [{ id: "studio.text-node-kinds.v1", at: now }],
    },
  };
}

function legacyProject(): StudioProjectV1 {
  const project = baseProject();
  project.migrations.applied = [];
  return project;
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
          sourcePath: "/media/input.mp4",
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
      sourcePath: "/media/input.mp4",
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

  it("preserves non-legacy media ingest config like resized geometry and caption edits", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "media",
        kind: "studio.media_ingest",
        version: "1.0.0",
        title: "Media",
        position: { x: 0, y: 0 },
        config: {
          vaultPath: "/media/input.mp4",
          sourceMode: "local",
          assetMode: "auto",
          mediaKind: "video",
          width: 512,
          height: 356,
          captionBoard: {
            version: 1,
            labels: [],
          },
          __studio_renderedAsset: {
            path: "SystemSculpt/Studio/rendered.png",
          },
        },
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
    expect(migrated.changed).toBe(true);
    // Resized geometry survives as first-class size; caption edits and
    // rendered-asset bookkeeping stay in config.
    expect(migrated.project.graph.nodes[0].size).toEqual({ width: 512, height: 356 });
    expect(migrated.project.graph.nodes[0].config).toEqual({
      sourcePath: "/media/input.mp4",
      captionBoard: {
        version: 1,
        labels: [],
      },
      __studio_renderedAsset: {
        path: "SystemSculpt/Studio/rendered.png",
      },
    });
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
        config: { sourcePath: "/media/input.mp4" },
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

  it("retires resend audience sync nodes as secret-free unsupported placeholders", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "dataset",
        kind: "studio.dataset",
        version: "1.0.0",
        title: "Dataset",
        position: { x: 0, y: 0 },
        config: {
          workingDirectory: "/workspace/adapter-project",
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
    project.graph.edges.push({
      id: "e2",
      fromNodeId: "resend",
      fromPortId: "synced",
      toNodeId: "dataset",
      toPortId: "value",
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const migratedNode = migrated.project.graph.nodes.find((node) => node.id === "resend");
    expect(migratedNode).toMatchObject({
      kind: "studio.retired_http_request",
      version: "1.0.0",
      title: "Retired HTTP Request",
      config: {
        reason: "HTTP Request nodes are retired. Replace this node with a retained managed capability.",
      },
    });
    expect(JSON.stringify(migratedNode?.config)).not.toMatch(/segment_123|apiKey|bearer|https?:\/\//i);

    const signature = migrated.project.graph.edges
      .map((edge) => `${edge.fromNodeId}:${edge.fromPortId}->${edge.toNodeId}:${edge.toPortId}`)
      .sort();
    expect(signature).toEqual([]);

    expect(
      migrated.project.migrations.applied.some((entry) => entry.id === "studio.resend-http-request.v1")
    ).toBe(true);
  });

  it("migrates legacy note node config into canonical notes.items and removes legacy fields", () => {
    const project = baseProject();
    project.graph.nodes.push({
      id: "note_1",
      kind: "studio.note",
      version: "1.0.0",
      title: "Note",
      position: { x: 0, y: 0 },
      config: {
        vaultPath: "Inbox/Launch Plan.md",
        value: "legacy cached text",
      },
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const noteNode = migrated.project.graph.nodes.find((node) => node.id === "note_1");
    expect(noteNode?.config).toEqual({
      notes: {
        items: [
          {
            path: "Inbox/Launch Plan.md",
            enabled: true,
          },
        ],
      },
    });
    expect(
      migrated.project.migrations.applied.some(
        (entry) => entry.id === "studio.note-canonical-config.v1"
      )
    ).toBe(true);
  });

  it("removes legacy image provider/model fields and backfills managed resolution config", () => {
    const project = baseProject();
    project.graph.nodes.push({
      id: "image",
      kind: "studio.image_generation",
      version: "1.0.0",
      title: "Image",
      position: { x: 0, y: 0 },
      config: {
        count: 2,
        aspectRatio: "16:9",
        modelId: "openai/gpt-5-image",
        provider: "openai",
        providerId: "legacy-provider",
      },
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const imageNode = migrated.project.graph.nodes.find((node) => node.id === "image");
    expect(imageNode?.config).toEqual({
      count: 2,
      aspectRatio: "16:9",
      imageSize: "",
    });
    expect(
      migrated.project.migrations.applied.some(
        (entry) => entry.id === "studio.image-node-levers.v1"
      )
    ).toBe(true);
    expect(
      migrated.project.migrations.applied.some(
        (entry) => entry.id === "studio.managed-node-config.v1"
      )
    ).toBe(true);
    expect(migrateStudioProjectToPathOnlyPorts(migrated.project).changed).toBe(false);
  });

  it("clamps legacy image counts above the new maximum to 4", () => {
    const project = baseProject();
    project.graph.nodes.push({
      id: "image",
      kind: "studio.image_generation",
      version: "1.0.0",
      title: "Image",
      position: { x: 0, y: 0 },
      config: {
        count: 8,
        aspectRatio: "16:9",
      },
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const imageNode = migrated.project.graph.nodes.find((node) => node.id === "image");
    expect(imageNode?.config).toMatchObject({
      count: 4,
      aspectRatio: "16:9",
      imageSize: "",
    });
  });

  it("floors decimal legacy image counts to a valid integer", () => {
    const project = baseProject();
    project.graph.nodes.push({
      id: "image",
      kind: "studio.image_generation",
      version: "1.0.0",
      title: "Image",
      position: { x: 0, y: 0 },
      config: {
        count: 3.7,
      },
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const imageNode = migrated.project.graph.nodes.find((node) => node.id === "image");
    expect(imageNode?.config).toMatchObject({ count: 3 });
  });

  it("sanitizes configured legacy image model levers once, then remains idempotent", () => {
    const project = baseProject();
    project.graph.nodes.push({
      id: "image",
      kind: "studio.image_generation",
      version: "1.0.0",
      title: "Image",
      position: { x: 0, y: 0 },
      config: {
        modelId: "openai/gpt-5-image",
        provider: "openai",
        count: 1,
        aspectRatio: "1:1",
        imageSize: "2K",
      },
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);
    expect(migrated.project.graph.nodes.find((node) => node.id === "image")?.config).toEqual({
      count: 1,
      aspectRatio: "1:1",
      imageSize: "2K",
    });
    expect(
      migrated.project.migrations.applied.some(
        (entry) => entry.id === "studio.managed-node-config.v1"
      )
    ).toBe(true);
    expect(migrateStudioProjectToPathOnlyPorts(migrated.project).changed).toBe(false);
  });

  it("renames legacy studio.text and studio.label kinds in one atomic pass", () => {
    const project = legacyProject();
    project.graph.nodes.push(
      {
        id: "legacy_text",
        kind: "studio.text",
        version: "1.0.0",
        title: "Text Output",
        position: { x: 0, y: 0 },
        config: { value: "generated text", textDisplayMode: "rendered" },
      },
      {
        id: "legacy_label",
        kind: "studio.label",
        version: "1.0.0",
        title: "Text",
        position: { x: 220, y: 0 },
        config: { value: "annotation", fontSize: 18, width: 300, height: 120 },
      },
      {
        id: "generation",
        kind: "studio.text_generation",
        version: "1.0.0",
        title: "Generate",
        position: { x: 440, y: 0 },
        config: {},
      }
    );
    project.graph.edges.push({
      id: "e1",
      fromNodeId: "legacy_text",
      fromPortId: "text",
      toNodeId: "generation",
      toPortId: "prompt",
    });
    project.graph.entryNodeIds = ["legacy_text"];

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);

    const textOutputNode = migrated.project.graph.nodes.find((node) => node.id === "legacy_text");
    expect(textOutputNode?.kind).toBe("studio.text_output");
    expect(textOutputNode?.config).toEqual({
      value: "generated text",
      textDisplayMode: "rendered",
    });

    // The label rename must land on studio.text and never chain onward into
    // studio.text_output, even though both renames run in the same pass.
    const textNode = migrated.project.graph.nodes.find((node) => node.id === "legacy_label");
    expect(textNode?.kind).toBe("studio.text");
    expect(textNode?.config).toEqual({
      value: "annotation",
      fontSize: 18,
    });
    expect(textNode?.size).toEqual({ width: 300, height: 120 });

    const signature = migrated.project.graph.edges
      .map((edge) => `${edge.fromNodeId}:${edge.fromPortId}->${edge.toNodeId}:${edge.toPortId}`)
      .sort();
    expect(signature).toEqual(["legacy_text:text->generation:prompt"]);
    expect(migrated.project.graph.entryNodeIds).toEqual(["legacy_text"]);

    expect(
      migrated.project.migrations.applied.some((entry) => entry.id === "studio.text-node-kinds.v1")
    ).toBe(true);

    const rerun = migrateStudioProjectToPathOnlyPorts(migrated.project);
    expect(rerun.changed).toBe(false);
    expect(rerun.project).toBe(migrated.project);
  });

  it("stamps stampless projects without legacy text kinds so future studio.text nodes survive reloads", () => {
    const project = legacyProject();
    project.graph.nodes.push({
      id: "input",
      kind: "studio.input",
      version: "1.0.0",
      title: "Input",
      position: { x: 0, y: 0 },
      config: { value: "seed" },
    });

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(true);
    expect(migrated.project.graph.nodes[0].kind).toBe("studio.input");
    expect(
      migrated.project.migrations.applied.some((entry) => entry.id === "studio.text-node-kinds.v1")
    ).toBe(true);

    // A new-style Text node added after the stamp landed must never be
    // re-renamed to studio.text_output on later loads.
    migrated.project.graph.nodes.push({
      id: "new_text",
      kind: "studio.text",
      version: "1.0.0",
      title: "Text",
      position: { x: 220, y: 0 },
      config: { value: "note to self" },
    });
    const rerun = migrateStudioProjectToPathOnlyPorts(migrated.project);
    expect(rerun.changed).toBe(false);
    expect(
      rerun.project.graph.nodes.find((node) => node.id === "new_text")?.kind
    ).toBe("studio.text");
  });

  describe("node geometry migration to first-class size", () => {
    it("moves legacy config.width/config.height to node.size and strips the config keys", () => {
      const project = baseProject();
      project.graph.nodes.push({
        id: "media",
        kind: "studio.media_ingest",
        version: "1.0.0",
        title: "Media",
        position: { x: 0, y: 0 },
        config: {
          sourcePath: "/media/input.mp4",
          width: 512,
          height: 356,
          captionBoard: { version: 1, labels: [] },
        },
      });

      const migrated = migrateStudioProjectToPathOnlyPorts(project);
      expect(migrated.changed).toBe(true);

      const mediaNode = migrated.project.graph.nodes.find((node) => node.id === "media");
      expect(mediaNode?.size).toEqual({ width: 512, height: 356 });
      expect(mediaNode?.config).toEqual({
        sourcePath: "/media/input.mp4",
        captionBoard: { version: 1, labels: [] },
      });
    });

    it("keeps fontSize in config while moving text-node width/height to size", () => {
      const project = baseProject();
      project.graph.nodes.push({
        id: "text",
        kind: "studio.text",
        version: "1.0.0",
        title: "Text",
        position: { x: 0, y: 0 },
        config: { value: "annotation", fontSize: 18, width: 300, height: 120 },
      });

      const migrated = migrateStudioProjectToPathOnlyPorts(project);
      expect(migrated.changed).toBe(true);

      const textNode = migrated.project.graph.nodes.find((node) => node.id === "text");
      expect(textNode?.size).toEqual({ width: 300, height: 120 });
      expect(textNode?.config).toEqual({ value: "annotation", fontSize: 18 });
    });

    it("fills the kind default height when only a legacy width exists", () => {
      const project = baseProject();
      project.graph.nodes.push({
        id: "text",
        kind: "studio.text",
        version: "1.0.0",
        title: "Text",
        position: { x: 0, y: 0 },
        config: { value: "annotation", width: 300 },
      });

      const migrated = migrateStudioProjectToPathOnlyPorts(project);
      expect(migrated.changed).toBe(true);

      const textNode = migrated.project.graph.nodes.find((node) => node.id === "text");
      // The fill tracks the live text-node default height. The value is
      // inert for text cards (they render intrinsic height and persist
      // width-only), so it follows the kind default rather than freezing a
      // historical constant.
      expect(textNode?.size).toEqual({
        width: 300,
        height: STUDIO_GRAPH_TEXT_NODE_DEFAULT_HEIGHT,
      });
      expect(textNode?.config).toEqual({ value: "annotation" });
    });

    it("preserves first-class geometry while retiring and sanitizing an HTTP node", () => {
      const project = baseProject();
      project.graph.nodes.push({
        id: "http",
        kind: "studio.http_request",
        version: "1.0.0",
        title: "HTTP",
        position: { x: 0, y: 0 },
        config: {
          url: "https://secret.example.com",
          headers: { Authorization: "Bearer sentinel-header" },
          bearerToken: "sentinel-token",
          body: { secret: "sentinel-body" },
          width: 410,
          height: 320,
        },
      });

      const migrated = migrateStudioProjectToPathOnlyPorts(project);
      expect(migrated.changed).toBe(true);

      const httpNode = migrated.project.graph.nodes.find((node) => node.id === "http");
      expect(httpNode?.kind).toBe("studio.retired_http_request");
      expect(httpNode?.size).toEqual({ width: 410, height: 320 });
      expect(httpNode?.config).toEqual({
        reason: "HTTP Request nodes are retired. Replace this node with a retained managed capability.",
      });
      expect(JSON.stringify(httpNode)).not.toMatch(/secret\.example|sentinel-header|sentinel-token|sentinel-body/);
    });

    it("drops non-numeric geometry garbage without minting a size", () => {
      const project = baseProject();
      project.graph.nodes.push({
        id: "http",
        kind: "studio.http_request",
        version: "1.0.0",
        title: "HTTP",
        position: { x: 0, y: 0 },
        config: { url: "https://example.com", width: "abc", height: null },
      });

      const migrated = migrateStudioProjectToPathOnlyPorts(project);
      expect(migrated.changed).toBe(true);

      const httpNode = migrated.project.graph.nodes.find((node) => node.id === "http");
      expect(httpNode?.size).toBeUndefined();
      expect(httpNode?.kind).toBe("studio.retired_http_request");
      expect(httpNode?.config).toEqual({
        reason: "HTTP Request nodes are retired. Replace this node with a retained managed capability.",
      });
      expect(JSON.stringify(httpNode)).not.toContain("https://example.com");
    });

    it("keeps an existing size authoritative and only strips lingering legacy keys", () => {
      const project = baseProject();
      project.graph.nodes.push({
        id: "text",
        kind: "studio.text",
        version: "1.0.0",
        title: "Text",
        position: { x: 0, y: 0 },
        size: { width: 420, height: 260 },
        config: { value: "annotation", width: 300, height: 120 },
      });

      const migrated = migrateStudioProjectToPathOnlyPorts(project);
      expect(migrated.changed).toBe(true);

      const textNode = migrated.project.graph.nodes.find((node) => node.id === "text");
      expect(textNode?.size).toEqual({ width: 420, height: 260 });
      expect(textNode?.config).toEqual({ value: "annotation" });
    });

    it("is idempotent: a second run leaves the migrated project untouched", () => {
      const project = baseProject();
      project.graph.nodes.push({
        id: "text",
        kind: "studio.text",
        version: "1.0.0",
        title: "Text",
        position: { x: 0, y: 0 },
        config: { value: "annotation", fontSize: 18, width: 300, height: 120 },
      });

      const migrated = migrateStudioProjectToPathOnlyPorts(project);
      expect(migrated.changed).toBe(true);

      const rerun = migrateStudioProjectToPathOnlyPorts(migrated.project);
      expect(rerun.changed).toBe(false);
      expect(rerun.project).toBe(migrated.project);
    });
  });

  it("leaves already-migrated projects with modern studio.text nodes untouched", () => {
    const project = baseProject();
    project.graph.nodes.push(
      {
        id: "text",
        kind: "studio.text",
        version: "1.0.0",
        title: "Text",
        position: { x: 0, y: 0 },
        config: { value: "annotation" },
      },
      {
        id: "text_output",
        kind: "studio.text_output",
        version: "1.0.0",
        title: "Text Output",
        position: { x: 220, y: 0 },
        config: { value: "" },
      }
    );

    const migrated = migrateStudioProjectToPathOnlyPorts(project);
    expect(migrated.changed).toBe(false);
    expect(migrated.project).toBe(project);
    expect(migrated.project.graph.nodes.map((node) => node.kind)).toEqual([
      "studio.text",
      "studio.text_output",
    ]);
  });
});
