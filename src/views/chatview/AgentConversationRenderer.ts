import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import type { ChatMessage, MessagePart } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import { collectSuccessfulToolArtifactPaths, collectToolArtifactPaths } from "../../utils/toolArtifacts";
import { splitToolName } from "../../utils/toolPolicy";
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
import { presentAgentTool } from "./AgentToolPresentation";
import {
  presentMessageContent,
  type PresentedMessageAttachment,
  type PresentedMessageContent,
} from "./ChatMessagePresentation";

export type AgentConversationRendererOptions = Readonly<{
  app: App;
  sourcePath: () => string;
  onApprove: (approvalId: string, approved: boolean, rememberForChat?: boolean) => void | Promise<void>;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  onCopyArtifactPath: (artifact: AgentArtifact) => void | Promise<void>;
  onRetryMessage?: (messageId: string) => void | Promise<void>;
  onCopyText?: (text: string) => void | Promise<void>;
}>;

function button(parent: HTMLElement, label: string, icon?: string): HTMLButtonElement {
  const element = parent.createEl("button", {
    cls: "clickable-icon systemsculpt-agent-inline-button",
    attr: { type: "button", "aria-label": label, title: label },
  });
  if (icon) setIcon(element, icon);
  else element.setText(label);
  return element;
}

const MAX_TOOL_DETAIL_CHARS = 20_000;

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
    || presentedContent.some((content) => content.attachments.length > 0);
  const hasTools = message.role === "assistant" && (usesOrderedParts
    ? orderedParts.some((part) => part.type === "tool_call")
    : (message.tool_calls?.length ?? 0) > 0);
  const isToolOnly = hasTools && !hasVisibleContent;
  return { hasVisibleContent, hasTools, isToolOnly, copyText };
}

