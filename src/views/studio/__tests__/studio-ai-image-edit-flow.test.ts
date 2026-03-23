import {
  STUDIO_PROJECT_SCHEMA_V1,
  type StudioNodeDefinition,
  type StudioNodeInstance,
  type StudioProjectV1,
} from "../../../studio/types";
import {
  inferAiImageEditAspectRatio,
  insertAiImageEditNodes,
} from "../systemsculpt-studio-view/StudioAiImageEditFlow";

function definitionFixture(kind: string): StudioNodeDefinition {
  return {
    kind,
    version: "1.0.0",
    capabilityClass: kind === "studio.image_generation" ? "api" : "local_cpu",
    cachePolicy: "never",
    inputPorts: [],
    outputPorts: [],
    configDefaults: {},
    configSchema: {
      fields: [],
      allowUnknownKeys: true,
    },
    async execute() {
      return { outputs: {} };
    },
  };
}

function nodeFixture(kind: string, overrides?: Partial<StudioNodeInstance>): StudioNodeInstance {
  return {
    id: `${kind}_node`,
    kind,
    version: "1.0.0",
    title: kind,
    position: { x: 100, y: 120 },
    config: {},
    continueOnError: false,
    disabled: false,
    ...overrides,
  };
}

function projectFixture(nodes: StudioNodeInstance[], groups?: StudioProjectV1["graph"]["groups"]): StudioProjectV1 {
  return {
    schema: STUDIO_PROJECT_SCHEMA_V1,
    projectId: "project_ai_edit",
    name: "AI Edit Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes,
      edges: [],
      entryNodeIds: [nodes[0]?.id || ""].filter(Boolean),
      groups: groups || [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: ".systemsculpt/policy.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 25,
        maxArtifactsMb: 100,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

describe("StudioAiImageEditFlow", () => {
  it("infers a close supported aspect ratio from source dimensions", () => {
    expect(inferAiImageEditAspectRatio(1920, 1080)).toBe("16:9");
    expect(inferAiImageEditAspectRatio(1080, 1920)).toBe("9:16");
    expect(inferAiImageEditAspectRatio(1200, 1200)).toBe("1:1");
    expect(inferAiImageEditAspectRatio(1500, 1000)).toBe("3:2");
    expect(inferAiImageEditAspectRatio(1000, 1500)).toBe("2:3");
  });

  it("adds prompt and image-generation nodes plus wiring for an AI image edit", () => {
    const sourceNode = nodeFixture("studio.media_ingest", {
      id: "media_1",
      title: "Cover Image",
      position: { x: 80, y: 180 },
      config: { sourcePath: "Assets/source.png" },
    });
    const project = projectFixture([sourceNode]);

    const result = insertAiImageEditNodes({
      project,
      sourceNode,
      prompt: "Remove the background and add dramatic lighting",
      aspectRatio: "3:2",
      textDefinition: definitionFixture("studio.text"),
      imageGenerationDefinition: definitionFixture("studio.image_generation"),
      nextNodeId: jest.fn().mockReturnValueOnce("prompt_1").mockReturnValueOnce("image_1"),
      nextEdgeId: jest.fn().mockReturnValueOnce("edge_prompt").mockReturnValueOnce("edge_image"),
      cloneConfigDefaults: () => ({}),
      normalizeNodePosition: (position) => ({ x: Math.round(position.x), y: Math.round(position.y) }),
    });

    expect(result.promptNodeId).toBe("prompt_1");
    expect(result.imageGenerationNodeId).toBe("image_1");
    expect(project.graph.nodes.map((node) => node.id)).toEqual(["media_1", "prompt_1", "image_1"]);
    expect(project.graph.edges).toEqual([
      {
        id: "edge_prompt",
        fromNodeId: "prompt_1",
        fromPortId: "text",
        toNodeId: "image_1",
        toPortId: "prompt",
      },
      {
        id: "edge_image",
        fromNodeId: "media_1",
        fromPortId: "path",
        toNodeId: "image_1",
        toPortId: "images",
      },
    ]);

    const promptNode = project.graph.nodes.find((node) => node.id === "prompt_1");
    const imageNode = project.graph.nodes.find((node) => node.id === "image_1");
    expect(promptNode?.title).toBe("Cover Image Edit Prompt");
    expect(promptNode?.config.value).toBe("Remove the background and add dramatic lighting");
    expect(imageNode?.title).toBe("Cover Image AI Edit");
    expect(imageNode?.config.count).toBe(1);
    expect(imageNode?.config.aspectRatio).toBe("3:2");
  });

  it("adds the new AI edit nodes into the same group as the source image", () => {
    const sourceNode = nodeFixture("studio.media_ingest", {
      id: "media_1",
      title: "Source Image",
    });
    const project = projectFixture([sourceNode], [
      {
        id: "group_1",
        name: "Image Work",
        nodeIds: ["media_1"],
      },
    ]);

    insertAiImageEditNodes({
      project,
      sourceNode,
      prompt: "Make it look like a product shot",
      aspectRatio: "1:1",
      textDefinition: definitionFixture("studio.text"),
      imageGenerationDefinition: definitionFixture("studio.image_generation"),
      nextNodeId: jest.fn().mockReturnValueOnce("prompt_1").mockReturnValueOnce("image_1"),
      nextEdgeId: jest.fn().mockReturnValueOnce("edge_prompt").mockReturnValueOnce("edge_image"),
      cloneConfigDefaults: () => ({}),
      normalizeNodePosition: (position) => ({ x: Math.round(position.x), y: Math.round(position.y) }),
    });

    expect(project.graph.groups?.[0]?.nodeIds).toEqual(["media_1", "prompt_1", "image_1"]);
  });
});
