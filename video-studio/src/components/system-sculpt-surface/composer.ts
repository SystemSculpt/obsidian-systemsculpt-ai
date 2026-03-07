import { createChatComposer } from "@plugin-ui/createInputUI";
import {
  renderChatCreditsIndicator,
  renderChatModelIndicator,
  renderChatPromptIndicator,
} from "@plugin-ui/ChatComposerIndicators";
import { renderContextAttachmentPill } from "@plugin-ui/ContextAttachmentPills";
import type {
  AttachmentPillSpec,
  ChatStatusSurfaceSpec,
  ChatThreadSurfaceSpec,
  ToolbarChipSpec,
} from "../../lib/storyboard";
import { resolveTextReveal } from "../../lib/textReveal";
import { normalizeSurfaceIcon } from "./viewChrome";

const getToolbarChips = (toolbarChips: readonly ToolbarChipSpec[]) => {
  const model = toolbarChips.find((chip) => chip.icon === "bot" || chip.id.includes("model"));
  const prompt = toolbarChips.find(
    (chip) => chip.icon === "sparkles" || chip.id.includes("prompt")
  );
  const credits = toolbarChips.find(
    (chip) => chip.icon === "bolt" || chip.id.includes("credit")
  );
  return { model, prompt, credits };
};

const mountToolbarIndicators = (
  composer: ReturnType<typeof createChatComposer>,
  toolbarChips: readonly ToolbarChipSpec[]
) => {
  const { model, prompt, credits } = getToolbarChips(toolbarChips);

  composer.chips.empty();

  if (model) {
    const modelEl = composer.chips.createDiv({
      cls: "systemsculpt-model-indicator systemsculpt-chip",
    });
    const modelMeta = renderChatModelIndicator(modelEl, {
      labelOverride: model.label,
    });
    modelEl.setAttrs({
      role: "button",
      tabindex: 0,
      "aria-label": modelMeta.ariaLabel,
      title: modelMeta.title,
    });
  }

  if (prompt) {
    const promptEl = composer.chips.createDiv({
      cls: "systemsculpt-model-indicator systemsculpt-chip",
    });
    const promptMeta = renderChatPromptIndicator(promptEl, {
      labelOverride: prompt.label,
      promptType: prompt.icon === "file-text" ? "custom" : "general-use",
    });
    promptEl.setAttrs({
      role: "button",
      tabindex: 0,
      "aria-label": promptMeta.ariaLabel,
      title: promptMeta.title,
    });
  }

  const rightGroup = composer.toolbar.querySelector(
    ".systemsculpt-chat-composer-toolbar-group.mod-right"
  ) as HTMLElement | null;

  if (rightGroup && credits) {
    const creditsButton = rightGroup.createEl("button", {
      cls: "clickable-icon systemsculpt-chat-composer-button systemsculpt-credits-indicator",
      attr: { type: "button" },
    }) as HTMLButtonElement;
    const creditsMeta = renderChatCreditsIndicator(creditsButton, {
      titleOverride: credits.label ? `Credits balance: ${credits.label}` : undefined,
    });
    creditsButton.setAttrs({
      "aria-label": creditsMeta.title,
      title: creditsMeta.title,
    });
    creditsButton.classList.toggle("is-loading", creditsMeta.isLoading);
    creditsButton.classList.toggle("is-low", creditsMeta.isLow);
    rightGroup.insertBefore(creditsButton, composer.settingsButton.buttonEl);
  }
};

export const mountComposer = (
  root: HTMLElement,
  toolbarChips: readonly ToolbarChipSpec[],
  attachments: readonly AttachmentPillSpec[],
  draft: ChatThreadSurfaceSpec["draft"] | ChatStatusSurfaceSpec["draft"],
  recording: ChatThreadSurfaceSpec["recording"] | "none",
  stopVisible: boolean,
  frame: number,
  fps: number
) => {
  const composer = createChatComposer(root, {
    onEditSystemPrompt: () => {},
    onAddContextFile: () => {},
    onSend: () => {},
    onStop: () => {},
    registerDomEvent: (
      el: HTMLElement,
      type: keyof HTMLElementEventMap | string,
      callback: (evt: Event) => void
    ) => {
      el.addEventListener(type as string, callback as EventListener);
    },
    onKeyDown: () => {},
    onInput: () => {},
    onPaste: () => {},
    handleMicClick: () => {},
    handleVideoClick: () => {},
    showVideoButton: () => true,
    canUseVideoRecording: () => true,
    hasProLicense: () => true,
  });

  mountToolbarIndicators(composer, toolbarChips);

  if (attachments.length > 0) {
    composer.attachments.style.display = "flex";
    attachments.forEach((attachment) => {
      const pill = composer.attachments.createDiv();
      if (attachment.state === "processing") {
        renderContextAttachmentPill(pill, {
          kind: "processing",
          processingKey: attachment.id,
          linkText: attachment.label,
          label: attachment.label,
          icon: normalizeSurfaceIcon(attachment.icon),
          title: attachment.label,
          statusIcon: "loader-2",
          spinning: true,
          removeAriaLabel: "Dismiss processing status",
        });
      } else {
        renderContextAttachmentPill(pill, {
          kind: "file",
          wikiLink: `[[${attachment.label}]]`,
          linkText: attachment.label,
          label: attachment.label,
          icon: normalizeSurfaceIcon(attachment.icon),
          title: attachment.label,
          removeAriaLabel: "Remove file from context",
        });
      }
    });
  }

  const draftResult = resolveTextReveal(
    draft?.text ?? "",
    frame,
    fps,
    draft?.reveal
  );
  composer.input.value = draftResult.text;
  composer.input.placeholder = draft?.placeholder ?? "Write a message...";
  if (draftResult.text.trim().length > 0) {
    composer.inputWrap.classList.add("has-value", "is-focused");
    composer.sendButton.setDisabled(false);
  }

  if (recording === "mic") {
    composer.micButton.buttonEl.classList.add("ss-active");
  }
  if (recording === "video") {
    composer.videoButton.buttonEl.classList.add("ss-active");
  }
  if (stopVisible) {
    composer.stopButton.buttonEl.style.display = "flex";
    composer.sendButton.buttonEl.style.display = "none";
  }

  return composer;
};
