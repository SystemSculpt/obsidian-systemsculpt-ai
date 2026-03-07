import type { CSSProperties } from "react";
import { useLayoutEffect, useRef } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { createChatComposer } from "@plugin-ui/createInputUI";
import { ContextSelectionModal } from "@plugin-ui/ContextSelectionModal";
import { createInlineBlock, getBlockContent } from "@plugin-ui/InlineCollapsibleBlock";
import { renderCitationFooter } from "@plugin-ui/CitationFooter";
import { renderChatStatusSurface } from "@plugin-ui/ChatStatusSurface";
import {
  renderChatCreditsIndicator,
  renderChatModelIndicator,
  renderChatPromptIndicator,
} from "@plugin-ui/ChatComposerIndicators";
import { renderContextAttachmentPill } from "@plugin-ui/ContextAttachmentPills";
import { appendMessageToGroupedContainer } from "@plugin-ui/MessageGrouping";
import { TFile, setIcon } from "../shims/obsidian";
import { ensureObsidianDomCompat } from "../shims/domCompat";
import type {
  AttachmentPillSpec,
  ChatMessageSpec,
  ChatStatusSurfaceSpec,
  ChatThreadSurfaceSpec,
  ContextModalSurfaceSpec,
  InlineBlockSpec,
  SurfaceIconName,
  SurfaceSpec,
  ToolbarChipSpec,
  SceneSpec,
  ViewActionSpec,
  ViewChromeSpec,
} from "../lib/storyboard";
import { resolveTextReveal, resolveTextRevealLines } from "../lib/textReveal";

ensureObsidianDomCompat();

const obsidianThemeStyle: CSSProperties = {
  colorScheme: "dark",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  color: "#dadada",
  background: "#1e1e1e",
  ["--font-ui-smallest" as string]: "11px",
  ["--font-ui-smaller" as string]: "12px",
  ["--font-ui-small" as string]: "13px",
  ["--font-ui-medium" as string]: "14px",
  ["--font-medium" as string]: "600",
  ["--size-2-1" as string]: "4px",
  ["--size-2-2" as string]: "8px",
  ["--size-2-3" as string]: "10px",
  ["--size-4-1" as string]: "6px",
  ["--size-4-2" as string]: "10px",
  ["--size-4-3" as string]: "14px",
  ["--size-4-8" as string]: "28px",
  ["--radius-s" as string]: "8px",
  ["--radius-m" as string]: "8px",
  ["--icon-m" as string]: "18px",
  ["--icon-xl" as string]: "28px",
  ["--checkbox-size" as string]: "18px",
  ["--background-primary" as string]: "#1e1e1e",
  ["--background-primary-rgb" as string]: "30, 30, 30",
  ["--background-primary-alt" as string]: "#242424",
  ["--background-primary-alt-rgb" as string]: "36, 36, 36",
  ["--background-secondary" as string]: "#262626",
  ["--background-secondary-alt" as string]: "#363636",
  ["--background-secondary-rgb" as string]: "38, 38, 38",
  ["--background-modifier-border" as string]: "#363636",
  ["--background-modifier-border-rgb" as string]: "54, 54, 54",
  ["--background-modifier-border-hover" as string]: "#4a4a4a",
  ["--background-modifier-border-focus" as string]: "hsl(258, 88%, 66%)",
  ["--background-modifier-hover" as string]: "#2c2c2c",
  ["--background-modifier-active-hover" as string]: "#323232",
  ["--background-modifier-form-field" as string]: "#242424",
  ["--background-modifier-success" as string]: "#1f3b2b",
  ["--text-normal" as string]: "#dadada",
  ["--text-muted" as string]: "#b3b3b3",
  ["--text-muted-rgb" as string]: "179, 179, 179",
  ["--text-faint" as string]: "#8f8f8f",
  ["--text-accent" as string]: "hsl(258, 88%, 66%)",
  ["--text-accent-hover" as string]: "hsl(258, 88%, 72%)",
  ["--text-on-accent" as string]: "#ffffff",
  ["--text-error" as string]: "#ff8585",
  ["--text-error-rgb" as string]: "255, 133, 133",
  ["--text-warning" as string]: "#e4b75f",
  ["--interactive-normal" as string]: "#2b2b2b",
  ["--interactive-hover" as string]: "#343434",
  ["--interactive-accent" as string]: "hsl(258, 88%, 66%)",
  ["--interactive-accent-rgb" as string]: "138, 92, 245",
  ["--interactive-accent-hover" as string]: "hsl(258, 88%, 72%)",
  ["--ss-layer-base" as string]: "#1e1e1e",
  ["--color-yellow" as string]: "#d9a441",
  ["--color-green" as string]: "#2e9f69",
  ["--color-green-rgb" as string]: "46, 159, 105",
  ["--color-red" as string]: "#d14343",
  ["--color-red-rgb" as string]: "209, 67, 67",
  ["--icon-color" as string]: "#b3b3b3",
  ["--icon-color-disabled" as string]: "#7d7d7d",
};

