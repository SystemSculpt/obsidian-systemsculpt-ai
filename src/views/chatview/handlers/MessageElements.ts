import { ChatRole } from "../../../types";
import { setIcon } from "obsidian";
import { appendMessageToGroupedContainer } from "../utils/MessageGrouping";
import { StreamingIndicator } from "../ui/StreamingIndicator";
import type { StreamingMetrics } from "../StreamingMetricsTracker";

export function addMessageToContainer(chatContainer: HTMLElement, messageEl: HTMLElement, role: ChatRole, breakGroup: boolean = false): { isNewGroup: boolean; groupContainer?: HTMLElement } {
  messageEl.dataset.role = role;
  const { groupEl, isNewGroup } = appendMessageToGroupedContainer(chatContainer, messageEl, role, { breakGroup });
  try {
    messageEl.dispatchEvent(new CustomEvent('systemsculpt-dom-content-changed', { bubbles: true }));
  } catch {}
  return { isNewGroup, groupContainer: groupEl };
}

export function createAssistantMessageContainer(chatContainer: HTMLElement, generateMessageId: () => string, chatView: any, breakGroup: boolean = false): { messageEl: HTMLElement; contentEl: HTMLElement } {
  const messageEl = createDiv({ cls: "systemsculpt-message systemsculpt-assistant-message" });
  messageEl.setAttribute("data-message-id", generateMessageId());
  messageEl.dataset.role = "assistant";

  const contentEl = createDiv({ cls: "systemsculpt-message-content" });
  messageEl.appendChild(contentEl);

  // Do NOT create a streaming status indicator by default.
  // It will be created on-demand when streaming actually starts.

  addMessageToContainer(chatContainer, messageEl, 'assistant', breakGroup);

  // Ensure the new assistant container is scrolled into view when anchored
  try {
    messageEl.dispatchEvent(new CustomEvent('systemsculpt-dom-content-changed', { bubbles: true }));
  } catch {}
  return { messageEl, contentEl };
}

// WeakMap to store StreamingIndicator instances per message element
const indicatorInstances = new WeakMap<HTMLElement, StreamingIndicator>();

export function getStatusIndicator(messageEl: HTMLElement): HTMLElement | null {
  const indicator = indicatorInstances.get(messageEl);
  return indicator?.element ?? null;
}

export function updateStreamingStatus(
  messageEl: HTMLElement,
  liveRegionEl: HTMLElement | null,
  status: string,
  text: string,
  metrics?: StreamingMetrics
): void {
  const indicator = indicatorInstances.get(messageEl);
  if (indicator) {
    const label = text || (status === "reasoning" ? "Thinking\u2026" : status === "tool_calls" ? "Using tools\u2026" : "Writing\u2026");
    indicator.update(status, label, metrics);
    if (liveRegionEl) {
      liveRegionEl.textContent = label;
    }
  }
}

export function hideStreamingStatus(messageEl: HTMLElement, liveRegionEl: HTMLElement | null): void {
  const indicator = indicatorInstances.get(messageEl);
  if (indicator) {
    indicator.hide(() => {
      indicator.destroy();
      indicatorInstances.delete(messageEl);
    });
  }
  if (liveRegionEl) {
    liveRegionEl.textContent = "";
  }
}

export function showStreamingStatus(messageEl: HTMLElement, liveRegionEl: HTMLElement | null): void {
  let indicator = indicatorInstances.get(messageEl);
  if (!indicator) {
    indicator = new StreamingIndicator();
    indicatorInstances.set(messageEl, indicator);
    messageEl.appendChild(indicator.element);
  }
  indicator.show();
  if (liveRegionEl) {
    liveRegionEl.textContent = "Preparing\u2026";
  }
}

export function setStreamingFootnote(messageEl: HTMLElement, text: string): void {
  let footnoteEl = messageEl.querySelector('.systemsculpt-streaming-footnote') as HTMLElement | null;
  if (!footnoteEl) {
    footnoteEl = messageEl.createEl('div', { cls: 'systemsculpt-streaming-footnote' });
  }

  const lower = (text || "").toLowerCase();
  let shortLabel = "Info";
  if (lower.includes("doesn't support tool calling") || lower.includes("without access to vault") || lower.includes("without tools")) {
    shortLabel = "Tools unavailable";
  } else if (lower.includes("does not support tool") || (lower.includes("retry") && lower.includes("tool"))) {
    shortLabel = "Tools unavailable";
  } else if (lower.includes("doesn't support image") || lower.includes("without the image context")) {
    shortLabel = "Images unavailable";
  } else if (lower.includes("does not support images") || lower.includes("image was not sent")) {
    shortLabel = "Images unavailable";
  }

  footnoteEl.empty();

  const iconEl = footnoteEl.createSpan({ cls: 'ss-footnote-icon' });
  setIcon(iconEl, 'info');
  iconEl.setAttr('aria-label', text || 'More information');
  iconEl.setAttr('title', text || 'More information');
  iconEl.setAttr('role', 'img');
  iconEl.setAttr('tabindex', '0');

  const tipId = `ss-footnote-tip-${Math.random().toString(36).slice(2, 8)}`;
  iconEl.setAttr('aria-describedby', tipId);
  const tooltipEl = iconEl.createSpan({ cls: 'ss-footnote-tooltip', text: text || '' });
  tooltipEl.setAttr('id', tipId);
  tooltipEl.setAttr('role', 'tooltip');

  footnoteEl.createSpan({ cls: 'ss-footnote-text', text: shortLabel });

  const statusIndicator = messageEl.querySelector('.systemsculpt-streaming-status') as HTMLElement | null;
  if (statusIndicator && footnoteEl.previousElementSibling !== statusIndicator) {
    statusIndicator.insertAdjacentElement('afterend', footnoteEl);
  }
}

export function clearStreamingFootnote(messageEl: HTMLElement): void {
  const footnoteEl = messageEl.querySelector('.systemsculpt-streaming-footnote') as HTMLElement | null;
  if (footnoteEl) {
    footnoteEl.remove();
  }
}
