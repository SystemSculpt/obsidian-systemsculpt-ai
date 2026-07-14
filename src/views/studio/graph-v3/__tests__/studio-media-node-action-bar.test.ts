/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import { renderStudioMediaNodeActionBar } from "../StudioMediaNodeActionBar";
import { browseForNodeConfigPath } from "../../StudioPathFieldPicker";

jest.mock("../../StudioPathFieldPicker", () => ({
  browseForNodeConfigPath: jest.fn(async () => null),
}));

const browseMock = browseForNodeConfigPath as jest.MockedFunction<typeof browseForNodeConfigPath>;

function createNode(): StudioNodeInstance {
  return {
    id: "media_node",
    kind: "studio.media_ingest",
    version: "1.0.0",
    title: "Poster frame",
    position: { x: 0, y: 0 },
    config: { sourcePath: "Assets/poster.png" },
    continueOnError: false,
    disabled: false,
  };
}

function createDefinition(): StudioNodeDefinition {
  return {
    kind: "studio.media_ingest",
    version: "1.0.0",
    capabilityClass: "local_io",
    cachePolicy: "by_inputs",
    inputPorts: [],
    outputPorts: [],
    configDefaults: { sourcePath: "" },
    configSchema: {
      fields: [
        {
          key: "sourcePath",
          label: "Source Path",
          type: "media_path",
          required: true,
          allowOutsideVault: true,
          mediaKinds: ["image", "video", "audio"],
        },
      ],
      allowUnknownKeys: true,
    },
    async execute() {
      return { outputs: {} };
    },
  };
}

function renderBarHarness(overrides: {
  mediaKind?: "image" | "video";
  interactionLocked?: boolean;
  onNodeConfigValueChange?: jest.Mock | null;
} = {}) {
  const nodeEl = document.body.createDiv({ cls: "ss-studio-node-card" });
  const node = createNode();
  const onNodeConfigValueChange =
    overrides.onNodeConfigValueChange === null
      ? undefined
      : overrides.onNodeConfigValueChange ?? jest.fn();
  const handlers = {
    onRunNode: jest.fn(),
    onRemoveNode: jest.fn(),
    onOpenImageEditor: jest.fn(),
    onEditImageWithAi: jest.fn(),
    onCopyNodeImageToClipboard: jest.fn(),
  };

  renderStudioMediaNodeActionBar({
    nodeEl,
    node,
    definition: createDefinition(),
    mediaKind: overrides.mediaKind ?? "image",
    interactionLocked: overrides.interactionLocked ?? false,
    onNodeConfigValueChange,
    ...handlers,
  });

  const barEl = nodeEl.querySelector<HTMLElement>(".ss-studio-media-action-bar");
  return { nodeEl, barEl, node, handlers, onNodeConfigValueChange };
}

