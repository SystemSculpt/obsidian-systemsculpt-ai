import type { CSSProperties } from "react";
import { setIcon } from "../../shims/obsidian";
import type { SceneSpec, SurfaceIconName, ViewChromeSpec } from "../../lib/storyboard";

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

export const getViewChrome = (scene: SceneSpec): Required<ViewChromeSpec> => {
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

export const normalizeSurfaceIcon = (icon: SurfaceIconName): string => {
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
    case "history":
    case "settings":
    case "network":
    case "trophy":
    case "refresh-ccw":
    case "clipboard":
    case "external-link":
    case "play":
    case "list":
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

export const mountViewHeader = (root: HTMLElement, chrome: Required<ViewChromeSpec>) => {
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