const hostControlCss = `
.workspace-leaf-content[data-type="systemsculpt-chat-view"] button {
  font: inherit;
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] .clickable-icon {
  appearance: none;
  -webkit-appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  margin: 0;
  background: transparent;
  box-shadow: none;
  color: var(--icon-color);
  cursor: pointer;
  flex-shrink: 0;
  line-height: 1;
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] .clickable-icon:hover:not(:disabled),
.workspace-leaf-content[data-type="systemsculpt-chat-view"] .clickable-icon:focus-visible:not(:disabled) {
  color: var(--text-normal);
  background: var(--interactive-hover);
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] .clickable-icon:disabled {
  color: var(--icon-color-disabled);
  background: transparent;
  cursor: default;
  opacity: 0.6;
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] .clickable-icon svg,
.workspace-leaf-content[data-type="systemsculpt-chat-view"] .clickable-icon .svg-icon {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  flex-shrink: 0;
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] .systemsculpt-chat-composer-button,
.workspace-leaf-content[data-type="systemsculpt-chat-view"] .systemsculpt-chat-composer-action,
.workspace-leaf-content[data-type="systemsculpt-chat-view"] .systemsculpt-attachment-pill-remove {
  border: 0;
  background: transparent;
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] .systemsculpt-attachment-pill-remove {
  color: var(--text-faint);
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] .systemsculpt-attachment-pill-remove:hover,
.workspace-leaf-content[data-type="systemsculpt-chat-view"] .systemsculpt-attachment-pill-remove:focus-visible {
  color: var(--text-normal);
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] input,
.workspace-leaf-content[data-type="systemsculpt-chat-view"] textarea {
  caret-color: transparent;
}

.workspace-leaf-content[data-type="systemsculpt-chat-view"] .ss-reveal-cursor {
  display: inline-block;
  margin-left: 1px;
  color: var(--text-accent);
  font-weight: 600;
}
`;

const workspaceStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  background: "var(--background-primary)",
};

const leafContentStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  background: "var(--background-primary)",
};

const viewHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minHeight: 48,
  padding: "6px 10px 8px",
  borderBottom: "1px solid color-mix(in srgb, var(--background-modifier-border) 80%, transparent)",
  background: "var(--background-primary)",
  color: "var(--text-normal)",
  boxSizing: "border-box",
};

const viewHeaderLeftStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 80,
};

const viewHeaderNavButtonsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const headerButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "var(--text-muted)",
  padding: 0,
};

const titleContainerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 0,
  flex: "1 1 auto",
};

const titleStyle: CSSProperties = {
  fontSize: "14px",
  lineHeight: "20px",
  fontWeight: 500,
  color: "var(--text-normal)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const viewActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 6,
  minWidth: 72,
};

const viewContentStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

const overlayMountStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
};

const modalViewportStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 28,
  background: "rgba(0, 0, 0, 0.38)",
  pointerEvents: "auto",
};

const modalShellStyle: CSSProperties = {
  width: "min(980px, 100%)",
  maxHeight: "100%",
  display: "flex",
  justifyContent: "center",
  alignItems: "stretch",
};

const DEFAULT_VIEW_TITLE = "Chat 3/6/2026 10:08:40 PM";

const DEFAULT_VIEW_CHROME: Required<ViewChromeSpec> = {
  title: DEFAULT_VIEW_TITLE,
  navIcons: ["chevron-left", "chevron-right"],
  actions: [
    {
      id: "bookmark",
      icon: "star",
      className: "view-action mod-bookmark",
      ariaLabel: "Bookmark this chat",
      title: "Bookmark this chat",
    },
    {
      id: "more",
      icon: "more-horizontal",
      className: "view-action",
      ariaLabel: "More chat actions",
      title: "More chat actions",
    },
  ],
  showDragOverlay: true,
  showScrollToBottom: false,
  chatFontSize: "medium",
};

