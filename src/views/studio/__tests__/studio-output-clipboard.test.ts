import { createEmptyStudioProject } from "../../../studio/schema";
import { buildGraphClipboardPayload } from "../systemsculpt-studio-view/StudioGraphClipboardModel";
import { materializeGraphClipboardPaste } from "../systemsculpt-studio-view/StudioGraphClipboardPasteMaterializer";
function connectedTextPromptProject() {
  const project = createEmptyStudioProject({ name: "Clipboard", policyPath: "policy.json", minPluginVersion: "0", maxRuns: 1, maxArtifactsMb: 1 });
  project.graph.nodes = [{ id: "image", kind: "studio.image_generation", version: "1.0.0", title: "Image", position: { x: 0, y: 0 }, config: {} }];
  return project;
}
  it.each([[false, false], [true, false], [false, true], [true, true]])("copies outputs with producer=%s pending=%s", (copyProducer, pending) => {
    const project = connectedTextPromptProject();
    project.graph.nodes.push({
      id: "output", kind: "studio.media_ingest", version: "1.0.0",
      title: "Result", position: { x: 850, y: 40 },
      config: { path: "result.png", __studio_managed_by: "studio.image_generation_output.v1",
        __studio_source_node_id: "image", __studio_source_output_index: 0,
        __studio_output_run_id: "original-run", ...(pending ? { __studio_pending: true, __studio_pending_run_id: "pending-run" } : {}) },
      disabled: false, continueOnError: false,
    });
    project.graph.groups = [{ id: "outputs", name: "Image Outputs", nodeIds: ["output"],
      outputForNodeId: "image", outputOffset: { x: 120, y: 30 } }];
    const payload = buildGraphClipboardPayload({ project,
      selectedNodeIds: copyProducer ? ["image", "output"] : ["output"] });
    if (pending && !copyProducer) { expect(payload).toBeNull(); return; }
    let nextId = 0;
    const pasted = materializeGraphClipboardPaste({ payload: payload!, anchor: { x: 1000, y: 600 },
      pasteCount: 0, normalizeNodePosition: position => position,
      nextNodeId: () => `copy-${nextId++}`, nextEdgeId: () => "edge-copy",
      nextGroupId: () => "group-copy", nextShapeId: () => "shape-copy", nextArrowId: () => "arrow-copy" });
    if (pending) { expect(pasted!.newNodes.map(node => node.kind)).toEqual(["studio.image_generation"]); expect(pasted!.newGroups).toEqual([]); return; }
    const output = pasted!.newNodes.find(node => node.kind === "studio.media_ingest")!;
    expect(output.config.path).toBe("result.png");
    expect(output.config.__studio_output_run_id).toBeUndefined();
    if (copyProducer) {
      const producer = pasted!.newNodes.find(node => node.kind === "studio.image_generation")!;
      expect(output.config.__studio_source_node_id).toBe(producer.id);
      expect(pasted!.newGroups).toEqual([expect.objectContaining({ outputForNodeId: producer.id,
        outputOffset: { x: 120, y: 30 }, nodeIds: [output.id] })]);
    } else {
      expect(output.config.__studio_source_node_id).toBeUndefined();
      expect(output.config.__studio_managed_by).toBeUndefined();
      expect(pasted!.newGroups).toEqual([]);
    }
  });