function safeJson(value: unknown): string {
  let serialized: string;
  if (typeof value === "string") {
    try { serialized = JSON.stringify(JSON.parse(value), null, 2); } catch { serialized = value; }
  } else {
    try { serialized = JSON.stringify(value, null, 2); } catch { serialized = String(value ?? ""); }
  }
  if (serialized.length <= MAX_TOOL_DETAIL_CHARS) return serialized;
  return `${serialized.slice(0, MAX_TOOL_DETAIL_CHARS)}\n… output shortened`;
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
  private renderGeneration = 0;

  constructor(parent: HTMLElement, private readonly options: AgentConversationRendererOptions) {
    super();
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-conversation",
      attr: {
        role: "log",
        "aria-label": "SystemSculpt conversation",
        "aria-live": "off",
        "aria-relevant": "additions text",
      },
    });
    this.historyRoot = this.element.createDiv({ cls: "systemsculpt-agent-history" });
    this.activeRoot = this.element.createDiv({ cls: "systemsculpt-agent-active-run" });
  }

  public async renderHistory(messages: readonly ChatMessage[]): Promise<void> {
    const generation = ++this.renderGeneration;
    this.historyRoot.empty();
    for (const message of messages) {
      if (generation !== this.renderGeneration) return;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const content = presentMessageContent(message.content);
      const orderedParts = message.role === "assistant" ? this.orderedDurableParts(message) : [];
      const semantics = classifyHistoricalTurn(message, content, orderedParts);
      if (!semantics.hasVisibleContent && !semantics.hasTools) continue;
      const row = this.historyRoot.createDiv({
        cls: `systemsculpt-agent-turn is-${message.role}${semantics.isToolOnly ? " is-tool-only" : ""}`,
        attr: { "data-message-id": message.message_id },
      });
      const body = row.createDiv({ cls: "systemsculpt-agent-turn-body" });
      if (orderedParts.length > 0) {
        for (const part of orderedParts) await this.renderHistoricalPart(body, part);
      } else {
        if (content.markdown.trim()) await this.renderMarkdown(content.markdown, body);
        if (content.attachments.length > 0) this.renderMessageAttachments(body, content.attachments);
      }
      if (orderedParts.length === 0 && message.role === "assistant" && message.tool_calls) {
        for (const tool of message.tool_calls) {
          await this.renderHistoricalTool(body, tool);
        }
      }
      if (!semantics.isToolOnly) {
        this.renderMessageActions(row, message, semantics.copyText);
      }
    }
  }

  /**
   * Durable message parts are the chronology source for current chats. The
   * aggregate content/tool_calls fields remain only as a legacy fallback.
   */
  private orderedDurableParts(message: ChatMessage): MessagePart[] {
    if (!message.messageParts?.length) return [];
    return message.messageParts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => part.type === "content" || part.type === "tool_call")
      .sort((left, right) => left.part.timestamp - right.part.timestamp || left.index - right.index)
      .map(({ part }) => part);
  }

  private async renderHistoricalPart(parent: HTMLElement, part: MessagePart): Promise<void> {
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

  public async renderActive(snapshot: AgentConversationSnapshot): Promise<void> {
    this.element.setAttribute("aria-busy", String(snapshot.status === "running" || snapshot.status === "waiting"));
    const wanted = new Set<string>();
    for (const part of [...snapshot.parts].sort((left, right) => left.order - right.order)) {
      const key = `${part.kind}:${part.id}`;
      wanted.add(key);
      let node = this.activeNodes.get(key);
      if (!node) {
        node = this.activeRoot.createDiv({ cls: `systemsculpt-agent-part is-${part.kind}` });
        node.dataset.partKey = key;
        this.activeNodes.set(key, node);
      }
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const preservedFocusKey = activeElement && node.contains(activeElement)
        ? activeElement.dataset.focusKey
        : undefined;
      if (this.activePartRefs.get(key) !== part) {
        await this.renderPart(node, part);
        this.activePartRefs.set(key, part);
      }
      this.activeRoot.appendChild(node);
      if (preservedFocusKey) {
        node.querySelector<HTMLElement>(`[data-focus-key="${preservedFocusKey}"]`)?.focus();
      }
    }
    for (const [key, node] of this.activeNodes) {
      if (!wanted.has(key)) {
        node.remove();
        this.activeNodes.delete(key);
        this.activePartRefs.delete(key);
      }
    }
  }

  public clearActive(): void {
    this.activeRoot.empty();
    this.activeNodes.clear();
    this.activePartRefs.clear();
    this.element.setAttribute("aria-busy", "false");
  }

  private async renderPart(node: HTMLElement, part: AgentPart): Promise<void> {
    const previousToolDetails = part.kind === "tool"
      ? node.querySelector<HTMLDetailsElement>(".systemsculpt-agent-tool-details")
      : null;
    const previousToolOpen = previousToolDetails?.open;
    node.empty();
    node.className = `systemsculpt-agent-part is-${part.kind}`;
    switch (part.kind) {
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
        await this.renderTool(node, part, previousToolOpen);
        return;
      case "error": {
        const errorIcon = node.createSpan();
        setIcon(errorIcon, "circle-alert");
        const copy = node.createDiv();
        copy.createEl("strong", { text: "Agent stopped" });
        copy.createDiv({ text: part.error.message });
        if (part.retryable && part.retryMessageId && this.options.onRetryMessage) {
          const retry = copy.createEl("button", {
            cls: "mod-cta systemsculpt-agent-error-retry",
            text: "Retry",
            attr: { type: "button" },
          });
          retry.onclick = () => void this.options.onRetryMessage?.(part.retryMessageId!);
        }
        return;
      }
      default:
        return;
    }
  }

  private async renderTool(
    node: HTMLElement,
    part: AgentToolPart,
    preservedOpen?: boolean,
  ): Promise<void> {
    node.classList.add(`is-${part.state}`);
    const presentation = presentAgentTool(part);
    const details = node.createEl("details", { cls: "systemsculpt-agent-tool-details" });
    details.open = preservedOpen ?? presentation.openByDefault;
    details.classList.toggle("is-static", !presentation.hasDetails);
    const header = details.createEl("summary", {
      cls: "systemsculpt-agent-tool-header",
      attr: {
        "aria-label": `${presentation.label}: ${presentation.stateLabel}`,
        "data-focus-key": "tool-summary",
        tabindex: "0",
      },
    });
    header.tabIndex = 0;
    const disclosure = header.createSpan({ cls: "systemsculpt-agent-tool-disclosure" });
    setIcon(disclosure, "chevron-right");
    const icon = header.createSpan({ cls: "systemsculpt-agent-tool-icon" });
    setIcon(icon, presentation.icon);
    icon.classList.toggle("is-animated", presentation.animated);
    header.createEl("strong", { text: presentation.label });
    if (presentation.summary) {
      header.createSpan({ cls: "systemsculpt-agent-tool-summary", text: presentation.summary });
    }
    header.createSpan({ cls: "systemsculpt-agent-tool-state", text: presentation.stateLabel });

    const detailBody = details.createDiv({ cls: "systemsculpt-agent-tool-details-body" });
    if (typeof part.input !== "undefined" || part.inputText) {
      detailBody.createDiv({ cls: "systemsculpt-agent-tool-details-label", text: "Input" });
      const pre = detailBody.createEl("pre");
      pre.createEl("code", { text: part.inputText || safeJson(part.input) });
    }
    if (typeof part.output?.data !== "undefined") {
      detailBody.createDiv({ cls: "systemsculpt-agent-tool-details-label", text: "Result" });
      const pre = detailBody.createEl("pre");
      pre.createEl("code", { text: safeJson(part.output.data) });
    }
    if (part.error) {
      detailBody.createDiv({ cls: "systemsculpt-agent-tool-error", text: part.error.message });
    }
    if (part.state === "approval-required" && part.approvalId) {
      const approval = node.createDiv({ cls: "systemsculpt-agent-approval" });
      approval.createDiv({ cls: "systemsculpt-agent-approval-copy", text: "Allow this change in your vault?" });
      const actions = approval.createDiv({ cls: "systemsculpt-agent-approval-actions" });
      const deny = actions.createEl("button", {
        cls: "mod-muted",
        text: "Deny",
        attr: { type: "button", "data-focus-key": "tool-deny" },
      });
      const approve = actions.createEl("button", {
        cls: "mod-cta",
        text: "Allow once",
        attr: { type: "button", "data-focus-key": "tool-allow-once" },
      });
      deny.onclick = () => void this.options.onApprove(part.approvalId!, false);
      approve.onclick = () => void this.options.onApprove(part.approvalId!, true);
      if (presentation.canonicalName !== "trash") {
        const allowForChat = actions.createEl("button", {
          cls: "mod-muted",
          text: "Allow for chat",
          attr: { type: "button", "data-focus-key": "tool-allow-chat" },
        });
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
    for (const artifact of part.output?.artifacts ?? []) this.renderArtifact(detailBody, artifact);
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

  private async renderHistoricalTool(parent: HTMLElement, tool: ToolCall): Promise<void> {
    let input: unknown = {};
    try { input = JSON.parse(tool.request.function.arguments || "{}"); } catch { input = tool.request.function.arguments; }
    const success = tool.state === "completed" && tool.result?.success === true;
    const paths = artifactPaths(tool, success);
    const state = historicalToolState(tool, success);
    const summary = tool.result?.data && typeof tool.result.data === "object"
      && typeof (tool.result.data as { summary?: unknown }).summary === "string"
      ? (tool.result.data as { summary: string }).summary
      : paths.join(", ");
    const node = parent.createDiv({ cls: "systemsculpt-agent-part is-tool" });
    await this.renderTool(node, {
      id: tool.id,
      order: tool.timestamp,
      kind: "tool",
      messageId: tool.messageId,
      callId: tool.id,
      name: tool.request.function.name,
      location: "vault",
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
    });
  }

  private renderMessageActions(row: HTMLElement, message: ChatMessage, text: string): void {
    const canCopy = text.length > 0 && Boolean(this.options.onCopyText);
    const canRetry = message.role === "user" && Boolean(this.options.onRetryMessage);
    if (!canCopy && !canRetry) return;

    const actions = row.createDiv({ cls: "systemsculpt-agent-message-actions" });
    if (canCopy) {
      const copy = button(actions, "Copy", "copy");
      copy.onclick = () => void this.options.onCopyText?.(text);
    }
    if (canRetry) {
      const retry = button(actions, "Retry from here", "rotate-ccw");
      retry.onclick = () => void this.options.onRetryMessage?.(message.message_id);
    }
  }

  private renderMessageAttachments(parent: HTMLElement, attachments: readonly PresentedMessageAttachment[]): void {
    const list = parent.createDiv({
      cls: "systemsculpt-agent-message-attachments",
      attr: { "aria-label": "Message attachments" },
    });
    for (const attachment of attachments) {
      const item = list.createDiv({ cls: `systemsculpt-agent-message-attachment is-${attachment.kind}` });
      if (attachment.kind === "image" && attachment.url) {
        item.createEl("img", {
          attr: { src: attachment.url, alt: attachment.label, loading: "lazy" },
        });
      } else {
        const icon = item.createSpan({ cls: "systemsculpt-agent-message-attachment-icon" });
        setIcon(icon, "file-text");
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
  }
}