type ContextFilterKey = "all" | "text" | "documents" | "images" | "audio";

const getViewChrome = (scene: SceneSpec): Required<ViewChromeSpec> => {
  const chrome = scene.viewChrome ?? {};
  return {
    title: chrome.title ?? DEFAULT_VIEW_CHROME.title,
    navIcons: chrome.navIcons ?? DEFAULT_VIEW_CHROME.navIcons,
    actions: chrome.actions ?? DEFAULT_VIEW_CHROME.actions,
    showDragOverlay: chrome.showDragOverlay ?? DEFAULT_VIEW_CHROME.showDragOverlay,
    showScrollToBottom:
      chrome.showScrollToBottom ?? DEFAULT_VIEW_CHROME.showScrollToBottom,
    chatFontSize: chrome.chatFontSize ?? DEFAULT_VIEW_CHROME.chatFontSize,
  };
};

const normalizeSurfaceIcon = (icon: SurfaceIconName): string => {
  switch (icon) {
    case "file":
    case "file-text":
    case "image":
    case "headphones":
    case "search":
    case "bot":
    case "bolt":
    case "sparkles":
    case "git-fork":
    case "clock":
    case "check":
    case "folder-search":
    case "bug":
    case "coins":
    case "chevron-left":
    case "chevron-right":
    case "star":
    case "star-off":
    case "more-horizontal":
    case "loader-2":
    case "x":
      return icon;
    default:
      return "file-text";
  }
};

const getActiveContextFilter = (
  filters: ContextModalSurfaceSpec["filters"]
): ContextFilterKey => {
  const activeFilterId = filters.find((filter) => filter.active)?.id?.toLowerCase() ?? "all";

  switch (activeFilterId) {
    case "text":
      return "text";
    case "docs":
    case "doc":
    case "document":
    case "documents":
      return "documents";
    case "image":
    case "images":
      return "images";
    case "audio":
      return "audio";
    default:
      return "all";
  }
};

const DEFAULT_STREAM_REVEAL = {
  mode: "stream" as const,
  startFrame: 18,
  durationInFrames: 84,
  lineDelayInFrames: 12,
  showCursor: true,
};

const appendRevealCursor = (target: HTMLElement, frame: number) => {
  const cursor = target.createSpan({ cls: "ss-reveal-cursor" });
  cursor.textContent = "|";
  cursor.style.opacity = Math.floor(frame / 8) % 2 === 0 ? "0.9" : "0.28";
};

const appendRevealText = (
  target: HTMLElement,
  text: string,
  showCursor: boolean,
  frame: number
) => {
  if (text) {
    target.appendChild(document.createTextNode(text));
  }
  if (showCursor) {
    appendRevealCursor(target, frame);
  }
};

const renderInlineBlock = (
  container: HTMLElement,
  block: InlineBlockSpec,
  frame: number,
  fps: number
) => {
  const reveal = block.reveal ?? (block.streaming ? DEFAULT_STREAM_REVEAL : undefined);
  const wrapper = createInlineBlock({
    type: block.kind,
    partId: block.id,
    isStreaming: block.streaming ?? false,
    title: block.title,
    icon: block.kind === "reasoning" ? "brain" : "wrench",
    statusText: block.status,
    statusState:
      block.statusTone === "pending"
        ? "executing"
        : block.statusTone === "success"
          ? "completed"
          : block.statusTone === "error"
            ? "failed"
            : undefined,
  });

  if (block.collapsed) {
    wrapper.classList.add("is-collapsed");
  }

  const content = getBlockContent(wrapper);
  if (content) {
    if (block.kind === "reasoning") {
      const body = content.createDiv({ cls: "systemsculpt-inline-reasoning-text" });
      const revealLines = resolveTextRevealLines(
        block.textLines,
        frame,
        fps,
        reveal
      );
      revealLines.forEach((line) => {
        const paragraph = body.createEl("p");
        appendRevealText(paragraph, line.text, line.showCursor, frame);
      });
    } else {
      const structured = content.createDiv({ cls: "systemsculpt-chat-structured-block" });
      const header = structured.createDiv({ cls: "systemsculpt-chat-structured-header" });
      const bullet = header.createSpan({
        cls:
          "systemsculpt-chat-structured-bullet" +
          (block.lines.some((line) => line.active) ? " is-active" : ""),
      });
      bullet.textContent = block.lines.some((line) => line.active) ? "" : ">";
      header.createSpan({ text: block.title });
      const lines = structured.createDiv({ cls: "systemsculpt-chat-structured-lines" });
      block.lines.forEach((line) => {
        const row = lines.createDiv({ cls: "systemsculpt-chat-structured-line" });
        row.createDiv({
          cls: "systemsculpt-chat-structured-line-prefix",
          text: line.prefix,
        });
        const text = row.createDiv({ cls: "systemsculpt-chat-structured-line-text" });
        text.createSpan({
          cls: "systemsculpt-chat-structured-label",
          text: line.label,
        });
        if (line.detail) {
          text.appendChild(document.createTextNode(" "));
          text.createSpan({
            cls: "systemsculpt-chat-structured-detail",
            text: line.detail,
          });
        }
      });
    }
  }

  container.appendChild(wrapper);
};

