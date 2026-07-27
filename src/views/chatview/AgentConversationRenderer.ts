import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import {
  createSurfaceElement,
  createUiAction,
  getSurfaceOwnerWindow,
  updateUiAction,
} from "../../core/ui/surface";
import type { ChatMessage, MessagePart } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { collectSuccessfulToolArtifactPaths, collectToolArtifactPaths } from "../../utils/toolArtifacts";
import {
  renderOperationsInlinePreview,
  renderWriteEditInlineDiff,
} from "../../utils/toolCallPreview";
import type {
  AgentArtifact,
  AgentConversationSnapshot,
  AgentPart,
  AgentToolPart,
} from "./AgentConversation";
import type { AgentConversationPresentation } from "./AgentConversationPresentation";
import {
  groupConsecutiveToolActivity,
  presentAgentToolGroup,
} from "./AgentToolPresentation";
import {
  presentChatMessage,
  presentMessageContent,
  type PresentedMessageAttachment,
  type PresentedMessageContent,
} from "./ChatMessagePresentation";

export type AgentConversationRendererOptions = Readonly<{
  app: App;
  sourcePath: () => string;
  labelledBy?: string;
  onApprove: (approvalId: string, approved: boolean, rememberForChat?: boolean) => void | Promise<void>;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  onCopyArtifactPath: (artifact: AgentArtifact) => void | Promise<void>;
  onRetryMessage?: (messageId: string) => void | Promise<void>;
  onResubmitMessage?: (messageId: string, text: string) => boolean | Promise<boolean>;
  onCancelMessageEdit?: (messageId: string) => void | Promise<void>;
  onCopyText?: (text: string) => boolean | Promise<boolean>;
}>;

export type AgentInlineMessageEdit = Readonly<{
  messageId: string;
  text: string;
  laterMessageCount: number;
  hasAttachments: boolean;
  unavailableAttachmentCount: number;
  requiresReplayConfirmation: boolean;
}>;

function button(parent: HTMLElement, label: string, icon?: string): HTMLButtonElement {
  const element = createUiAction(parent, {
    label,
    icon,
    size: icon ? "icon" : "small",
    tooltip: false,
  });
  element.addClass("systemsculpt-agent-inline-button");
  return element;
}

const ACTIONABLE_ARTIFACT_TOOLS = new Set(["write", "edit", "multi_edit", "move"]);

type HistoricalTurnSemantics = Readonly<{
  hasVisibleContent: boolean;
  hasTools: boolean;
  isToolOnly: boolean;
  copyText: string;
}>;

function classifyHistoricalTurn(
  message: ChatMessage,
  aggregateContent: PresentedMessageContent,
  orderedParts: readonly MessagePart[],
): HistoricalTurnSemantics {
  const usesOrderedParts = orderedParts.length > 0;
  const presentedContent = usesOrderedParts
    ? orderedParts
      .filter((part) => part.type === "content")
      .map((part) => presentMessageContent(part.data))
    : [aggregateContent];
  const copyText = presentedContent
    .map((content) => content.markdown)
    .filter((markdown) => markdown.trim().length > 0)
    .join("\n\n");
  const hasVisibleContent = copyText.length > 0
    || presentedContent.some((content) => content.attachments.length > 0)
    || orderedParts.some((part) => part.type === "reasoning" && part.data.trim().length > 0);
  const hasTools = message.role === "assistant"
    && orderedParts.some((part) => part.type === "tool_call");
  const isToolOnly = hasTools && !hasVisibleContent;
  return { hasVisibleContent, hasTools, isToolOnly, copyText };
}

function toolCallForPart(part: AgentToolPart): ToolCall {
  return {
    id: part.callId,
    messageId: part.messageId,
    request: {
      id: part.callId,
      type: "function",
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      },
    },
    state: "executing",
    timestamp: Date.now(),
  };
}

function artifactPaths(tool: ToolCall, success: boolean): string[] {
  try {
    const input = JSON.parse(tool.request.function.arguments || "{}") as Record<string, unknown>;
    return success
      ? collectToolArtifactPaths(tool.request.function.name, input, tool.result?.data)
      : collectSuccessfulToolArtifactPaths(tool.request.function.name, tool.result?.data);
  } catch {
    // Malformed input is already represented by the durable failed tool state.
    return [];
  }
}

function historicalToolState(tool: ToolCall, success: boolean): AgentToolPart["state"] {
  if (success) return "succeeded";

  switch (tool.result?.error?.code) {
    case "USER_DENIED":
      return "denied";
    case "TOOL_CANCELLED_BEFORE_START":
      return "cancelled";
    case "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN":
    case "TOOL_OUTCOME_UNKNOWN":
    case "TOOL_OUTCOME_UNKNOWN_AFTER_RESTART":
      return "outcome-unknown";
    default:
      return tool.state === "failed" || tool.result?.success === false ? "failed" : "running";
  }
}