function buttonFor(nodeEl: HTMLElement, label: string): HTMLButtonElement | null {
  return nodeEl.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function createPointerEvent(type: string, init: PointerEventInit = {}): Event {
  // jsdom has no PointerEvent constructor; MouseEvent carries the fields
  // the handlers read.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("renderStudioMediaNodeActionBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    browseMock.mockReset();
    browseMock.mockResolvedValue(null);
  });

  it("renders one flat pill of actions for images — no dividers, no scrim layers", () => {
    const { nodeEl, barEl } = renderBarHarness();

    expect(barEl).not.toBeNull();
    expect(barEl?.classList.contains("is-top")).toBe(false);
    expect(nodeEl.querySelector(".ss-studio-media-node-actions-divider")).toBeNull();
    const labels = Array.from(barEl?.querySelectorAll("button") ?? []).map((button) =>
      button.getAttribute("aria-label")
    );
    expect(labels).toEqual([
      "Run node",
      "Edit with AI",
      "Edit image",
      "Copy image",
      "Replace media",
      "Delete node",
    ]);
  });

  it("pins the bar to the top for videos and omits image-only actions", () => {
    const { barEl } = renderBarHarness({ mediaKind: "video" });

    expect(barEl?.classList.contains("is-top")).toBe(true);
    const labels = Array.from(barEl?.querySelectorAll("button") ?? []).map((button) =>
      button.getAttribute("aria-label")
    );
    expect(labels).toEqual(["Run node", "Replace media", "Delete node"]);
  });

  it("fires each action exactly once per click", () => {
    const { nodeEl, node, handlers } = renderBarHarness();

    buttonFor(nodeEl, "Run node")?.click();
    buttonFor(nodeEl, "Edit with AI")?.click();
    buttonFor(nodeEl, "Edit image")?.click();
    buttonFor(nodeEl, "Copy image")?.click();
    buttonFor(nodeEl, "Delete node")?.click();

    expect(handlers.onRunNode).toHaveBeenCalledTimes(1);
    expect(handlers.onRunNode).toHaveBeenCalledWith(node.id);
    expect(handlers.onEditImageWithAi).toHaveBeenCalledTimes(1);
    expect(handlers.onEditImageWithAi).toHaveBeenCalledWith(node);
    expect(handlers.onOpenImageEditor).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenImageEditor).toHaveBeenCalledWith(node);
    expect(handlers.onCopyNodeImageToClipboard).toHaveBeenCalledTimes(1);
    expect(handlers.onCopyNodeImageToClipboard).toHaveBeenCalledWith(node);
    expect(handlers.onRemoveNode).toHaveBeenCalledTimes(1);
    expect(handlers.onRemoveNode).toHaveBeenCalledWith(node.id);
  });

  it("owns every pointer gesture: pointerdown/pointerup/click never escape the bar", () => {
    const { nodeEl, barEl } = renderBarHarness();
    const escaped = { pointerdown: 0, pointerup: 0, click: 0 };
    nodeEl.addEventListener("pointerdown", () => { escaped.pointerdown += 1; });
    nodeEl.addEventListener("pointerup", () => { escaped.pointerup += 1; });
    nodeEl.addEventListener("click", () => { escaped.click += 1; });

    const runButton = buttonFor(nodeEl, "Run node");
    runButton?.dispatchEvent(createPointerEvent("pointerdown"));
    runButton?.dispatchEvent(createPointerEvent("pointerup"));
    runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    barEl?.dispatchEvent(createPointerEvent("pointerdown"));

    expect(escaped).toEqual({ pointerdown: 0, pointerup: 0, click: 0 });
  });

  it("cancels pointerdown so no default gesture (focus/drag/selection) can start", () => {
    const { nodeEl } = renderBarHarness();
    const runButton = buttonFor(nodeEl, "Run node");
    const event = createPointerEvent("pointerdown");

    runButton?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("commits a browsed replacement path through the discrete config channel", async () => {
    browseMock.mockResolvedValue("Assets/replacement.png");
    const onNodeConfigValueChange = jest.fn();
    const { nodeEl, node } = renderBarHarness({ onNodeConfigValueChange });

    buttonFor(nodeEl, "Replace media")?.click();
    await flushMicrotasks();

    expect(browseMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "sourcePath", type: "media_path" }),
      expect.any(HTMLElement),
      undefined
    );
    expect(onNodeConfigValueChange).toHaveBeenCalledWith(
      node.id,
      "sourcePath",
      "Assets/replacement.png",
      { mode: "discrete" }
    );
  });

  it("commits nothing when browsing is cancelled", async () => {
    browseMock.mockResolvedValue(null);
    const { nodeEl, onNodeConfigValueChange } = renderBarHarness();

    buttonFor(nodeEl, "Replace media")?.click();
    await flushMicrotasks();

    expect(onNodeConfigValueChange).not.toHaveBeenCalled();
  });

  it("omits the replace action when no config change channel is wired", () => {
    const { nodeEl } = renderBarHarness({ onNodeConfigValueChange: null });

    expect(buttonFor(nodeEl, "Replace media")).toBeNull();
    expect(buttonFor(nodeEl, "Run node")).not.toBeNull();
  });

  it("locks via is-locked + aria-disabled instead of the disabled attribute", () => {
    const { nodeEl, barEl, handlers } = renderBarHarness({ interactionLocked: true });

    expect(barEl?.classList.contains("is-locked")).toBe(true);
    const buttons = Array.from(barEl?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      // Disabled controls swallow pointer events inconsistently across
      // engines; the bar must keep owning its gestures while locked.
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }

    buttonFor(nodeEl, "Run node")?.click();
    buttonFor(nodeEl, "Delete node")?.click();
    expect(handlers.onRunNode).not.toHaveBeenCalled();
    expect(handlers.onRemoveNode).not.toHaveBeenCalled();
  });
});
