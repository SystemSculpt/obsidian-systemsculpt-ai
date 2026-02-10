/**
 * InlineCollapsibleBlock - Utility for creating inline collapsible blocks
 *
 * Used for rendering reasoning and tool call blocks inline within the message
 * flow in chronological order. Each block is individually collapsible.
 */

import { setIcon } from "obsidian";

export type InlineBlockType = "reasoning" | "tool_call";

export interface InlineBlockOptions {
  type: InlineBlockType;
  partId: string;
  isStreaming: boolean;
  title: string;
  icon?: string;
  statusText?: string;
  statusState?: string;
}

const DEFAULT_ICONS: Record<InlineBlockType, string> = {
  reasoning: "brain",
  tool_call: "wrench",
};

/**
 * Creates an inline collapsible block element.
 */
export function createInlineBlock(options: InlineBlockOptions): HTMLElement {
  const { type, partId, isStreaming, title, icon, statusText, statusState } = options;

  const wrapper = document.createElement("div");
  wrapper.className = `systemsculpt-inline-collapsible systemsculpt-inline-${type}`;
  wrapper.dataset.partId = partId;
  wrapper.dataset.blockType = type;

  if (isStreaming) {
    wrapper.classList.add("is-streaming");
  }

  // Header (always visible, clickable to toggle)
  const header = wrapper.createDiv({ cls: "systemsculpt-inline-collapsible-header" });

  // Icon
  const iconEl = header.createDiv({ cls: "systemsculpt-inline-collapsible-icon" });
  setIcon(iconEl, icon ?? DEFAULT_ICONS[type]);

  // Title
  const titleEl = header.createDiv({ cls: "systemsculpt-inline-collapsible-title" });
  titleEl.textContent = title;

  // Optional status chip
  if (statusText) {
    const statusEl = header.createDiv({ cls: "systemsculpt-inline-collapsible-status" });
    statusEl.textContent = statusText;
    applyStatusStateClass(statusEl, statusState);
  }

  // Chevron
  const chevronEl = header.createDiv({ cls: "systemsculpt-inline-collapsible-chevron" });
  setIcon(chevronEl, "chevron-down");

  // Content container
  const content = wrapper.createDiv({ cls: "systemsculpt-inline-collapsible-content" });

  // Click handler for toggle
  header.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCollapsed = wrapper.classList.contains("is-collapsed");
    setExpanded(wrapper, isCollapsed);
    // Mark as user-expanded to prevent auto-collapse
    if (isCollapsed) {
      wrapper.dataset.userExpanded = "true";
    }
  });

  return wrapper;
}

/**
 * Gets the content container within an inline block.
 */
export function getBlockContent(block: HTMLElement): HTMLElement | null {
  return block.querySelector(".systemsculpt-inline-collapsible-content");
}

/**
 * Sets the expanded/collapsed state of an inline block.
 */
export function setExpanded(block: HTMLElement, expanded: boolean): void {
  if (expanded) {
    block.classList.remove("is-collapsed");
  } else {
    block.classList.add("is-collapsed");
  }
}

/**
 * Checks if an inline block is expanded.
 */
export function isExpanded(block: HTMLElement): boolean {
  return !block.classList.contains("is-collapsed");
}

/**
 * Sets the streaming state of an inline block.
 */
export function setStreaming(block: HTMLElement, streaming: boolean): void {
  if (streaming) {
    block.classList.add("is-streaming");
  } else {
    block.classList.remove("is-streaming");
  }
}

/**
 * Updates the title of an inline block.
 */
export function setTitle(block: HTMLElement, title: string): void {
  const titleEl = block.querySelector(".systemsculpt-inline-collapsible-title");
  if (titleEl) {
    titleEl.textContent = title;
  }
}

/**
 * Updates the status chip text of an inline block.
 */
export function setStatus(block: HTMLElement, statusText?: string, statusState?: string): void {
  let statusEl = block.querySelector(".systemsculpt-inline-collapsible-status") as HTMLElement | null;
  if (!statusText) {
    statusEl?.remove();
    return;
  }

  if (!statusEl) {
    const header = block.querySelector(".systemsculpt-inline-collapsible-header") as HTMLElement | null;
    const chevron = block.querySelector(".systemsculpt-inline-collapsible-chevron");
    if (!header) return;
    statusEl = document.createElement("div");
    statusEl.className = "systemsculpt-inline-collapsible-status";
    if (chevron) {
      header.insertBefore(statusEl, chevron);
    } else {
      header.appendChild(statusEl);
    }
  }
  statusEl.textContent = statusText;
  applyStatusStateClass(statusEl, statusState);
}

function applyStatusStateClass(statusEl: HTMLElement, statusState?: string): void {
  statusEl.classList.remove("is-pending", "is-success", "is-error");
  switch (statusState) {
    case "executing":
      statusEl.classList.add("is-pending");
      break;
    case "completed":
      statusEl.classList.add("is-success");
      break;
    case "failed":
      statusEl.classList.add("is-error");
      break;
    default:
      break;
  }
}

/**
 * Checks if the user manually expanded this block (prevents auto-collapse).
 */
export function isUserExpanded(block: HTMLElement): boolean {
  return block.dataset.userExpanded === "true";
}

/**
 * Clears the user-expanded flag.
 */
export function clearUserExpanded(block: HTMLElement): void {
  delete block.dataset.userExpanded;
}