const renderMessage = (
  container: HTMLElement,
  message: ChatMessageSpec,
  frame: number,
  fps: number
) => {
  const messageEl = document.createElement("div");
  messageEl.className = `systemsculpt-message systemsculpt-${message.role}-message`;
  messageEl.dataset.messageId = message.id;
  messageEl.dataset.role = message.role;

  if (message.role === "assistant" && (message.inlineBlocks?.length ?? 0) > 0) {
    messageEl.classList.add("has-reasoning");
  }

  const contentEl = messageEl.createDiv({ cls: "systemsculpt-message-content" });
  let contentPart: HTMLElement | null = null;
  const ensureContentPart = () => {
    if (contentPart) {
      return contentPart;
    }

    contentPart = document.createElement("div");
    contentPart.className = "systemsculpt-unified-part systemsculpt-content-part";
    messageEl.insertBefore(contentPart, contentEl);
    return contentPart;
  };

  const paragraphLines = resolveTextRevealLines(
    message.paragraphs ?? [],
    frame,
    fps,
    message.reveal
  );
  paragraphLines.forEach((paragraph) => {
    const paragraphEl = ensureContentPart().createEl("p");
    appendRevealText(paragraphEl, paragraph.text, paragraph.showCursor, frame);
  });
  if ((message.bullets?.length ?? 0) > 0) {
    const bulletLines = resolveTextRevealLines(
      message.bullets ?? [],
      frame,
      fps,
      message.reveal
    );
    const list = ensureContentPart().createEl("ul");
    bulletLines.forEach((bullet) => {
      const item = list.createEl("li");
      appendRevealText(item, bullet.text, bullet.showCursor, frame);
    });
  }
  if (message.citations?.length) {
    renderCitationFooter(
      ensureContentPart(),
      message.citations.map((citation) => ({
        url: citation.url,
        title: citation.title,
        content: citation.snippet,
      }))
    );
  }

  message.inlineBlocks?.forEach((block) => {
    renderInlineBlock(messageEl, block, frame, fps);
  });

  appendMessageToGroupedContainer(container, messageEl, message.role, {
    breakGroup: message.role === "system",
  });
};

const createHeaderButton = (
  parent: HTMLElement,
  icon: string,
  options?: {
    className?: string;
    ariaLabel?: string;
    title?: string;
  }
) => {
  const button = parent.createEl("button", {
    cls: `clickable-icon${options?.className ? ` ${options.className}` : ""}`,
    attr: {
      type: "button",
    },
  });
  Object.assign(button.style, headerButtonStyle);
  if (options?.ariaLabel) {
    button.setAttr("aria-label", options.ariaLabel);
  }
  if (options?.title) {
    button.setAttr("title", options.title);
  }
  setIcon(button, icon);
  const svg = button.querySelector("svg");
  if (svg) {
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.style.width = "16px";
    svg.style.height = "16px";
    svg.style.opacity = "0.92";
  }
  return button;
};