/** Projects durable messages plus the active normalized agent run into native DOM. */
export class AgentConversationRenderer extends Component {
  public readonly element: HTMLElement;
  private readonly historyRoot: HTMLElement;
  private readonly activeRoot: HTMLElement;
  private readonly activeNodes = new Map<string, HTMLElement>();
  private readonly activePartRefs = new Map<string, AgentPart>();
  private readonly activeToolGroupRefs = new Map<string, readonly AgentToolPart[]>();
  private readonly activeActivityNodes = new Map<string, HTMLElement>();
  private inlineMessageEdit: AgentInlineMessageEdit | null = null;
  private activeTurn: HTMLElement | null = null;
  private activeBody: HTMLElement | null = null;
  private activeTurnId: string | null = null;
  private suppressedEditorKeyup: "Escape" | "Enter" | null = null;
  private suppressedEditorKeyupAction: (() => void) | null = null;
  private suppressedEditorKeyupTimer: number | null = null;
  private inlineEditorShortcutCleanup: (() => void) | null = null;
  private readonly copyFeedbackTimers = new Map<HTMLButtonElement, number>();
  private renderGeneration = 0;

  constructor(parent: HTMLElement, private readonly options: AgentConversationRendererOptions) {
    super();
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-conversation",
      attr: {
        role: "log",
        ...(options.labelledBy
          ? { "aria-labelledby": options.labelledBy }
          : { "aria-label": "Messages" }),
        "aria-live": "polite",
        "aria-relevant": "additions",
        "aria-atomic": "false",
      },
    });
    this.historyRoot = this.element.createDiv({ cls: "systemsculpt-agent-history" });
    this.activeRoot = this.element.createDiv({ cls: "systemsculpt-agent-active-run" });
    const containEditorKeyup = (event: KeyboardEvent): void => {
      this.containSuppressedEditorKeyup(event);
    };
    this.element.addEventListener("keyup", containEditorKeyup, true);
    this.register(() => this.element.removeEventListener("keyup", containEditorKeyup, true));
  }

  public async renderHistory(messages: readonly ChatMessage[]): Promise<void> {
    const generation = ++this.renderGeneration;
    this.clearInlineEditorShortcutGuard();
    if (
      this.inlineMessageEdit
      && !messages.some((message) =>
        message.role === "user" && message.message_id === this.inlineMessageEdit?.messageId)
    ) {
      this.inlineMessageEdit = null;
    }
    const nextHistory = createSurfaceElement(this.historyRoot.ownerDocument, "div");
    for (let index = 0; index < messages.length;) {
      if (generation !== this.renderGeneration) return;
      const message = messages[index];
      index += 1;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const turnMessages: ChatMessage[] = [message];
      if (message.role === "assistant") {
        while (index < messages.length && messages[index].role === "assistant") {
          turnMessages.push(messages[index]);
          index += 1;
        }
      }

      const presented = turnMessages.map((entry) => {
        const content = presentChatMessage(entry);
        const orderedParts = entry.role === "assistant" ? this.orderedDurableParts(entry) : [];
        return {
          message: entry,
          content,
          orderedParts,
          semantics: classifyHistoricalTurn(entry, content, orderedParts),
        };
      });
      const hasVisibleContent = presented.some((entry) => entry.semantics.hasVisibleContent);
      const hasTools = presented.some((entry) => entry.semantics.hasTools);
      const copyText = presented
        .map((entry) => entry.semantics.copyText)
        .filter(Boolean)
        .join("\n\n");
      const semantics: HistoricalTurnSemantics = {
        hasVisibleContent,
        hasTools,
        isToolOnly: hasTools && !hasVisibleContent,
        copyText,
      };
      if (!semantics.hasVisibleContent && !semantics.hasTools) continue;
      const anchorMessage = turnMessages[0];
      const inlineEdit = message.role === "user"
        && this.inlineMessageEdit?.messageId === anchorMessage.message_id
        ? this.inlineMessageEdit
        : null;
      const row = nextHistory.createDiv({
        cls: [
          "systemsculpt-agent-turn",
          `is-${message.role}`,
          semantics.isToolOnly ? "is-tool-only" : "",
          inlineEdit ? "is-editing" : "",
        ].filter(Boolean).join(" "),
        attr: {
          "data-message-id": anchorMessage.message_id,
          ...(turnMessages.length > 1
            ? { "data-message-ids": turnMessages.map((entry) => entry.message_id).join(" ") }
            : {}),
          ...(message.role === "assistant" ? { "aria-label": "SystemSculpt response" } : {}),
        },
      });
      const body = row.createDiv({ cls: "systemsculpt-agent-turn-body" });
      if (message.role === "assistant") {
        const turnParts = presented.flatMap((entry, entryIndex): MessagePart[] => {
          if (entry.orderedParts.length > 0) return entry.orderedParts;
          return [{
            id: `${entry.message.message_id}:content`,
            type: "content",
            timestamp: entryIndex,
            data: entry.message.content ?? "",
          }];
        });
        await this.renderHistoricalParts(body, turnParts);
      } else {
        const { content } = presented[0];
        if (inlineEdit) {
          this.renderInlineMessageEditor(body, inlineEdit);
        } else if (content.markdown.trim()) {
          await this.renderMarkdown(content.markdown, body);
        }
        if (content.attachments.length > 0) this.renderMessageAttachments(body, content.attachments);
      }
      if (!semantics.isToolOnly && !inlineEdit) {
        this.renderMessageActions(
          row,
          turnMessages[turnMessages.length - 1],
          semantics.copyText,
        );
      }
    }
    if (generation !== this.renderGeneration) return;
    this.historyRoot.replaceChildren(...Array.from(nextHistory.childNodes));
  }

  public setInlineMessageEdit(edit: AgentInlineMessageEdit | null): void {
    this.inlineMessageEdit = edit;
  }

  public focusInlineMessageEdit(): void {
    const input = this.historyRoot.querySelector<HTMLTextAreaElement>(
      ".systemsculpt-agent-message-editor-input",
    );
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  public focusMessageEditAction(messageId: string): void {
    const row = Array.from(
      this.historyRoot.querySelectorAll<HTMLElement>(".systemsculpt-agent-turn[data-message-id]"),
    ).find((candidate) => candidate.dataset.messageId === messageId);
    row?.querySelector<HTMLButtonElement>('[data-focus-key="edit-message"]')?.focus();
  }

  /** Durable message parts are the chronology source for managed chats. */
  private orderedDurableParts(message: ChatMessage): MessagePart[] {
    if (!message.messageParts?.length) return [];
    return message.messageParts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => ["reasoning", "content", "tool_call"].includes(part.type))
      .sort((left, right) => left.part.timestamp - right.part.timestamp || left.index - right.index)
      .map(({ part }) => part);
  }

  private async renderHistoricalPart(parent: HTMLElement, part: MessagePart): Promise<void> {
    if (part.type === "reasoning") {
      if (!part.data.trim()) return;
      const node = parent.createDiv({ cls: "systemsculpt-agent-part is-reasoning" });
      await this.renderReasoning(node, part.data, false);
      return;
    }
    if (part.type === "tool_call") {
      await this.renderHistoricalTool(parent, part.data);
      return;
    }
    if (part.type !== "content") return;
    const content = presentMessageContent(part.data);
    if (content.markdown.trim()) {
      const node = parent.createDiv({ cls: "systemsculpt-agent-part is-text" });
      await this.renderMarkdown(content.markdown, node);
    }
    if (content.attachments.length > 0) this.renderMessageAttachments(parent, content.attachments);
  }

  private async renderHistoricalParts(parent: HTMLElement, parts: readonly MessagePart[]): Promise<void> {
    const timelineEntries = groupConsecutiveToolActivity(
      parts,
      (part) => part.type === "tool_call" ? this.historicalToolPart(part.data) : null,
    );
    const activityEntries = timelineEntries.filter((entry) =>
      entry.kind === "tools"
      || (entry.item.type === "reasoning"));
    let renderedActivity = false;

    for (const part of parts) {
      if (part.type === "reasoning" || part.type === "tool_call") {
        if (renderedActivity) continue;
        const activity = this.createActivity(parent, "Done");
        for (const entry of activityEntries) {
          if (entry.kind === "item") {
            await this.renderHistoricalPart(activity.body, entry.item);
            continue;
          }
          const node = activity.body.createDiv({ cls: "systemsculpt-agent-part is-tool" });
          await this.renderTool(node, entry.tools);
        }
        renderedActivity = true;
        continue;
      }
      await this.renderHistoricalPart(parent, part);
    }
  }

  public async renderActive(
    snapshot: AgentConversationSnapshot,
    presentation: AgentConversationPresentation,
  ): Promise<void> {
    this.element.setAttribute("aria-busy", String(presentation.busy));
    const body = this.ensureActiveTurn(snapshot.turnId);
    const wantedParts = new Set<string>();
    const wantedActivities = new Set<string>();
    const orderedParts = [...presentation.visibleParts];
    const lanes: Array<Readonly<{ key: string; node: HTMLElement }>> = [];

    const timelineEntries = groupConsecutiveToolActivity(
      orderedParts,
      (part) => part.kind === "tool" ? part : null,
      presentation.phase === "completed",
    );
    const activityEntries = timelineEntries.filter((entry) =>
      entry.kind === "tools" || entry.item.kind === "reasoning");
    let renderedActivity = false;

    for (const part of orderedParts) {
      if (part.kind !== "reasoning" && part.kind !== "tool") {
        const key = `${part.kind}:${part.id}`;
        const node = await this.renderActivePart(part, key);
        wantedParts.add(key);
        lanes.push({ key, node });
        continue;
      }

      if (renderedActivity) continue;
      const activityKey = `activity:${snapshot.turnId ?? "active"}`;
      wantedActivities.add(activityKey);
      const activity = this.ensureActivity(activityKey, presentation);
      const activityBody = activity.querySelector<HTMLElement>(".systemsculpt-agent-activity-body")!;
      const activityNodes: HTMLElement[] = [];
      for (const entry of activityEntries) {
        if (entry.kind === "item") {
          const key = `${entry.item.kind}:${entry.item.id}`;
          wantedParts.add(key);
          activityNodes.push(await this.renderActivePart(entry.item, key));
          continue;
        }
        const first = entry.tools[0];
        const key = `tool:${first.id}`;
        wantedParts.add(key);
        activityNodes.push(await this.renderActiveToolGroup(entry.tools, key));
      }
      this.reconcileChildren(activityBody, activityNodes);
      lanes.push({ key: activityKey, node: activity });
      renderedActivity = true;
    }

    this.reconcileChildren(body, lanes.map((lane) => lane.node));
    for (const [key, node] of this.activeActivityNodes) {
      if (!wantedActivities.has(key)) {
        node.remove();
        this.activeActivityNodes.delete(key);
      }
    }
    for (const [key, node] of this.activeNodes) {
      if (!wantedParts.has(key)) {
        node.remove();
        this.activeNodes.delete(key);
        this.activePartRefs.delete(key);
        this.activeToolGroupRefs.delete(key);
      }
    }
  }

  private async renderActivePart(part: AgentPart, key: string): Promise<HTMLElement> {
    let node = this.activeNodes.get(key);
    if (!node) {
      node = createSurfaceElement(this.activeRoot.ownerDocument, "div");
      node.addClass("systemsculpt-agent-part", `is-${part.kind}`);
      node.dataset.partKey = key;
      this.activeNodes.set(key, node);
    }
    const candidate = node.ownerDocument.activeElement;
    const activeElement = candidate?.nodeType === 1 ? candidate as HTMLElement : null;
    const preservedFocusKey = activeElement && node.contains(activeElement)
      ? activeElement.dataset.focusKey
      : undefined;
    if (this.activePartRefs.get(key) !== part || this.activeToolGroupRefs.has(key)) {
      await this.renderPart(node, part, this.activePartRefs.get(key));
      this.activePartRefs.set(key, part);
      this.activeToolGroupRefs.delete(key);
    }
    if (preservedFocusKey) {
      node.querySelector<HTMLElement>(`[data-focus-key="${preservedFocusKey}"]`)?.focus();
    }
    return node;
  }

  private async renderActiveToolGroup(
    parts: readonly AgentToolPart[],
    key: string,
  ): Promise<HTMLElement> {
    if (parts.length === 1) return this.renderActivePart(parts[0], key);
    let node = this.activeNodes.get(key);
    if (!node) {
      node = createSurfaceElement(this.activeRoot.ownerDocument, "div");
      node.dataset.partKey = key;
      this.activeNodes.set(key, node);
    }
    const previous = this.activeToolGroupRefs.get(key);
    const unchanged = previous?.length === parts.length
      && previous.every((part, index) => part === parts[index]);
    if (!unchanged) {
      node.empty();
      node.className = "systemsculpt-agent-part is-tool";
      await this.renderTool(node, parts);
      this.activePartRefs.delete(key);
      this.activeToolGroupRefs.set(key, parts);
    }
    return node;
  }

  private ensureActiveTurn(turnId: string | null): HTMLElement {
    if (this.activeTurn && this.activeBody && this.activeTurnId === turnId) return this.activeBody;
    this.clearActive();
    this.activeTurnId = turnId;
    this.activeTurn = this.activeRoot.createDiv({
      cls: "systemsculpt-agent-turn is-assistant is-active",
      attr: {
        ...(turnId ? { "data-turn-id": turnId } : {}),
        "aria-label": "SystemSculpt response",
      },
    });
    this.activeBody = this.activeTurn.createDiv({ cls: "systemsculpt-agent-turn-body" });
    return this.activeBody;
  }

  private ensureActivity(
    key: string,
    presentation: AgentConversationPresentation,
  ): HTMLElement {
    let activity = this.activeActivityNodes.get(key);
    if (!activity) {
      activity = this.createActivity(this.activeRoot, presentation.activityStatus).element;
      activity.dataset.activityKey = key;
      this.activeActivityNodes.set(key, activity);
    }
    activity.className = `systemsculpt-agent-activity is-${presentation.phase}`;
    activity.setAttribute("aria-label", `Agent activity: ${presentation.activityStatus}`);
    const state = activity.querySelector<HTMLElement>(".systemsculpt-agent-activity-state");
    state?.setText(presentation.activityStatus);
    activity.querySelector<HTMLElement>(".systemsculpt-agent-activity-header")?.setAttrs({
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    });
    return activity;
  }

  private createActivity(
    parent: HTMLElement,
    state: string,
  ): Readonly<{ element: HTMLElement; body: HTMLElement }> {
    const element = parent.createDiv({
      cls: "systemsculpt-agent-activity",
      attr: { "aria-label": `Agent activity: ${state}` },
    });
    const header = element.createDiv({ cls: "systemsculpt-agent-activity-header" });
    const icon = header.createSpan({ cls: "systemsculpt-agent-activity-icon" });
    setIcon(icon, "sparkles");
    header.createEl("strong", { cls: "systemsculpt-agent-activity-label", text: "Activity" });
    header.createSpan({ cls: "systemsculpt-agent-activity-state", text: state });
    const body = element.createDiv({ cls: "systemsculpt-agent-activity-body" });
    return { element, body };
  }

  private reconcileChildren(parent: HTMLElement, desired: readonly HTMLElement[]): void {
    let cursor = parent.firstElementChild;
    for (const node of desired) {
      if (cursor !== node) parent.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
    }
    while (cursor) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }

  public clearActive(): void {
    this.activeRoot.empty();
    this.activeTurn = null;
    this.activeBody = null;
    this.activeTurnId = null;
    this.activeActivityNodes.clear();
    this.activeNodes.clear();
    this.activePartRefs.clear();
    this.activeToolGroupRefs.clear();
    this.element.setAttribute("aria-busy", "false");
  }

  /*
   * Stable part nodes are reconciled above. Only the changed part subtree is
   * refreshed, so adding a tool does not remount earlier text or disclosures.
   */
  private async renderPart(node: HTMLElement, part: AgentPart, previousPart?: AgentPart): Promise<void> {
    const previousDetails = part.kind === "reasoning"
      ? node.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details")
      : null;
    const previousOpen = previousDetails?.open;
    node.empty();
    node.className = `systemsculpt-agent-part is-${part.kind}`;
    switch (part.kind) {
      case "reasoning": {
        const justCompleted = previousPart?.kind === "reasoning"
          && previousPart.state === "streaming"
          && part.state === "complete";
        await this.renderReasoning(
          node,
          part.summary,
          part.state === "streaming",
          justCompleted ? false : previousOpen,
        );
        return;
      }
      case "text":
        node.classList.toggle("is-streaming", part.state === "streaming");
        await this.renderMarkdown(part.markdown, node);
        return;
      case "status": {
        node.classList.add(`is-${part.phase}`);
        node.setAttribute("role", "status");
        node.setAttribute("aria-live", "polite");
        const icon = node.createSpan({ cls: "systemsculpt-agent-status-icon" });
        setIcon(icon, part.phase === "complete" ? "check" : "loader-circle");
        node.createSpan({ text: part.label || "Working…" });
        return;
      }
      case "tool":
        await this.renderTool(node, part);
        return;
      case "error": {
        node.setAttrs({ role: "alert", "aria-live": "assertive" });
        const errorIcon = node.createSpan();
        setIcon(errorIcon, "circle-alert");
        const copy = node.createDiv();
        copy.createEl("strong", { text: "Agent stopped" });
        copy.createDiv({ text: part.error.message });
        if (part.retryable && part.retryMessageId && this.options.onRetryMessage) {
          const retry = createUiAction(copy, {
            label: "Retry",
            tone: "primary",
            size: "small",
          });
          retry.addClass("systemsculpt-agent-error-retry");
          retry.onclick = () => void this.options.onRetryMessage?.(part.retryMessageId!);
        }
        return;
      }
      default:
        return;
    }
  }

  public override onunload(): void {
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    for (const timer of this.copyFeedbackTimers.values()) ownerWindow.clearTimeout(timer);
    this.copyFeedbackTimers.clear();
    this.clearInlineEditorShortcutGuard();
    this.clearSuppressedEditorKeyup();
  }

  private async renderReasoning(
    node: HTMLElement,
    summary: string,
    streaming: boolean,
    preservedOpen?: boolean,
  ): Promise<void> {
    node.classList.toggle("is-streaming", streaming);
    const details = node.createEl("details", { cls: "systemsculpt-agent-reasoning-details" });
    details.open = preservedOpen ?? streaming;
    const header = details.createEl("summary", {
      cls: "systemsculpt-agent-reasoning-header",
      attr: {
        "aria-label": streaming ? "Thinking summary" : "Reasoning summary",
        "data-focus-key": "reasoning-summary",
        tabindex: "0",
      },
    });
    header.tabIndex = 0;
    const disclosure = header.createSpan({ cls: "systemsculpt-agent-reasoning-disclosure" });
    setIcon(disclosure, "chevron-right");
    const icon = header.createSpan({ cls: "systemsculpt-agent-reasoning-icon" });
    setIcon(icon, streaming ? "loader-circle" : "sparkles");
    icon.classList.toggle("is-animated", streaming);
    header.createEl("strong", { text: streaming ? "Thinking" : "Reasoning" });
    const body = details.createDiv({ cls: "systemsculpt-agent-reasoning-body" });
    if (summary.trim()) await this.renderMarkdown(summary, body);
  }

  private async renderTool(
    node: HTMLElement,
    partOrParts: AgentToolPart | readonly AgentToolPart[],
  ): Promise<void> {
    const parts = Array.isArray(partOrParts) ? partOrParts : [partOrParts];
    const part = parts[0];
    if (!part) return;
    node.classList.add(`is-${part.state}`);
    node.classList.toggle("is-grouped", parts.length > 1);
    if (parts.length > 1) node.dataset.toolCount = String(parts.length);
    const presentation = presentAgentToolGroup(parts);
    const shell = node.createDiv({ cls: "systemsculpt-agent-tool" });
    const header = shell.createDiv({
      cls: "systemsculpt-agent-tool-header",
      attr: {
        "aria-label": [
          presentation.label,
          presentation.summary,
          presentation.stateLabel,
        ].filter(Boolean).join(", "),
      },
    });
    const icon = header.createSpan({ cls: "systemsculpt-agent-tool-icon" });
    setIcon(icon, presentation.icon);
    icon.classList.toggle("is-animated", presentation.animated);
    header.createEl("strong", { text: presentation.label });
    if (presentation.summary) {
      header.createSpan({ cls: "systemsculpt-agent-tool-summary", text: presentation.summary });
    }
    header.createSpan({ cls: "systemsculpt-agent-tool-state", text: presentation.stateLabel });

    const support = shell.createDiv({ cls: "systemsculpt-agent-tool-support" });
    if (parts.length === 1 && part.error) {
      support.createDiv({
        cls: "systemsculpt-agent-tool-error",
        text: part.error.message,
        attr: { role: "alert" },
      });
    }
    if (parts.length === 1 && part.state === "approval-required" && part.approvalId) {
      const approval = node.createDiv({
        cls: "systemsculpt-agent-approval",
        attr: {
          role: "group",
          "aria-label": "Vault change approval",
          "aria-live": "polite",
          "aria-atomic": "true",
        },
      });
      approval.createDiv({ cls: "systemsculpt-agent-approval-copy", text: "Allow this change in your vault?" });
      const actions = approval.createDiv({ cls: "systemsculpt-agent-approval-actions" });
      const deny = createUiAction(actions, {
        label: "Deny",
        size: "small",
      });
      deny.setAttr("data-focus-key", "tool-deny");
      const approve = createUiAction(actions, {
        label: "Allow once",
        tone: "primary",
        size: "small",
      });
      approve.setAttr("data-focus-key", "tool-allow-once");
      deny.onclick = () => void this.options.onApprove(part.approvalId!, false);
      approve.onclick = () => void this.options.onApprove(part.approvalId!, true);
      if (presentation.canonicalName !== "trash") {
        const allowForChat = createUiAction(actions, {
          label: "Allow for chat",
          size: "small",
        });
        allowForChat.setAttr("data-focus-key", "tool-allow-chat");
        allowForChat.onclick = () => void this.options.onApprove(part.approvalId!, true, true);
      }
      const preview = approval.createDiv({
        cls: "systemsculpt-agent-approval-preview",
        attr: { "aria-label": "Proposed vault changes" },
      });
      const toolCall = toolCallForPart(part);
      try {
        const diff = await renderWriteEditInlineDiff(this.options.app, preview, toolCall);
        if (!diff) await renderOperationsInlinePreview(preview, toolCall);
        preview.toggleAttribute("hidden", !preview.hasChildNodes());
      } catch {
        preview.toggleAttribute("hidden", true);
      }
    }
    if (parts.length === 1 && ACTIONABLE_ARTIFACT_TOOLS.has(presentation.canonicalName)) {
      for (const artifact of part.output?.artifacts ?? []) this.renderArtifact(support, artifact);
    }
    support.toggleAttribute("hidden", !support.hasChildNodes());
  }

  private renderArtifact(parent: HTMLElement, artifact: AgentArtifact): void {
    const card = parent.createDiv({ cls: "systemsculpt-agent-artifact" });
    const icon = card.createSpan({ cls: "systemsculpt-agent-artifact-icon" });
    setIcon(icon, artifact.kind === "diff" ? "diff" : "file-check-2");
    const copy = card.createDiv({ cls: "systemsculpt-agent-artifact-copy" });
    copy.createEl("strong", { text: artifact.title });
    if (artifact.description) copy.createDiv({ text: artifact.description });
    const actions = card.createDiv({ cls: "systemsculpt-agent-artifact-actions" });
    const open = button(actions, "Open", "arrow-up-right");
    open.onclick = () => void this.options.onOpenArtifact(artifact);
    if (artifact.path) {
      const copyPath = button(actions, "Copy path", "copy");
      copyPath.onclick = () => void this.options.onCopyArtifactPath(artifact);
    }
  }

  private historicalToolPart(tool: ToolCall): AgentToolPart {
    let input: unknown = {};
    try { input = JSON.parse(tool.request.function.arguments || "{}"); } catch { input = tool.request.function.arguments; }
    const success = tool.state === "completed" && tool.result?.success === true;
    const paths = artifactPaths(tool, success);
    const state = historicalToolState(tool, success);
    const summary = tool.result?.data && typeof tool.result.data === "object"
      && typeof (tool.result.data as { summary?: unknown }).summary === "string"
      ? (tool.result.data as { summary: string }).summary
      : paths.join(", ");
    return {
      id: tool.id,
      order: tool.timestamp,
      kind: "tool",
      messageId: tool.messageId,
      callId: tool.id,
      name: tool.request.function.name,
      location: tool.executedOn === "server" ? "server" : "vault",
      input,
      state,
      ...(typeof tool.result?.data !== "undefined" || paths.length ? {
        output: {
          ...(summary ? { summary } : {}),
          data: tool.result?.data,
          ...(paths.length ? {
            artifacts: paths.map((path) => ({
              id: `${tool.id}:artifact:${path}`,
              kind: "vault_file" as const,
              title: path.split("/").pop() || path,
              path,
            })),
          } : {}),
        },
      } : {}),
      ...(!success && tool.result?.error ? {
        error: {
          code: String(tool.result.error.code || "TOOL_EXECUTION_FAILED"),
          message: tool.result.error.message || "The tool failed.",
        },
      } : {}),
    };
  }

  private async renderHistoricalTool(parent: HTMLElement, tool: ToolCall): Promise<void> {
    const node = parent.createDiv({ cls: "systemsculpt-agent-part is-tool" });
    await this.renderTool(node, this.historicalToolPart(tool));
  }

  private renderMessageActions(row: HTMLElement, message: ChatMessage, text: string): void {
    const canCopy = text.length > 0 && Boolean(this.options.onCopyText);
    const canRetry = message.role === "user" && Boolean(this.options.onRetryMessage);
    if (!canCopy && !canRetry) return;

    const actions = row.createDiv({ cls: "systemsculpt-agent-message-actions" });
    if (canCopy) {
      const subject = message.role === "assistant" ? "response" : "message";
      const copy = createUiAction(actions, {
        label: `Copy ${subject}`,
        icon: "copy",
        size: "icon",
      });
      copy.addClass("systemsculpt-agent-message-copy");
      copy.setAttrs({ "aria-label": `Copy ${subject}`, "aria-live": "polite" });
      copy.onclick = () => void this.copyMessage(copy, text, subject);
    }
    if (canRetry) {
      const retry = createUiAction(actions, {
        label: "Edit and resubmit",
        icon: "pencil",
        size: "icon",
      });
      retry.addClass("systemsculpt-agent-inline-button");
      retry.setAttr("data-focus-key", "edit-message");
      retry.onclick = () => void this.options.onRetryMessage?.(message.message_id);
    }
  }

  private renderInlineMessageEditor(parent: HTMLElement, edit: AgentInlineMessageEdit): void {
    const editor = parent.createDiv({
      cls: "systemsculpt-agent-message-editor",
      attr: {
        role: "group",
        "aria-label": "Edit message",
      },
    });
    const input = editor.createEl("textarea", {
      cls: "systemsculpt-agent-message-editor-input",
      attr: {
        rows: "3",
        "aria-label": "Edit message",
      },
    });
    input.value = edit.text;

    const consequenceParts: string[] = [];
    if (edit.laterMessageCount > 0) {
      consequenceParts.push(
        `Saving will replace ${edit.laterMessageCount} later ${
          edit.laterMessageCount === 1 ? "message" : "messages"
        } in this chat.`,
      );
    } else {
      consequenceParts.push("Saving will resubmit this message from here.");
    }
    if (edit.unavailableAttachmentCount > 0) {
      consequenceParts.push(
        `${edit.unavailableAttachmentCount} unavailable ${
          edit.unavailableAttachmentCount === 1 ? "attachment" : "attachments"
        } will be left out.`,
      );
    }
    if (edit.requiresReplayConfirmation) {
      consequenceParts.push("Existing vault changes will not be undone. You will confirm before resubmitting.");
    }
    consequenceParts.push("Ctrl or Command Enter to save. Escape to cancel.");
    const hint = editor.createDiv({
      cls: "systemsculpt-agent-message-editor-hint",
      text: consequenceParts.join(" "),
    });
    const hintId = `systemsculpt-agent-message-editor-hint-${edit.messageId}`;
    hint.id = hintId;
    input.setAttribute("aria-describedby", hintId);

    const actions = editor.createDiv({ cls: "systemsculpt-agent-message-editor-actions" });
    const cancel = createUiAction(actions, {
      label: "Cancel",
      size: "small",
    });
    const save = createUiAction(actions, {
      label: "Save and resubmit",
      tone: "primary",
      size: "small",
    });
    let submitting = false;
    const sync = (): void => {
      const empty = input.value.trim().length === 0 && !edit.hasAttachments;
      input.disabled = submitting;
      cancel.disabled = submitting;
      save.disabled = submitting || empty;
      editor.setAttribute("aria-busy", String(submitting));
    };
    const cancelEdit = (): void => {
      if (submitting) return;
      void this.options.onCancelMessageEdit?.(edit.messageId);
    };
    const submitEdit = async (): Promise<void> => {
      if (submitting || (input.value.trim().length === 0 && !edit.hasAttachments)) return;
      submitting = true;
      sync();
      let accepted = false;
      try {
        accepted = await this.options.onResubmitMessage?.(edit.messageId, input.value.trim()) === true;
      } finally {
        if (!accepted && input.isConnected) {
          submitting = false;
          sync();
          input.focus();
        }
      }
    };
    input.oninput = () => {
      input.setCssStyles({ height: "auto" });
      const next = Math.min(Math.max(input.scrollHeight, 96), 280);
      input.setCssStyles({ height: `${next}px` });
      sync();
    };
    const handleEditorKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.suppressEditorKeyup("Escape", cancelEdit);
        return;
      }
      if (
        event.key === "Enter"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !event.isComposing
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.suppressEditorKeyup("Enter");
        void submitEdit();
      }
    };
    input.onkeydown = handleEditorKeydown;
    cancel.onclick = cancelEdit;
    save.onclick = () => void submitEdit();
    this.installInlineEditorShortcutGuard(input, handleEditorKeydown);
    sync();
  }

  private installInlineEditorShortcutGuard(
    input: HTMLTextAreaElement,
    handleKeydown: (event: KeyboardEvent) => void,
  ): void {
    this.clearInlineEditorShortcutGuard();
    const ownerWindow = getSurfaceOwnerWindow(input);
    const keydown = (event: KeyboardEvent): void => {
      if (event.target === input) handleKeydown(event);
    };
    const keyup = (event: KeyboardEvent): void => {
      this.containSuppressedEditorKeyup(event);
    };
    ownerWindow.addEventListener("keydown", keydown, true);
    ownerWindow.addEventListener("keyup", keyup, true);
    this.inlineEditorShortcutCleanup = () => {
      ownerWindow.removeEventListener("keydown", keydown, true);
      ownerWindow.removeEventListener("keyup", keyup, true);
    };
  }

  private clearInlineEditorShortcutGuard(): void {
    this.inlineEditorShortcutCleanup?.();
    this.inlineEditorShortcutCleanup = null;
  }

  private containSuppressedEditorKeyup(event: KeyboardEvent): boolean {
    if (event.key !== this.suppressedEditorKeyup) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const action = this.suppressedEditorKeyupAction;
    this.clearSuppressedEditorKeyup();
    action?.();
    return true;
  }

  private suppressEditorKeyup(
    key: "Escape" | "Enter",
    afterKeyup: (() => void) | null = null,
  ): void {
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    if (this.suppressedEditorKeyupTimer !== null) {
      ownerWindow.clearTimeout(this.suppressedEditorKeyupTimer);
    }
    this.suppressedEditorKeyup = key;
    this.suppressedEditorKeyupAction = afterKeyup;
    this.suppressedEditorKeyupTimer = ownerWindow.setTimeout(() => {
      const action = this.suppressedEditorKeyupAction;
      this.suppressedEditorKeyup = null;
      this.suppressedEditorKeyupAction = null;
      this.suppressedEditorKeyupTimer = null;
      action?.();
    }, 500);
  }

  private clearSuppressedEditorKeyup(): void {
    if (this.suppressedEditorKeyupTimer !== null) {
      getSurfaceOwnerWindow(this.element).clearTimeout(this.suppressedEditorKeyupTimer);
    }
    this.suppressedEditorKeyup = null;
    this.suppressedEditorKeyupAction = null;
    this.suppressedEditorKeyupTimer = null;
  }

  private renderMessageAttachments(parent: HTMLElement, attachments: readonly PresentedMessageAttachment[]): void {
    const list = parent.createDiv({
      cls: "systemsculpt-agent-message-attachments",
      attr: { role: "list", "aria-label": "Message attachments" },
    });
    for (const attachment of attachments) {
      const item = list.createDiv({
        cls: `systemsculpt-agent-message-attachment is-${attachment.kind}`,
        attr: { role: "listitem" },
      });
      if (attachment.kind === "image" && attachment.url) {
        item.createEl("img", {
          attr: { src: attachment.url, alt: attachment.label, loading: "lazy" },
        });
      } else {
        const icon = item.createSpan({ cls: "systemsculpt-agent-message-attachment-icon" });
        setIcon(icon, attachment.kind === "image" ? "image" : "file-text");
      }
      const copy = item.createDiv({ cls: "systemsculpt-agent-message-attachment-copy" });
      copy.createEl("strong", { text: attachment.label });
      if (attachment.mimeType) copy.createSpan({ text: attachment.mimeType });
      if (attachment.unavailable) copy.createSpan({ text: "Unavailable" });
    }
  }

  private async renderMarkdown(markdown: string, parent: HTMLElement): Promise<void> {
    parent.empty();
    await MarkdownRenderer.render(this.options.app, markdown, parent, this.options.sourcePath(), this);
    this.enhanceCodeBlocks(parent);
  }

  private enhanceCodeBlocks(parent: HTMLElement): void {
    for (const pre of Array.from(parent.querySelectorAll<HTMLPreElement>("pre"))) {
      const code = pre.querySelector<HTMLElement>("code");
      if (!code) continue;

      pre.addClass("systemsculpt-agent-code-block");
      pre.querySelectorAll(".copy-code-button").forEach((button) => button.remove());
      if (pre.querySelector(".systemsculpt-agent-code-copy")) continue;

      const copyButton = createUiAction(pre, {
        label: "Copy",
        icon: "copy",
        size: "small",
      });
      copyButton.addClass("systemsculpt-agent-code-copy");
      copyButton.setAttrs({ "aria-label": "Copy code", "aria-live": "polite" });
      copyButton.onclick = async () => {
        const copied = await tryCopyToClipboard(code.textContent ?? "", pre);
        this.showCopyFeedback(copyButton, copied);
      };
    }
  }

  private showCopyFeedback(button: HTMLButtonElement, copied: boolean): void {
    const ownerWindow = getSurfaceOwnerWindow(button);
    const previousTimer = this.copyFeedbackTimers.get(button);
    if (typeof previousTimer === "number") ownerWindow.clearTimeout(previousTimer);

    button.classList.toggle("is-copied", copied);
    button.classList.toggle("is-copy-failed", !copied);
    updateUiAction(button, {
      label: copied ? "Copied" : "Try again",
      icon: copied ? "check" : "circle-alert",
    });
    button.setAttribute("aria-label", copied ? "Code copied" : "Could not copy code");

    const timer = ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected) return;
      button.removeClass("is-copied", "is-copy-failed");
      updateUiAction(button, { label: "Copy", icon: "copy" });
      button.setAttribute("aria-label", "Copy code");
    }, 1_600);
    this.copyFeedbackTimers.set(button, timer);
  }

  private async copyMessage(
    button: HTMLButtonElement,
    text: string,
    subject: "message" | "response",
  ): Promise<void> {
    const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
    button.dataset.copyAttempt = attempt;
    let copied = false;
    try {
      copied = await this.options.onCopyText?.(text) === true;
    } catch {
      copied = false;
    }
    if (!button.isConnected || button.dataset.copyAttempt !== attempt) return;

    const ownerWindow = getSurfaceOwnerWindow(button);
    const previousTimer = this.copyFeedbackTimers.get(button);
    if (typeof previousTimer === "number") ownerWindow.clearTimeout(previousTimer);

    button.classList.toggle("is-copied", copied);
    button.classList.toggle("is-copy-failed", !copied);
    updateUiAction(button, {
      label: copied ? `${subject === "response" ? "Response" : "Message"} copied` : `Could not copy ${subject}. Try again`,
      icon: copied ? "check" : "circle-alert",
    });
    const subjectLabel = subject === "response" ? "Response" : "Message";
    button.setAttribute(
      "aria-label",
      copied ? `${subjectLabel} copied` : `Could not copy ${subject}. Try again`,
    );

    const timer = ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected) return;
      button.removeClass("is-copied", "is-copy-failed");
      updateUiAction(button, { label: `Copy ${subject}`, icon: "copy" });
    }, copied ? 1_800 : 3_000);
    this.copyFeedbackTimers.set(button, timer);
  }
}
