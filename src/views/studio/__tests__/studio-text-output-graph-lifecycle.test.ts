import { registerBuiltInStudioNodes } from "../../../studio/StudioBuiltInNodes";
import { StudioGraphCompiler } from "../../../studio/StudioGraphCompiler";
import { StudioNodeRegistry } from "../../../studio/StudioNodeRegistry";
import { createEmptyStudioProject } from "../../../studio/schema";
import type { StudioProjectV1 } from "../../../studio/types";
import {
  buildGraphClipboardPayload,
} from "../systemsculpt-studio-view/StudioGraphClipboardModel";
import { materializeGraphClipboardPaste } from "../systemsculpt-studio-view/StudioGraphClipboardPasteMaterializer";
import { StudioGraphHistory } from "../StudioGraphHistory";
import { cloneStudioProjectSnapshot } from "../../../studio/StudioProjectSnapshots";

function connectedTextPromptProject(): StudioProjectV1 {
  const project = createEmptyStudioProject({
    name: "Text output lifecycle",
    policyPath: "Studio/Text output lifecycle.systemsculpt-assets/policy/grants.json",
    minPluginVersion: "6.2.2",
    maxRuns: 10,
    maxArtifactsMb: 128,
  });
  project.graph.nodes = [
    {
      id: "prompt",
      kind: "studio.text",
      version: "1.0.0",
      title: "Prompt",
      position: { x: 20, y: 40 },
      size: { width: 280 },
      config: {
        value: "Portrait of a fox in amber light",
        fontSize: 14,
      },
      continueOnError: false,
      disabled: false,
    },
    {
      id: "image",
      kind: "studio.image_generation",
      version: "1.0.0",
      title: "Image Generation",
      position: { x: 400, y: 40 },
      config: {
        count: 1,
        aspectRatio: "1:1",
      },
      continueOnError: false,
      disabled: false,
    },
  ];
  project.graph.edges = [{
    id: "prompt-edge",
    fromNodeId: "prompt",
    fromPortId: "text",
    toNodeId: "image",
    toPortId: "prompt",
  }];
  project.graph.entryNodeIds = ["prompt"];
  return project;
}

describe("minimal text output graph lifecycle", () => {
  it("copies and pastes the typed prompt edge with remapped stable endpoints", () => {
    const sourceProject = connectedTextPromptProject();
    const payload = buildGraphClipboardPayload({
      project: sourceProject,
      selectedNodeIds: ["prompt", "image"],
    });
    expect(payload).not.toBeNull();

    const nodeIds = ["pasted-prompt", "pasted-image"][Symbol.iterator]();
    const pasted = materializeGraphClipboardPaste({
      payload: payload!,
      anchor: { x: 800, y: 200 },
      pasteCount: 0,
      normalizeNodePosition: (position) => position,
      nextNodeId: () => nodeIds.next().value!,
      nextEdgeId: () => "pasted-edge",
      nextGroupId: () => "unused-group",
    });

    expect(pasted?.newEdges).toEqual([{
      id: "pasted-edge",
      fromNodeId: "pasted-prompt",
      fromPortId: "text",
      toNodeId: "pasted-image",
      toPortId: "prompt",
    }]);

    const pastedProject = createEmptyStudioProject({
      name: "Pasted text output",
      policyPath: "Studio/Pasted text output.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "6.2.2",
      maxRuns: 10,
      maxArtifactsMb: 128,
    });
    pastedProject.graph.nodes = pasted!.newNodes;
    pastedProject.graph.edges = pasted!.newEdges;
    pastedProject.graph.entryNodeIds = ["pasted-prompt"];
    const registry = new StudioNodeRegistry();
    registerBuiltInStudioNodes(registry);

    expect(
      new StudioGraphCompiler().compile(pastedProject, registry).executionOrder
    ).toEqual(["pasted-prompt", "pasted-image"]);
  });

  it.each([false, true])("restores edge identity through graph undo and redo (with peer edit: %s)", withPeerEdit => {
    const connected = connectedTextPromptProject();
    const deleted = cloneStudioProjectSnapshot(connected);
    deleted.graph.nodes = deleted.graph.nodes.filter((node) => node.id !== "prompt");
    deleted.graph.edges = deleted.graph.edges.filter(
      (edge) => edge.fromNodeId !== "prompt" && edge.toNodeId !== "prompt"
    );
    deleted.graph.entryNodeIds = ["image"];

    const history = new StudioGraphHistory(20);
    history.reset(connected, ["prompt"]);
    history.checkpoint(deleted, ["image"]);

    const live = cloneStudioProjectSnapshot(deleted);
    if (withPeerEdit) live.name = "Peer renamed project";
    const undo = history.undo(undefined, { project: live, selectedNodeIds: [] });
    expect(undo?.project.graph.nodes.some((node) => node.id === "prompt")).toBe(true);
    expect(undo?.project.graph.edges).toEqual(connected.graph.edges);
    expect(undo?.project.name).toBe(withPeerEdit ? "Peer renamed project" : connected.name);

    const redo = history.redo();
    expect(redo?.project.graph.nodes.some((node) => node.id === "prompt")).toBe(false);
    expect(redo?.project.graph.edges).toEqual([]);
  });
});