const mountViewHeader = (root: HTMLElement, chrome: Required<ViewChromeSpec>) => {
  root.empty();
  Object.assign(root.style, viewHeaderStyle);

  const left = root.createDiv({ cls: "view-header-left" });
  Object.assign(left.style, viewHeaderLeftStyle);

  const nav = left.createDiv({ cls: "view-header-nav-buttons" });
  Object.assign(nav.style, viewHeaderNavButtonsStyle);
  chrome.navIcons.forEach((icon) => {
    createHeaderButton(nav, normalizeSurfaceIcon(icon), {
      ariaLabel: icon === "chevron-left" ? "Go back" : "Go forward",
      title: icon === "chevron-left" ? "Back" : "Forward",
    });
  });

  const titleContainer = root.createDiv({
    cls: "view-header-title-container mod-at-start mod-fade mod-at-end",
  });
  Object.assign(titleContainer.style, titleContainerStyle);
  titleContainer.createDiv({ cls: "view-header-title-parent" });
  const titleEl = titleContainer.createDiv({
    cls: "view-header-title",
    text: chrome.title,
  });
  Object.assign(titleEl.style, titleStyle);

  const actions = root.createDiv({ cls: "view-actions" });
  Object.assign(actions.style, viewActionsStyle);
  chrome.actions.forEach((action) => {
    createHeaderButton(actions, normalizeSurfaceIcon(action.icon), {
      className: action.className,
      ariaLabel: action.ariaLabel,
      title: action.title,
    });
  });
};

const applyContextModalLayout = (modalEl: HTMLDivElement, titleEl: HTMLDivElement, contentEl: HTMLDivElement) => {
  Object.assign(modalEl.style, {
    width: "100%",
    height: "min(720px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "20px",
    background: "var(--background-secondary)",
    borderRadius: "12px",
    border: "1px solid color-mix(in srgb, var(--background-modifier-border) 88%, transparent)",
    boxShadow: "0 20px 48px rgba(0, 0, 0, 0.32)",
    overflow: "hidden",
  } as CSSStyleDeclaration);

  Object.assign(titleEl.style, {
    fontSize: "26px",
    fontWeight: "700",
    letterSpacing: "-0.03em",
    color: "var(--text-normal)",
  } as CSSStyleDeclaration);

  Object.assign(contentEl.style, {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    flex: "1",
    minHeight: "0",
  } as CSSStyleDeclaration);

  modalEl.querySelectorAll<HTMLElement>(".setting-item").forEach((el) => {
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.gap = "12px";
  });
  modalEl.querySelectorAll<HTMLElement>(".setting-item-name").forEach((el) => {
    el.style.minWidth = "92px";
    el.style.fontSize = "13px";
    el.style.fontWeight = "600";
    el.style.color = "var(--text-muted)";
  });
  modalEl.querySelectorAll<HTMLElement>(".setting-item-control").forEach((el) => {
    el.style.display = "flex";
    el.style.flex = "1";
    el.style.alignItems = "center";
    el.style.gap = "8px";
  });
  modalEl
    .querySelectorAll<HTMLInputElement>(".setting-item-control input")
    .forEach((el) => {
      el.style.width = "100%";
      el.style.height = "38px";
      el.style.border = "1px solid var(--background-modifier-border)";
      el.style.borderRadius = "10px";
      el.style.padding = "0 12px";
      el.style.background = "var(--background-primary)";
      el.style.color = "var(--text-normal)";
    });
};

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
      titleOverride: credits?.label ? `Credits balance: ${credits.label}` : undefined,
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

const mountComposer = (
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
};

const mountContextModal = (
  overlayRoot: HTMLElement,
  surface: ContextModalSurfaceSpec,
  frame: number,
  fps: number
) => {
  overlayRoot.empty();

  const overlay = overlayRoot.createDiv();
  Object.assign(overlay.style, modalViewportStyle);

  const shell = overlay.createDiv();
  Object.assign(shell.style, modalShellStyle);

  const files = surface.rows.map((row) => new TFile(row.path));
  const attachedPaths = new Set(
    surface.rows.filter((row) => row.state === "attached").map((row) => row.path)
  );
  const selectedPaths = new Set(
    surface.rows.filter((row) => row.state === "selected").map((row) => row.path)
  );
  const searchResult = resolveTextReveal(
    surface.searchValue,
    frame,
    fps,
    surface.searchReveal
  );
  const app = {
    vault: {
      getFiles: () => files,
    },
  };

  const modal = new ContextSelectionModal(
    app as any,
    () => {},
    {} as any,
    {
      isFileAlreadyInContext: (file: TFile) => attachedPaths.has(file.path),
      initialFilter: getActiveContextFilter(surface.filters),
      initialSearchQuery: searchResult.text,
      initialSelectedPaths: Array.from(selectedPaths),
      autoFocusSearch: false,
    }
  );

  modal.onOpen();

  applyContextModalLayout(modal.modalEl, modal.titleEl, modal.contentEl);
  shell.appendChild(modal.modalEl);
};

