import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import {
  createSurfaceElement,
  createUiAction,
  getSurfaceOwnerWindow,
  updateUiAction,
} from "../../core/ui/surface";
import type { ChatMessage, MessagePart } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import {
  isServerExecutedManagedToolCall,
  readManagedToolCallFunction,
} from "../../services/chat/ManagedToolExecution";
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
  ManagedAgentError,
} from "./AgentConversation";
import {
  presentAgentError,
  presentAgentErrorMessage,
  type AgentConversationPresentation,
} from "./AgentConversationPresentation";
import {
  groupConsecutiveToolActivity,
  presentAgentTool,
  presentAgentToolGroup,
} from "./AgentToolPresentation";
import {
  presentChatMessage,
  presentMessageContent,
  type PresentedMessageAttachment,
  type PresentedMessageContent,
} from "./ChatMessagePresentation";
import { LiveMarkdownRenderer } from "./LiveMarkdownRenderer";

export type AgentConversationRendererOptions = Readonly<{
  app: App;
  sourcePath: () => string;
  labelledBy?: string;
  onApprove: (approvalId: string, approved: boolean, rememberForChat?: boolean) => void | Promise<void>;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  onCopyArtifactPath: (artifact: AgentArtifact) => boolean | Promise<boolean>;
  onRetryFailedTurn?: (messageId: string) => void | Promise<void>;
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

function button(parent: HTMLElement, testId: string, label: string, icon?: string): HTMLButtonElement {
  const element = createUiAction(parent, {
    label,
    testId,
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

function visibleToolError(error: ManagedAgentError | undefined): string | null {
  return error
    ? presentAgentErrorMessage(error.message, error.retryable === true)
    : null;
}

function toolDisplayFingerprint(part: AgentToolPart): string {
  const presentation = presentAgentTool(part);
  const approvalInput = part.location === "vault"
    && part.state === "approval-required"
    && part.approvalId
    ? part.input
    : undefined;
  const artifacts = ACTIONABLE_ARTIFACT_TOOLS.has(presentation.canonicalName)
    ? part.output?.artifacts
    : undefined;
  return JSON.stringify({
    location: part.location,
    state: part.state,
    presentation,
    error: visibleToolError(part.error),
    approvalId: approvalInput === undefined ? undefined : part.approvalId,
    approvalInput,
    artifacts,
  });
}

function agentPartsEqual(left: AgentPart | undefined, right: AgentPart): boolean {
  if (left === right) return true;
  if (!left || left.kind !== right.kind || left.id !== right.id || left.order !== right.order) {
    return false;
  }
  switch (right.kind) {
    case "text":
      return left.kind === "text"
        && left.messageId === right.messageId
        && left.state === right.state
        && left.markdown === right.markdown;
    case "reasoning":
      return left.kind === "reasoning"
        && left.messageId === right.messageId
        && left.state === right.state
        && left.summary === right.summary;
    case "error":
      return left.kind === "error"
        && left.retryable === right.retryable
        && left.retryMessageId === right.retryMessageId
        && JSON.stringify(presentAgentError(left.error, left.retryable))
          === JSON.stringify(presentAgentError(right.error, right.retryable));
    case "tool":
      return left.kind === "tool"
        && left.messageId === right.messageId
        && left.callId === right.callId
        && toolDisplayFingerprint(left) === toolDisplayFingerprint(right);
  }
}

const ACTIVE_TOOL_PRESENTATION_STATES = new Set<AgentToolPart["state"]>([
  "input-streaming",
  "input-ready",
  "approval-required",
  "approved",
  "running",
]);

function terminalToolPresentation(
  part: AgentPart,
  presentation: AgentConversationPresentation,
): AgentPart {
  if (
    part.kind !== "tool"
    || presentation.busy
    || !ACTIVE_TOOL_PRESENTATION_STATES.has(part.state)
  ) {
    return part;
  }
  const state: AgentToolPart["state"] = presentation.phase === "cancelled"
    ? "cancelled"
    : presentation.phase === "failed"
      ? "failed"
      : "outcome-unknown";
  return { ...part, state };
}

/** Projects durable messages plus the active normalized agent run into native DOM. */
export class AgentConversationRenderer extends Component {
  public readonly element: HTMLElement;
  private readonly historyRoot: HTMLElement;
  private readonly activeRoot: HTMLElement;
  private readonly activeNodes = new Map<string, HTMLElement>();
  private readonly activePartRefs = new Map<string, AgentPart>();
  private readonly activeToolGroupRefs = new Map<string, readonly AgentToolPart[]>();
  private readonly activeToolErrorSuppression = new Map<string, boolean>();
  private activeTailStatus: HTMLElement | null = null;
  private historyRows = new Map<string, Readonly<{
    fingerprint: string;
    node: HTMLElement;
  }>>();
  private inlineMessageEdit: AgentInlineMessageEdit | null = null;
  private activeTurn: HTMLElement | null = null;
  private activeBody: HTMLElement | null = null;
  private activeTurnId: string | null = null;
  private suppressedEditorKeyup: "Escape" | "Enter" | null = null;
  private suppressedEditorKeyupAction: (() => void) | null = null;
  private suppressedEditorKeyupTimer: number | null = null;
  private inlineEditorShortcutCleanup: (() => void) | null = null;
  private readonly copyFeedbackTimers = new Map<HTMLButtonElement, number>();
  private readonly liveMarkdown: LiveMarkdownRenderer;
  private renderGeneration = 0;
  private lifecycleGeneration = 0;
  private renderingEnabled = true;

  constructor(parent: HTMLElement, private readonly options: AgentConversationRendererOptions) {
    super();
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-conversation",
      attr: {
        "data-testid": "chat.scroller",
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
    this.liveMarkdown = new LiveMarkdownRenderer({
      render: async (markdown, staging, component) => {
        await MarkdownRenderer.render(
          this.options.app,
          markdown,
          staging,
          this.options.sourcePath(),
          component,
        );
        this.enhanceCodeBlocks(staging);
      },
    });
    this.addChild(this.liveMarkdown);
  }

  public async renderHistory(messages: readonly ChatMessage[]): Promise<void> {
    if (!this.renderingEnabled) return;
    const lifecycleGeneration = this.lifecycleGeneration;
    const generation = ++this.renderGeneration;
    const isCurrent = (): boolean =>
      this.renderingEnabled
      && lifecycleGeneration === this.lifecycleGeneration
      && generation === this.renderGeneration;
    if (
      this.inlineMessageEdit
      && !messages.some((message) =>
        message.role === "user" && message.message_id === this.inlineMessageEdit?.messageId)
    ) {
      this.inlineMessageEdit = null;
    }
    const nextHistory = createSurfaceElement(this.historyRoot.ownerDocument, "div");
    const nextRows = new Map<string, Readonly<{
      fingerprint: string;
      node: HTMLElement;
    }>>();
    const desiredRows: HTMLElement[] = [];
    let hasInlineEdit = false;
    for (let index = 0; index < messages.length;) {
      if (!isCurrent()) return;
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
      hasInlineEdit ||= inlineEdit !== null;
      const rowKey = JSON.stringify({
        role: message.role,
        messageIds: turnMessages.map((entry) => entry.message_id),
      });
      const fingerprint = JSON.stringify({
        messages: turnMessages,
        inlineEdit,
      });
      const existing = this.historyRows.get(rowKey);
      if (existing?.fingerprint === fingerprint) {
        nextRows.set(rowKey, existing);
        desiredRows.push(existing.node);
        continue;
      }
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
        if (!isCurrent()) return;
      } else {
        const { content } = presented[0];
        if (inlineEdit) {
          this.renderInlineMessageEditor(body, inlineEdit);
        } else if (content.markdown.trim()) {
          await this.renderMarkdown(content.markdown, body);
          if (!isCurrent()) return;
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
      const rendered = { fingerprint, node: row };
      nextRows.set(rowKey, rendered);
      desiredRows.push(row);
    }
    if (!isCurrent()) return;
    this.reconcileChildren(this.historyRoot, desiredRows);
    this.historyRows = nextRows;
    if (!hasInlineEdit) this.clearInlineEditorShortcutGuard();
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

    for (const entry of timelineEntries) {
      if (entry.kind === "item") {
        await this.renderHistoricalPart(parent, entry.item);
        continue;
      }
      const node = parent.createDiv({ cls: "systemsculpt-agent-part is-tool" });
      await this.renderTool(node, entry.tools);
    }
  }

  public async renderActive(
    snapshot: AgentConversationSnapshot,
    presentation: AgentConversationPresentation,
  ): Promise<void> {
    if (!this.renderingEnabled) return;
    const lifecycleGeneration = this.lifecycleGeneration;
    const isCurrent = (): boolean =>
      this.renderingEnabled && lifecycleGeneration === this.lifecycleGeneration;
    this.element.setAttribute("aria-busy", String(presentation.busy));
    const body = this.ensureActiveTurn(snapshot.turnId);
    const wantedParts = new Set<string>();
    const orderedParts = presentation.visibleParts
      .map((part) => terminalToolPresentation(part, presentation))
      .map((part, index) => ({ part, index }))
      .sort((left, right) =>
        left.part.order - right.part.order || left.index - right.index)
      .map(({ part }) => part);
    const terminalErrors = orderedParts.filter(
      (part): part is Extract<AgentPart, { kind: "error" }> => part.kind === "error",
    );
    const showTerminalStatus = presentation.phase === "cancelled"
      || (presentation.phase === "failed" && terminalErrors.length === 0);
    if (presentation.busy || showTerminalStatus) {
      this.ensureTailStatus(presentation);
    } else if (this.activeTailStatus) {
      this.activeTailStatus.remove();
      this.activeTailStatus = null;
    }
    const duplicatesTerminalError = (part: AgentToolPart): boolean =>
      Boolean(part.error && terminalErrors.some((terminal) =>
        visibleToolError(part.error) === presentAgentError(
          terminal.error,
          terminal.retryable,
        ).message));
    const lanes: Array<Readonly<{ key: string; node: HTMLElement }>> = [];
    let firstRenderError: unknown;

    const timelineEntries = groupConsecutiveToolActivity(
      orderedParts,
      (part) => part.kind === "tool" ? part : null,
      presentation.phase === "completed",
    );

    for (const entry of timelineEntries) {
      if (entry.kind === "item") {
        const key = `${entry.item.kind}:${entry.item.id}`;
        wantedParts.add(key);
        try {
          const node = await this.renderActivePart(entry.item, key);
          if (!isCurrent()) return;
          lanes.push({
            key,
            node,
          });
        } catch (error) {
          if (!isCurrent()) return;
          firstRenderError ??= error;
          const node = this.activeNodes.get(key);
          if (node) lanes.push({ key, node });
        }
        continue;
      }
      const first = entry.tools[0];
      const key = `tool:${first.callId}`;
      wantedParts.add(key);
      try {
        const node = await this.renderActiveToolGroup(
          entry.tools,
          key,
          entry.tools.some(duplicatesTerminalError),
        );
        if (!isCurrent()) return;
        lanes.push({
          key,
          node,
        });
      } catch (error) {
        if (!isCurrent()) return;
        firstRenderError ??= error;
        const node = this.activeNodes.get(key);
        if (node) lanes.push({ key, node });
      }
    }
    if (!isCurrent()) return;
    if (presentation.busy || showTerminalStatus) {
      lanes.push({
        key: "tail-status",
        node: this.ensureTailStatus(presentation),
      });
    }

    this.reconcileChildren(body, lanes.map((lane) => lane.node));
    for (const [key, node] of this.activeNodes) {
      if (!wantedParts.has(key)) {
        this.liveMarkdown.forget(node);
        node.remove();
        this.activeNodes.delete(key);
        this.activePartRefs.delete(key);
        this.activeToolGroupRefs.delete(key);
        this.activeToolErrorSuppression.delete(key);
      }
    }
    if (typeof firstRenderError !== "undefined") throw firstRenderError;
  }

  private async renderActivePart(
    part: AgentPart,
    key: string,
    suppressToolError = false,
  ): Promise<HTMLElement> {
    let node = this.activeNodes.get(key);
    if (!node) {
      node = createSurfaceElement(this.activeRoot.ownerDocument, "div");
      node.addClass("systemsculpt-agent-part", `is-${part.kind}`);
      node.dataset.partKey = key;
      this.activeNodes.set(key, node);
      this.insertActiveNode(node);
    }
    const candidate = node.ownerDocument.activeElement;
    const activeElement = candidate?.nodeType === 1 ? candidate as HTMLElement : null;
    const preservedFocusKey = activeElement && node.contains(activeElement)
      ? activeElement.dataset.focusKey
      : undefined;
    const suppressionChanged = part.kind === "tool"
      && this.activeToolErrorSuppression.get(key) !== suppressToolError;
    if (
      !agentPartsEqual(this.activePartRefs.get(key), part)
      || this.activeToolGroupRefs.has(key)
      || suppressionChanged
    ) {
      await this.renderPart(
        node,
        part,
        this.activePartRefs.get(key),
        suppressToolError,
      );
      this.activePartRefs.set(key, part);
      this.activeToolGroupRefs.delete(key);
      if (part.kind === "tool") {
        this.activeToolErrorSuppression.set(key, suppressToolError);
      } else {
        this.activeToolErrorSuppression.delete(key);
      }
    }
    if (preservedFocusKey) {
      node.querySelector<HTMLElement>(`[data-focus-key="${preservedFocusKey}"]`)?.focus();
    }
    return node;
  }

  private async renderActiveToolGroup(
    parts: readonly AgentToolPart[],
    key: string,
    suppressToolError: boolean,
  ): Promise<HTMLElement> {
    if (parts.length === 1) {
      return this.renderActivePart(parts[0], key, suppressToolError);
    }
    let node = this.activeNodes.get(key);
    if (!node) {
      node = createSurfaceElement(this.activeRoot.ownerDocument, "div");
      node.dataset.partKey = key;
      this.activeNodes.set(key, node);
      this.insertActiveNode(node);
    }
    const previous = this.activeToolGroupRefs.get(key);
    const unchanged = previous?.length === parts.length
      && previous.every((part, index) => agentPartsEqual(part, parts[index]));
    const suppressionChanged =
      this.activeToolErrorSuppression.get(key) !== suppressToolError;
    if (!unchanged || suppressionChanged) {
      await this.renderTool(node, parts, suppressToolError);
      this.activePartRefs.delete(key);
      this.activeToolGroupRefs.set(key, parts);
      this.activeToolErrorSuppression.set(key, suppressToolError);
    }
    return node;
  }

  private insertActiveNode(node: HTMLElement): void {
    if (!this.activeBody) return;
    this.activeBody.insertBefore(
      node,
      this.activeTailStatus?.parentElement === this.activeBody
        ? this.activeTailStatus
        : null,
    );
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

  private ensureTailStatus(
    presentation: AgentConversationPresentation,
  ): HTMLElement {
    let status = this.activeTailStatus;
    if (!status) {
      status = this.activeRoot.createDiv({
        cls: "systemsculpt-agent-tail-status",
        attr: {
          role: "status",
          "aria-live": "polite",
          "aria-atomic": "true",
        },
      });
      status.createSpan({ cls: "systemsculpt-agent-tail-status-icon" });
      status.createSpan({ cls: "systemsculpt-agent-tail-status-label" });
      this.activeTailStatus = status;
    }
    status.className =
      `systemsculpt-agent-tail-status is-${presentation.phase}`;
    const statusChanged =
      status.dataset.status !== presentation.activityStatus;
    if (statusChanged) {
      status.dataset.status = presentation.activityStatus;
      status.setAttribute(
        "aria-label",
        `Agent status: ${presentation.activityStatus}`,
      );
      status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-label")
        ?.setText(presentation.activityStatus);
    }
    const icon = status.querySelector<HTMLElement>(
      ".systemsculpt-agent-tail-status-icon",
    );
    const iconName = presentation.phase === "cancelled"
      ? "circle-stop"
      : presentation.phase === "failed"
        ? "circle-alert"
        : presentation.phase === "awaiting-approval"
          ? "shield-question"
          : "loader-circle";
    if (icon && icon.dataset.iconState !== iconName) {
      setIcon(icon, iconName);
      icon.dataset.iconState = iconName;
    }
    icon?.classList.toggle(
      "is-animated",
      presentation.busy && presentation.phase !== "awaiting-approval",
    );
    status.setAttribute(
      "role",
      presentation.phase === "failed" ? "alert" : "status",
    );
    status.setAttribute(
      "aria-live",
      presentation.phase === "failed" ? "assertive" : "polite",
    );
    return status;
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
    this.liveMarkdown.clear();
    this.activeRoot.empty();
    this.activeTurn = null;
    this.activeBody = null;
    this.activeTurnId = null;
    this.activeTailStatus = null;
    this.activeNodes.clear();
    this.activePartRefs.clear();
    this.activeToolGroupRefs.clear();
    this.activeToolErrorSuppression.clear();
    this.element.setAttribute("aria-busy", "false");
  }

  public showCompletedRenderFallback(): void {
    this.element.setAttribute("aria-busy", "false");
    if (this.activeRoot.querySelector(".systemsculpt-agent-render-fallback")) return;
    this.activeRoot.createDiv({
      cls: "systemsculpt-agent-render-fallback systemsculpt-agent-banner is-error",
      text: "The response completed, but part of this chat could not be displayed. Reopen the chat to try again.",
      attr: {
        role: "alert",
        "aria-live": "assertive",
      },
    });
  }

  /*
   * Stable part nodes are reconciled above. Only the changed part subtree is
   * refreshed, so adding a tool does not remount earlier text or disclosures.
   */
  private async renderPart(
    node: HTMLElement,
    part: AgentPart,
    previousPart?: AgentPart,
    suppressToolError = false,
  ): Promise<void> {
    if (part.kind === "text") {
      node.className = "systemsculpt-agent-part is-text";
      node.classList.toggle("is-streaming", part.state === "streaming");
      if (part.state === "streaming") {
        this.liveMarkdown.stream(node, part.markdown);
        return;
      }
      await this.liveMarkdown.settle(node, part.markdown);
      return;
    }
    if (
      part.kind === "reasoning"
      && previousPart?.kind === "reasoning"
      && await this.updateReasoning(node, part)
    ) {
      return;
    }
    if (part.kind === "tool") {
      await this.renderTool(node, part, suppressToolError);
      return;
    }
    node.empty();
    node.className = `systemsculpt-agent-part is-${part.kind}`;
    switch (part.kind) {
      case "reasoning": {
        await this.renderReasoning(
          node,
          part.summary,
          part.state === "streaming",
        );
        return;
      }
      case "error": {
        node.setAttrs({ role: "alert", "aria-live": "assertive" });
        const errorIcon = node.createSpan({ cls: "systemsculpt-agent-error-icon" });
        setIcon(errorIcon, "circle-alert");
        const copy = node.createDiv({ cls: "systemsculpt-agent-error-copy" });
        const presented = presentAgentError(part.error, part.retryable);
        copy.createEl("strong", {
          cls: "systemsculpt-agent-error-heading",
          text: presented.heading,
        });
        copy.createDiv({
          cls: "systemsculpt-agent-error-message",
          text: presented.message,
        });
        if (part.retryable && part.retryMessageId && this.options.onRetryFailedTurn) {
          const retry = createUiAction(copy, {
            label: "Retry",
            testId: "chat.turn.retry-failed",
            tone: "primary",
            size: "small",
          });
          retry.addClass("systemsculpt-agent-error-retry");
          retry.onclick = () => void this.options.onRetryFailedTurn?.(part.retryMessageId!);
        }
        return;
      }
      default:
        return;
    }
  }

  public override onunload(): void {
    this.renderingEnabled = false;
    this.lifecycleGeneration += 1;
    this.renderGeneration += 1;
    this.liveMarkdown.clear();
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    for (const timer of this.copyFeedbackTimers.values()) ownerWindow.clearTimeout(timer);
    this.copyFeedbackTimers.clear();
    this.historyRows.clear();
    this.clearInlineEditorShortcutGuard();
    this.clearSuppressedEditorKeyup();
  }

  public override onload(): void {
    this.renderingEnabled = true;
    this.lifecycleGeneration += 1;
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
    icon.dataset.iconState = streaming ? "streaming" : "complete";
    icon.classList.toggle("is-animated", streaming);
    header.createEl("strong", { text: streaming ? "Thinking" : "Reasoning" });
    const body = details.createDiv({ cls: "systemsculpt-agent-reasoning-body" });
    if (streaming) {
      this.liveMarkdown.stream(body, summary);
      return;
    }
    if (summary.trim()) await this.renderMarkdown(summary, body);
  }

  private async updateReasoning(
    node: HTMLElement,
    current: Extract<AgentPart, { kind: "reasoning" }>,
  ): Promise<boolean> {
    const details = node.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details");
    const header = details?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-header");
    const icon = header?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-icon");
    const label = header?.querySelector<HTMLElement>("strong");
    const body = details?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-body");
    if (!details || !header || !icon || !label || !body) return false;

    const streaming = current.state === "streaming";
    node.className = "systemsculpt-agent-part is-reasoning";
    node.classList.toggle("is-streaming", streaming);
    header.setAttribute("aria-label", streaming ? "Thinking summary" : "Reasoning summary");
    label.setText(streaming ? "Thinking" : "Reasoning");
    const iconState = streaming ? "streaming" : "complete";
    if (icon.dataset.iconState !== iconState) {
      setIcon(icon, streaming ? "loader-circle" : "sparkles");
      icon.dataset.iconState = iconState;
    }
    icon.classList.toggle("is-animated", streaming);
    if (current.state === "streaming") {
      this.liveMarkdown.stream(body, current.summary);
      return true;
    }
    await this.liveMarkdown.settle(body, current.summary);
    return true;
  }

  private async renderTool(
    node: HTMLElement,
    partOrParts: AgentToolPart | readonly AgentToolPart[],
    suppressToolError = false,
  ): Promise<void> {
    const parts = Array.isArray(partOrParts) ? partOrParts : [partOrParts];
    const part = parts[0];
    if (!part) return;
    node.className = `systemsculpt-agent-part is-tool is-${part.state}`;
    node.classList.toggle("is-grouped", parts.length > 1);
    if (parts.length > 1) {
      node.dataset.toolCount = String(parts.length);
    } else {
      delete node.dataset.toolCount;
    }
    const presentation = presentAgentToolGroup(parts);
    let shell = node.querySelector<HTMLElement>(":scope > .systemsculpt-agent-tool");
    let header = shell?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-header",
    ) ?? null;
    let icon = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-icon",
    ) ?? null;
    let label = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-label",
    ) ?? null;
    let summary = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-summary",
    ) ?? null;
    let state = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-state",
    ) ?? null;
    let support = shell?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-support",
    ) ?? null;
    if (!shell || !header || !icon || !label || !summary || !state || !support) {
      node.empty();
      shell = node.createDiv({ cls: "systemsculpt-agent-tool" });
      header = shell.createDiv({ cls: "systemsculpt-agent-tool-header" });
      icon = header.createSpan({ cls: "systemsculpt-agent-tool-icon" });
      label = header.createEl("strong", {
        cls: "systemsculpt-agent-tool-label",
      });
      summary = header.createSpan({
        cls: "systemsculpt-agent-tool-summary",
      });
      state = header.createSpan({ cls: "systemsculpt-agent-tool-state" });
      support = shell.createDiv({ cls: "systemsculpt-agent-tool-support" });
    }

    const ariaLabel = [
      presentation.label,
      presentation.summary,
      presentation.stateLabel,
    ].filter(Boolean).join(", ");
    if (header.getAttribute("aria-label") !== ariaLabel) {
      header.setAttribute("aria-label", ariaLabel);
    }
    if (icon.dataset.iconState !== presentation.icon) {
      setIcon(icon, presentation.icon);
      icon.dataset.iconState = presentation.icon;
    }
    icon.classList.toggle("is-animated", presentation.animated);
    if (label.textContent !== presentation.label) label.setText(presentation.label);
    if (presentation.summary) {
      if (summary.textContent !== presentation.summary) summary.setText(presentation.summary);
      summary.toggleAttribute("hidden", false);
    } else {
      if (summary.textContent) summary.setText("");
      summary.toggleAttribute("hidden", true);
    }
    if (state.textContent !== presentation.stateLabel) state.setText(presentation.stateLabel);

    support.empty();
    node.querySelectorAll(":scope > .systemsculpt-agent-approval")
      .forEach((approval) => approval.remove());
    if (parts.length === 1 && part.error && !suppressToolError) {
      support.createDiv({
        cls: "systemsculpt-agent-tool-error",
        text: presentAgentErrorMessage(
          part.error.message,
          part.error.retryable === true,
        ),
        attr: { role: "alert" },
      });
    }
    if (
      parts.length === 1
      && part.location === "vault"
      && part.state === "approval-required"
      && part.approvalId
    ) {
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
        testId: "chat.approval.deny",
        size: "small",
      });
      deny.setAttr("data-focus-key", "tool-deny");
      const approve = createUiAction(actions, {
        label: "Allow once",
        testId: "chat.approval.allow-once",
        tone: "primary",
        size: "small",
      });
      approve.setAttr("data-focus-key", "tool-allow-once");
      deny.onclick = () => void this.options.onApprove(part.approvalId!, false);
      approve.onclick = () => void this.options.onApprove(part.approvalId!, true);
      if (presentation.canonicalName !== "trash") {
        const allowForChat = createUiAction(actions, {
          label: "Allow for chat",
          testId: "chat.approval.allow-for-chat",
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
    if (!artifact.path?.trim()) return;
    const actions = card.createDiv({ cls: "systemsculpt-agent-artifact-actions" });
    const open = button(actions, "chat.tool.file.open", "Open", "arrow-up-right");
    open.onclick = () => void this.options.onOpenArtifact(artifact);
    const copyPath = button(actions, "chat.tool.file.copy-path", "Copy path", "copy");
    copyPath.setAttrs({ "aria-label": "Copy path", "aria-live": "polite" });
    copyPath.onclick = () => void this.copyArtifactPath(copyPath, artifact);
  }

  private historicalToolPart(tool: ToolCall): AgentToolPart {
    const fn = readManagedToolCallFunction(tool);
    const success = tool.state === "completed" && tool.result?.success === true;
    let input: unknown = {};
    let paths: string[] = [];
    try {
      input = JSON.parse(fn?.arguments || "{}");
      if (fn) {
        paths = success
          ? collectToolArtifactPaths(fn.name, input as Record<string, unknown>, tool.result?.data)
          : collectSuccessfulToolArtifactPaths(fn.name, tool.result?.data);
      }
    } catch {
      // Malformed input is already represented by the durable failed tool state.
      input = fn?.arguments ?? {};
    }
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
      name: fn?.name ?? "unknown_tool",
      location: isServerExecutedManagedToolCall(tool) ? "server" : "vault",
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
        testId: "chat.turn.copy",
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
        testId: "chat.turn.edit-resubmit",
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
      testId: "chat.editor.cancel",
      size: "small",
    });
    const save = createUiAction(actions, {
      label: "Save and resubmit",
      testId: "chat.editor.save-resubmit",
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
    const lifecycleGeneration = this.lifecycleGeneration;
    const staging = createSurfaceElement(parent.ownerDocument, "div");
    await MarkdownRenderer.render(this.options.app, markdown, staging, this.options.sourcePath(), this);
    if (
      !this.renderingEnabled
      || lifecycleGeneration !== this.lifecycleGeneration
    ) {
      return;
    }
    this.enhanceCodeBlocks(staging);
    parent.replaceChildren(...Array.from(staging.childNodes));
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
        testId: "chat.code.copy",
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

  private async copyArtifactPath(
    button: HTMLButtonElement,
    artifact: AgentArtifact,
  ): Promise<void> {
    const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
    button.dataset.copyAttempt = attempt;
    let copied = false;
    try {
      copied = await this.options.onCopyArtifactPath(artifact) === true;
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
      label: copied ? "Path copied" : "Could not copy path. Try again",
      icon: copied ? "check" : "circle-alert",
    });
    button.setAttribute(
      "aria-label",
      copied ? "Path copied" : "Could not copy path. Try again",
    );

    const timer = ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected) return;
      button.removeClass("is-copied", "is-copy-failed");
      updateUiAction(button, { label: "Copy path", icon: "copy" });
      button.setAttribute("aria-label", "Copy path");
    }, copied ? 1_800 : 3_000);
    this.copyFeedbackTimers.set(button, timer);
  }
}
