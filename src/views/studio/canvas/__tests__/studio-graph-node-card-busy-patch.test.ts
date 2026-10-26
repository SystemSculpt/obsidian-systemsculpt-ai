/** @jest-environment jsdom */
import type { StudioNodeInstance } from "../../../../studio/types";
import { StudioNodeRegistry } from "../../../../studio/StudioNodeRegistry";
import { registerBuiltInStudioNodes } from "../../../../studio/StudioBuiltInNodes";
import { renderStudioGraphNodeCard, type StudioGraphNodeCardHandle } from "../StudioGraphNodeCardRenderer";

jest.mock("../../../../platform/hostCapabilities", () => ({ hasHostCapability: () => true }));

const registry = new StudioNodeRegistry();
registerBuiltInStudioNodes(registry);
const definitions = registry.list();

function render(kind: string, busy: boolean, config: StudioNodeInstance["config"] = {}): { handle: StudioGraphNodeCardHandle; nodeEl: HTMLElement } {
  const definition = definitions.find(item => item.kind === kind)!;
  const node: StudioNodeInstance = {
    id: "node", kind, version: definition.version, title: kind, position: { x: 0, y: 0 },
    config: { ...JSON.parse(JSON.stringify(definition.configDefaults ?? {})), ...config }, continueOnError: false, disabled: false,
  };
  const no = jest.fn();
  const layer = document.body.createDiv();
  const handle = renderStudioGraphNodeCard({
    layer, busy, node, nodeDetailMode: "expanded", inboundEdges: [],
    nodeRunState: { status: "idle", message: "", updatedAt: null, outputs: null },
    graphInteraction: {
      isNodeSelected: () => false, registerNodeElement: no, getGraphZoom: () => 1, registerPortElement: no,
      isPendingConnectionSource: () => false, getPendingConnection: () => null,
    } as any,
    findNodeDefinition: () => definition, resolveAssetPreviewSrc: path => `app://vault/${path}`, onRunNode: no, onCopyTextGenerationPromptBundle: no,
    onToggleTextGenerationOutputLock: no, onRemoveNode: no, onNodeTitleInput: no, onNodeConfigMutated: no,
    onNodeConfigValueChange: no, onNodeSourceApply: no, onNodeGeometryMutated: no,
    takeTextNodeEditorMountState: () => ({ isEditing: false, shouldAutoFocus: false }),
    onRequestTextNodeEdit: no, onStopTextNodeEdit: no, onRevealPathInFinder: no,
  });
  return { handle, nodeEl: handle.element };
}

/** Everything a lock changes, element by element in document order. */
function lockState(nodeEl: HTMLElement): string[] {
  return [nodeEl, ...nodeEl.querySelectorAll<HTMLElement>("*")].map(element => {
    const control = element as HTMLElement & { disabled?: boolean; readOnly?: boolean };
    return [
      element.tagName, element.getAttribute("data-testid") ?? "",
      control.disabled === true ? "disabled" : "", control.readOnly === true ? "readonly" : "",
      element.getAttribute("aria-disabled") ?? "", element.classList.contains("is-disabled") ? "is-disabled" : "",
      element.classList.contains("is-locked") ? "is-locked" : "",
    ].join("|");
  });
}

describe("a run starting or ending, patched into a mounted card", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  const patchable = definitions.map(definition => definition.kind).filter(kind => !["studio.command_center", "studio.button"].includes(kind));

  const cases: Array<[string, StudioNodeInstance["config"]]> = [
    ...patchable.map(kind => [kind, {}] as [string, StudioNodeInstance["config"]]),
    // The picture is the card; its action bar rides below it.
    ["studio.media_ingest", { sourcePath: "Assets/photo.png" }],
  ];

  it.each(cases)("%s %j matches a card rendered fresh in that state", (kind, config) => {
    const fresh = { idle: lockState(render(kind, false, config).nodeEl), running: lockState(render(kind, true, config).nodeEl) };
    expect(fresh.running).not.toEqual(fresh.idle);
    const card = render(kind, false, config);
    expect(card.handle.setBusy).toBeDefined();
    if (Object.keys(config).length > 0) expect(card.nodeEl.dataset.surface).toBe("media");
    card.handle.setBusy!(true);
    expect(lockState(card.nodeEl)).toEqual(fresh.running);
    card.handle.setBusy!(false);
    expect(lockState(card.nodeEl)).toEqual(fresh.idle);
  });

  it.each(["studio.command_center", "studio.button"])("%s remounts instead, since it shows other nodes' run status", (kind) => {
    expect(render(kind, false).handle.setBusy).toBeUndefined();
  });
});