const mountDragOverlay = (root: HTMLElement) => {
  const dragOverlay = root.createDiv({ cls: "systemsculpt-drag-overlay" });
  dragOverlay.createDiv({
    cls: "systemsculpt-drag-message",
    text: "Drop files, folders, or search results to add to context",
  });
  dragOverlay.createDiv({ cls: "systemsculpt-drag-detail" });
};

const mountScrollChrome = (root: HTMLElement, showButton = false) => {
  const button = root.createEl("button", {
    cls: "systemsculpt-scroll-to-bottom",
    attr: {
      type: "button",
      "aria-label": "Scroll to bottom",
    },
  });
  if (!showButton) {
    button.style.display = "none";
  }
  button.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 3v10m0 0l-4-4m4 4l4-4"/>
    </svg>
  `;
  root.createDiv({ cls: "systemsculpt-visually-hidden" });
};

const mountChatStatus = (
  root: HTMLElement,
  surface: ChatStatusSurfaceSpec,
  chrome: Required<ViewChromeSpec>,
  frame: number,
  fps: number
) => {
  root.empty();
  if (chrome.showDragOverlay) {
    mountDragOverlay(root);
  }

  const messages = root.createDiv({
    cls: `systemsculpt-messages-container systemsculpt-chat-${chrome.chatFontSize}`,
  });
  const status = messages.createDiv({ cls: "systemsculpt-chat-status no-animate" });
  renderChatStatusSurface(status, {
    eyebrow: surface.eyebrow,
    title: surface.title,
    description: surface.description,
    chips: surface.chips.map((chip) => ({
      label: chip.label,
      value: chip.value,
      icon: chip.icon,
    })),
    actions: surface.actions.map((action) => ({
      label: action.label,
      icon: action.icon,
      primary: action.primary,
    })),
    note: surface.note,
  });
  messages.createDiv({ cls: "systemsculpt-scroll-sentinel" });
  mountScrollChrome(root, chrome.showScrollToBottom);

  mountComposer(
    root,
    surface.toolbarChips,
    surface.attachments,
    surface.draft,
    "none",
    false,
    frame,
    fps
  );
};

const mountChatThread = (
  root: HTMLElement,
  surface: ChatThreadSurfaceSpec,
  chrome: Required<ViewChromeSpec>,
  frame: number,
  fps: number
) => {
  root.empty();
  if (chrome.showDragOverlay) {
    mountDragOverlay(root);
  }

  const messages = root.createDiv({
    cls: `systemsculpt-messages-container systemsculpt-chat-${chrome.chatFontSize}`,
  });
  surface.messages.forEach((message) => {
    renderMessage(messages, message, frame, fps);
  });
  messages.createDiv({ cls: "systemsculpt-scroll-sentinel" });
  mountScrollChrome(root, chrome.showScrollToBottom);

  mountComposer(
    root,
    surface.toolbarChips,
    surface.attachments,
    surface.draft,
    surface.recording ?? "none",
    surface.stopVisible ?? false,
    frame,
    fps
  );
};

export const SystemSculptSurface: React.FC<{
  scene: SceneSpec;
}> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chrome = getViewChrome(scene);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const content = contentRef.current;
    const overlay = overlayRef.current;
    if (!header || !content || !overlay) {
      return;
    }

    mountViewHeader(header, chrome);
    overlay.remove();
    content.empty();
    overlay.empty();

    switch (scene.surface.kind) {
      case "context-modal":
        mountContextModal(overlay, scene.surface, frame, fps);
        break;
      case "chat-status":
        mountChatStatus(content, scene.surface, chrome, frame, fps);
        break;
      case "chat-thread":
        mountChatThread(content, scene.surface, chrome, frame, fps);
        break;
    }

    content.appendChild(overlay);
  }, [chrome, fps, frame, scene.surface]);

  return (
    <div style={{ ...obsidianThemeStyle, width: "100%", height: "100%" }}>
      <style>{hostControlCss}</style>
      <div style={workspaceStyle}>
        <div className="workspace-split mod-root" style={{ width: "100%", height: "100%" }}>
          <div className="workspace-leaf mod-active" style={{ width: "100%", height: "100%" }}>
            <div
              className="workspace-leaf-content"
              data-type="systemsculpt-chat-view"
              style={leafContentStyle}
            >
              <div ref={headerRef} className="view-header" />
              <div
                ref={contentRef}
                className="view-content systemsculpt-chat-container systemsculpt-reduced-motion"
                style={viewContentStyle}
              >
                <div ref={overlayRef} style={overlayMountStyle} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
