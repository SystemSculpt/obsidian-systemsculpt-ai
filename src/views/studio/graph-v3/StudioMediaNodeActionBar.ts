import { setIcon } from "obsidian";
import type {
  StudioJsonValue,
  StudioNodeConfigFieldDefinition,
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import { browseForNodeConfigPath } from "../StudioPathFieldPicker";
import { markStudioNodeCardInteractive } from "./StudioGraphNodeCardPointer";
import type { StudioGraphNodeMutationOptions } from "./StudioGraphNodeCardTypes";

const MEDIA_SOURCE_CONFIG_KEY = "sourcePath";

export interface RenderStudioMediaNodeActionBarOptions {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  definition: StudioNodeDefinition;
  mediaKind: "image" | "video";
  interactionLocked: boolean;
  onRunNode: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onOpenImageEditor?: (node: StudioNodeInstance) => void;
  onEditImageWithAi?: (node: StudioNodeInstance) => void;
  onCopyNodeImageToClipboard?: (node: StudioNodeInstance) => void;
}

interface MediaBarAction {
  id: string;
  icon: string;
  label: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

function resolveMediaSourceField(
  definition: StudioNodeDefinition
): StudioNodeConfigFieldDefinition {
  const declared = (definition.configSchema?.fields || []).find(
    (field) => field.key === MEDIA_SOURCE_CONFIG_KEY
  );
  return (
    declared || {
      key: MEDIA_SOURCE_CONFIG_KEY,
      label: "Source Path",
      type: "media_path",
      allowOutsideVault: true,
      mediaKinds: ["image", "video", "audio"],
    }
  );
}

function resolveActions(options: RenderStudioMediaNodeActionBarOptions): MediaBarAction[] {
  const {
    node,
    definition,
    mediaKind,
    onRunNode,
    onRemoveNode,
    onNodeConfigValueChange,
    onOpenImageEditor,
    onEditImageWithAi,
    onCopyNodeImageToClipboard,
  } = options;

  const actions: MediaBarAction[] = [
    { id: "run", icon: "play", label: "Run node", run: () => onRunNode(node.id) },
  ];
  if (mediaKind === "image" && onEditImageWithAi) {
    actions.push({
      id: "ai-edit",
      icon: "sparkles",
      label: "Edit with AI",
      run: () => onEditImageWithAi(node),
    });
  }
  if (mediaKind === "image" && onOpenImageEditor) {
    actions.push({
      id: "edit",
      icon: "pencil",
      label: "Edit image",
      run: () => onOpenImageEditor(node),
    });
  }
  if (mediaKind === "image" && onCopyNodeImageToClipboard) {
    actions.push({
      id: "copy",
      icon: "copy",
      label: "Copy image",
      run: () => onCopyNodeImageToClipboard(node),
    });
  }
  if (onNodeConfigValueChange) {
    actions.push({
      id: "replace",
      icon: "folder-open",
      label: "Replace media",
      run: async () => {
        const selected = await browseForNodeConfigPath(resolveMediaSourceField(definition));
        if (!selected) {
          return;
        }
        onNodeConfigValueChange(node.id, MEDIA_SOURCE_CONFIG_KEY, selected, {
          mode: "discrete",
        });
      },
    });
  }
  actions.push({
    id: "delete",
    icon: "trash-2",
    label: "Delete node",
    danger: true,
    run: () => onRemoveNode(node.id),
  });
  return actions;
}

/**
 * Action bar for media nodes whose card IS the media: one flat pill of
 * icon buttons floating inside the media's edge — bottom for images,
 * top for videos so the native playback controls stay free — always
 * visible (the studio has no hover-revealed chrome).
 *
 * The bar owns every pointer gesture that starts on it: pointerdown
 * stops here, before any card-drag, marquee, selection, or
 * pointer-capture machinery can see it, so the browser is guaranteed
 * to deliver the follow-up click back to the pressed button.
 *
 * Locked state uses is-locked + aria-disabled instead of the disabled
 * attribute: disabled form controls swallow pointer events inconsistently
 * across engines, and the bar must keep owning its gestures either way.
 */
export function renderStudioMediaNodeActionBar(
  options: RenderStudioMediaNodeActionBarOptions
): void {
  const { nodeEl, mediaKind, interactionLocked } = options;

  const barEl = nodeEl.createDiv({
    cls: `ss-studio-media-action-bar${mediaKind === "video" ? " is-top" : ""}`,
  });
  markStudioNodeCardInteractive(barEl);
  barEl.classList.toggle("is-locked", interactionLocked);

  const actionsById = new Map<string, MediaBarAction>();
  for (const action of resolveActions(options)) {
    actionsById.set(action.id, action);
    const buttonEl = barEl.createEl("button", {
      cls: `ss-studio-media-action${action.danger ? " is-danger" : ""}`,
      attr: {
        type: "button",
        "aria-label": action.label,
        title: action.label,
        "data-media-action": action.id,
        ...(interactionLocked ? { "aria-disabled": "true" } : {}),
      },
    });
    setIcon(buttonEl, action.icon);
  }

  barEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    event.preventDefault();
  });
  barEl.addEventListener("pointerup", (event) => {
    event.stopPropagation();
  });
  barEl.addEventListener("click", (event) => {
    event.stopPropagation();
    if (interactionLocked) {
      return;
    }
    const buttonEl =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-media-action]")
        : null;
    const action = buttonEl?.dataset.mediaAction
      ? actionsById.get(buttonEl.dataset.mediaAction)
      : null;
    if (!action) {
      return;
    }
    void action.run();
  });
}
