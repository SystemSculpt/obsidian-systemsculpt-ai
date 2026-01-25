import { Component } from "obsidian";
import type { ToolCall, ToolCallResult } from "../../../types/toolCalls";
import type { MessageRenderer } from "../MessageRenderer";
import {
  formatToolDisplayName,
  getFunctionDataFromToolCall,
} from "../../../utils/toolDisplay";
import { extractPrimaryPathArg, isMutatingTool, requiresUserApproval, splitToolName } from "../../../utils/toolPolicy";
import { isWriteOrEditTool, renderOperationsInlinePreview, prepareWriteEditPreview, prepareOperationsPreview } from "../../../utils/toolCallPreview";
import { DiffViewer } from "../../../components/DiffViewer";
import { errorLogger } from "../../../utils/errorLogger";
import { rebuildTreeConnectors, seedTreeLine, TREE_HEADER_SYMBOL, setBulletSymbol } from "../utils/treeConnectors";

type ActivityType = "explore" | "mutate" | "run";
type GroupStatus = "active" | "failed" | "denied" | "completed";

interface ToolCallGroup {
  messageEl: HTMLElement;
  wrapper: HTMLElement;
  bulletEl: HTMLElement;
  titleEl: HTMLElement;
  linesContainer: HTMLElement;
  lines: Map<string, HTMLElement>;
  toolCalls: Map<string, ToolCall>;
}

interface ToolCallDescriptor {
  label: string;
  detail: string;
  allowAggregation: boolean;
}

interface AggregationBucket {
  key: string;
  label: string;
  allowAggregation: boolean;
  lines: HTMLElement[];
  details: string[];
}

const ACTIVITY_LABELS: Record<ActivityType, Record<GroupStatus, string>> = {
  explore: {
    active: "Exploring",
    failed: "Exploration Failed",
    denied: "Exploration Denied",
    completed: "Explored",
  },
  mutate: {
    active: "Changing",
    failed: "Change Failed",
    denied: "Change Denied",
    completed: "Changed",
  },
  run: {
    active: "Running",
    failed: "Command Failed",
    denied: "Command Denied",
    completed: "Ran",
  },
};

const BULLET_SYMBOLS: Record<GroupStatus, string> = {
  active: "",
  failed: "x",
  denied: "!",
  completed: TREE_HEADER_SYMBOL,
};

export class ToolCallTreeRenderer extends Component {
  private parent: MessageRenderer;
  private groups = new WeakMap<HTMLElement, ToolCallGroup>();
  private lineToGroup = new WeakMap<HTMLElement, ToolCallGroup>();

  constructor(parent: MessageRenderer) {
    super();
    this.parent = parent;
  }

  /** Get the ToolCallManager from the parent MessageRenderer */
  private getToolCallManager(): import("../ToolCallManager").ToolCallManager | undefined {
    return this.parent.getToolCallManager?.();
  }

  /** Get the ChatView from the ToolCallManager */
  private getChatView(): any {
    return this.getToolCallManager()?.["chatView"];
  }

  /** Get the trusted tool names from the current chat session */
  private getTrustedToolNames(): Set<string> {
    return this.getChatView()?.trustedToolNames ?? new Set<string>();
  }

  private getAutoApproveAllowlist(): string[] {
    return (this.getChatView()?.plugin?.settings?.mcpAutoAcceptTools || []).slice();
  }

  private getRequireDestructiveApproval(): boolean {
    const raw = this.getChatView()?.plugin?.settings?.toolingRequireApprovalForDestructiveTools;
    return raw !== false;
  }

  /** Check if a tool call requires user approval */
  private toolRequiresApproval(toolCall: ToolCall): boolean {
    const toolName = toolCall.request?.function?.name ?? "";
    return requiresUserApproval(toolName, {
      trustedToolNames: this.getTrustedToolNames(),
      requireDestructiveApproval: this.getRequireDestructiveApproval(),
      autoApproveAllowlist: this.getAutoApproveAllowlist(),
    });
  }

  /** Get the App instance from the parent MessageRenderer */
  private getApp(): import("obsidian").App | undefined {
    return this.parent.getApp?.();
  }

  private notifyDomContentChanged(target: HTMLElement): void {
    try {
      target.dispatchEvent(new CustomEvent("systemsculpt-dom-content-changed", { bubbles: true }));
    } catch {}
  }

  /**
   * Render a tool call inside the tree summary. Returns the concrete line element used
   * for part-tracking, while the enclosing group container is reused across calls.
   */
  public renderToolCallAsContent(
    messageEl: HTMLElement,
    toolCall: ToolCall,
    index: number,
    insertAfterElement?: HTMLElement | null,
    partId?: string,
    _isActivelyStreaming: boolean = false
  ): HTMLElement {
    const group = this.ensureGroup(messageEl, insertAfterElement ?? null);
    const resolvedPartId = partId ?? toolCall.id;
    const line = this.ensureLine(group, resolvedPartId, index);

    group.toolCalls.set(resolvedPartId, toolCall);
    this.lineToGroup.set(line, group);

    this.populateLine(line, toolCall, index);
    this.refreshLineOrder(group);
    this.rebuildAggregations(group);
    this.updateGroupState(group);

    this.maybeRenderVerboseDetails(line, toolCall);

    this.safeLog("render", toolCall, { messageId: toolCall.messageId });

    this.notifyDomContentChanged(line);

    if (typeof (this.parent as any)?.refreshStructuredBlocks === "function") {
      (this.parent as any).refreshStructuredBlocks(messageEl);
    }

    return line;
  }

  /**
   * Update an existing rendered line when the tool call state changes.
   */
  public updateInlineDisplay(lineEl: HTMLElement, toolCall: ToolCall): void {
    const group = this.lineToGroup.get(lineEl);
    if (!group) {
      return;
    }

    const partId = lineEl.dataset.partId ?? toolCall.id;
    if (partId) {
      group.toolCalls.set(partId, toolCall);
    }

    const order = Number(lineEl.dataset.order ?? 0);

    this.populateLine(lineEl, toolCall, order);
    this.refreshLineOrder(group);
    this.rebuildAggregations(group);
    this.updateGroupState(group);
    this.maybeRenderVerboseDetails(lineEl, toolCall);

    this.safeLog("update", toolCall, { messageId: toolCall.messageId });

    this.notifyDomContentChanged(lineEl);

    const messageEl = group?.messageEl ?? lineEl.closest(".systemsculpt-message");
    if (messageEl && typeof (this.parent as any)?.refreshStructuredBlocks === "function") {
      (this.parent as any).refreshStructuredBlocks(messageEl as HTMLElement);
    }
  }

  /**
   * Remove a tool call line from the tree, pruning the whole group when empty.
   */
  public removeToolCallElement(lineEl: HTMLElement): void {
    const group = this.lineToGroup.get(lineEl);
    if (!group) {
      lineEl.remove();
      return;
    }

    const partId = lineEl.dataset.partId;
    if (partId) {
      group.toolCalls.delete(partId);
      group.lines.delete(partId);
    }

    this.lineToGroup.delete(lineEl);
    lineEl.remove();

    this.refreshLineOrder(group);
    this.rebuildAggregations(group);
    this.updateGroupState(group);

    this.notifyDomContentChanged(group.wrapper);

    if (group.lines.size === 0) {
      group.wrapper.remove();
      this.groups.delete(group.wrapper);
      this.safeLog("group-cleared", undefined, {
        messageId: group.messageEl.dataset.messageId,
      });
    }

    if (typeof (this.parent as any)?.refreshStructuredBlocks === 'function') {
      (this.parent as any).refreshStructuredBlocks(group.messageEl);
    }
  }

  /**
   * Return the anchor element that should be used for chronological ordering of
   * subsequent message parts (the enclosing group wrapper).
   */
  public getAnchorElement(lineEl: HTMLElement): HTMLElement | null {
    const group = this.lineToGroup.get(lineEl);
    return group?.wrapper ?? null;
  }

  /**
   * Render a tool call inline within a provided container (for chronological inline display).
   * Shows a clean, user-friendly summary: status + action + target (e.g., "Read src/file.ts")
   */
  public renderToolCallInline(container: HTMLElement, toolCall: ToolCall, index: number): void {
    const descriptor = this.getToolCallDescriptor(toolCall);

    // Single line: status + label + detail
    const lineEl = container.createDiv({ cls: 'systemsculpt-inline-tool-line' });

    // Status indicator
    const statusEl = lineEl.createSpan({ cls: 'systemsculpt-inline-tool-status' });
    this.updateInlineStatus(statusEl, toolCall.state);

    // Action + target (e.g., "Read src/utils/file.ts")
    const summaryText = descriptor.detail
      ? `${descriptor.label} ${descriptor.detail}`
      : descriptor.label;
    lineEl.createSpan({ cls: 'systemsculpt-inline-tool-summary', text: summaryText });

    // Approval buttons for pending destructive tool calls
    const needsApproval = toolCall.state === 'pending' && this.toolRequiresApproval(toolCall);
    if (needsApproval) {
      const actionsEl = lineEl.createDiv({ cls: 'systemsculpt-inline-tool-actions' });
      this.renderApprovalButtons(actionsEl, toolCall);

      // Show preview of changes for pending destructive tools
      void this.renderApprovalPreview(container, toolCall);
    }

    // Error message only (if failed/denied)
    if ((toolCall.state === 'failed' || toolCall.state === 'denied') && toolCall.result?.error) {
      const errorEl = container.createDiv({ cls: 'systemsculpt-inline-tool-error' });
      const errorMsg = toolCall.result.error.message ?? 'Operation failed';
      errorEl.textContent = this.limitText(errorMsg, 80);
    }
  }

  /**
   * Render a preview of what changes will be made for pending destructive tool calls.
   * Shows diffs for write/edit, and file lists for move/trash.
   */
  private async renderApprovalPreview(container: HTMLElement, toolCall: ToolCall): Promise<void> {
    const fn = getFunctionDataFromToolCall(toolCall);
    if (!fn) return;

    const { canonicalName } = splitToolName(fn.name);
    const app = this.getApp();

    // Remove any existing preview to avoid duplicates
    const existingPreview = container.querySelector('.systemsculpt-approval-preview');
    existingPreview?.remove();

    const previewContainer = container.createDiv({ cls: 'systemsculpt-approval-preview' });

    try {
      if (canonicalName === 'write' || canonicalName === 'edit') {
        // Show diff preview for write/edit
        if (!app) return;
        const preview = await prepareWriteEditPreview(app, toolCall);
        if (!preview || !preview.diff) return;

        const diffContainer = previewContainer.createDiv({ cls: 'systemsculpt-approval-diff' });
        const viewer = new DiffViewer({
          container: diffContainer,
          diffResult: preview.diff,
          fileName: preview.path,
          maxContextLines: 3,
          showLineNumbers: true,
        });
        viewer.render();

      } else if (canonicalName === 'move' || canonicalName === 'trash') {
        // Show file operation preview
        const preview = prepareOperationsPreview(toolCall);
        if (!preview) return;

        const opsContainer = previewContainer.createDiv({ cls: 'systemsculpt-approval-ops' });
        const list = opsContainer.createEl('ul');

        if (preview.type === 'move') {
          for (const item of preview.items) {
            const li = list.createEl('li');
            const srcCode = li.createEl('code', { cls: 'ss-modal__inline-code' });
            srcCode.textContent = this.prettyPath(item.source);
            srcCode.setAttribute('title', item.source);
            li.createSpan({ text: ' → ' });
            const dstCode = li.createEl('code', { cls: 'ss-modal__inline-code' });
            dstCode.textContent = this.prettyPath(item.destination);
            dstCode.setAttribute('title', item.destination);
          }
        } else if (preview.type === 'trash') {
          for (const item of preview.items) {
            const li = list.createEl('li');
            const code = li.createEl('code', { cls: 'ss-modal__inline-code' });
            code.textContent = this.prettyPath(item.path);
            code.setAttribute('title', item.path);
          }
        }
      }
    } catch (error) {
      this.safeLog('approval-preview-error', toolCall, { error });
    }
  }

  /**
   * Update the inline status indicator based on tool call state.
   */
  private updateInlineStatus(statusEl: HTMLElement, state: ToolCall['state'] | undefined): void {
    statusEl.className = 'systemsculpt-inline-tool-status';

    switch (state) {
      case 'completed':
        statusEl.classList.add('is-success');
        statusEl.textContent = 'Done';
        break;
      case 'failed':
        statusEl.classList.add('is-error');
        statusEl.textContent = 'Failed';
        break;
      case 'denied':
        statusEl.classList.add('is-error');
        statusEl.textContent = 'Denied';
        break;
      case 'executing':
        statusEl.classList.add('is-pending');
        statusEl.textContent = 'Running...';
        break;
      case 'pending':
      case 'approved':
        statusEl.classList.add('is-pending');
        statusEl.textContent = 'Pending';
        break;
      default:
        statusEl.textContent = '';
    }
  }

  private ensureGroup(messageEl: HTMLElement, insertAfterElement: HTMLElement | null): ToolCallGroup {
    const existingWrapper =
      insertAfterElement && (insertAfterElement.classList.contains("systemsculpt-tool-call-group")
        ? insertAfterElement
        : insertAfterElement.closest<HTMLElement>(".systemsculpt-tool-call-group"));

    if (existingWrapper) {
      const existingGroup = this.groups.get(existingWrapper);
      if (existingGroup && existingGroup.messageEl === messageEl) {
        return existingGroup;
      }
    }

    const wrapper = document.createElement("div");
    wrapper.classList.add("systemsculpt-chat-structured-block", "systemsculpt-tool-call-group", "systemsculpt-chat-tree", "systemsculpt-chat-tree--empty");
    wrapper.dataset.treeConnector = "group";

    const header = wrapper.createDiv({ cls: "systemsculpt-chat-structured-header" });
    header.dataset.treeConnector = "header";
    const bulletEl = header.createSpan({ cls: "systemsculpt-chat-structured-bullet" });
    const titleEl = header.createSpan({ cls: "systemsculpt-chat-structured-title" });

    const linesContainer = wrapper.createDiv({ cls: "systemsculpt-chat-structured-lines" });

    (this.parent as any).insertElementInOrder(messageEl, wrapper, insertAfterElement ?? null);

    const group: ToolCallGroup = {
      messageEl,
      wrapper,
      bulletEl,
      titleEl,
      linesContainer,
      lines: new Map(),
      toolCalls: new Map(),
    };
    this.groups.set(wrapper, group);
    this.notifyDomContentChanged(wrapper);
    return group;
  }

  private ensureLine(group: ToolCallGroup, partId: string, index: number): HTMLElement {
    const existing = group.lines.get(partId);
    if (existing) {
      existing.dataset.order = String(index);
      return existing;
    }

    const line = group.linesContainer.createDiv({
      cls: "systemsculpt-chat-structured-line systemsculpt-unified-part",
    });
    line.dataset.partId = partId;
    line.dataset.order = String(index);
    line.dataset.treeConnector = "end";

    line.createSpan({ cls: "systemsculpt-chat-structured-line-prefix" });
    line.createSpan({ cls: "systemsculpt-chat-structured-line-text", text: "" });
    line.createDiv({ cls: "systemsculpt-chat-structured-line-actions" });

    group.lines.set(partId, line);
    seedTreeLine(line, 1, true);
    this.notifyDomContentChanged(line);
    return line;
  }

  private populateLine(line: HTMLElement, toolCall: ToolCall, index: number): void {
    line.dataset.toolCallId = toolCall.id;
    line.dataset.state = toolCall.state ?? "pending";
    line.dataset.order = String(index);

    const descriptor = this.getToolCallDescriptor(toolCall);
    line.dataset.aggregateLabel = descriptor.label;
    line.dataset.aggregateDetail = descriptor.detail;
    line.dataset.allowAggregation = descriptor.allowAggregation ? "true" : "false";

    line.classList.remove("systemsculpt-chat-structured-line--shadow");
    line.style.removeProperty("display");

    this.renderLineText(line, descriptor.label, descriptor.detail);

    this.populateActions(line, toolCall);
  }

  private renderLineText(line: HTMLElement, label: string, detail: string): void {
    const textEl = line.querySelector<HTMLElement>(".systemsculpt-chat-structured-line-text");
    if (!textEl) {
      return;
    }

    textEl.textContent = "";

    const factory = textEl as any;
    const appendSpan = (cls: string, text: string) => {
      if (!text) return;
      if (factory.createSpan) {
        factory.createSpan({ cls, text });
      } else {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = text;
        textEl.appendChild(span);
      }
    };

    if (label) {
      appendSpan("systemsculpt-chat-structured-label", label);
    }

    if (detail) {
      if (label) {
        textEl.append(" ");
      }
      appendSpan("systemsculpt-chat-structured-detail", detail);
    }
  }

  /**
   * Render verbose, per-item details directly under a tool call line. Never truncates.
   */
  private maybeRenderVerboseDetails(line: HTMLElement, toolCall: ToolCall): void {
    try {
      // Clear prior details to avoid duplicates on updates
      Array.from(line.querySelectorAll(".systemsculpt-inline-ops, .systemsculpt-toolcall-details")).forEach((el) => el.remove());

      const fn = getFunctionDataFromToolCall(toolCall);
      if (!fn) return;
      const canonical = this.canonicalFunctionName(fn.name);

      // Use existing operations renderer for move/trash/create_folders
      if (/(^|_)(move|trash|create_folders)$/.test(canonical)) {
        void renderOperationsInlinePreview(line, toolCall);
        return;
      }

      // For read/list_items tools: do not materialize file contents or directory listings.
      // The line summary suffices; keep the UI minimal and consistent with the tree.
      if (/(^|_)(read|list_items)$/.test(canonical)) {
        return;
      }
    } catch (error) {
      this.safeLog("verbose-details-error", toolCall, { error });
    }
  }

  private refreshLineOrder(group: ToolCallGroup): void {
    const sortedLines = Array.from(group.lines.values()).sort((a, b) => {
      return Number(a.dataset.order ?? 0) - Number(b.dataset.order ?? 0);
    });
    for (const line of sortedLines) {
      group.linesContainer.appendChild(line);
    }
  }

  private rebuildAggregations(group: ToolCallGroup): void {
    const lines = Array.from(group.linesContainer.children) as HTMLElement[];

    for (const line of lines) {
      line.classList.remove("systemsculpt-chat-structured-line--shadow");
      line.style.removeProperty("display");
      line.dataset.treeHidden = "false";
    }

    const buckets = this.createAggregationBuckets(lines);
    const hiddenToolCallIds: string[] = [];
    const visibleToolCallIds: string[] = [];

    for (const bucket of buckets) {
      const primaryLine = bucket.lines[0];
      const originalDetails = bucket.details;
      const label = bucket.label;

      if (!label) {
        primaryLine.dataset.aggregateLabel = "";
      }

      if (!bucket.allowAggregation || bucket.lines.length === 1) {
        const detail = originalDetails[0] ?? "";
        this.renderLineText(primaryLine, label, detail);
        visibleToolCallIds.push(primaryLine.dataset.toolCallId ?? "");
        continue;
      }

      const aggregatedDetail = this.aggregateDetails(originalDetails);
      this.renderLineText(primaryLine, label, aggregatedDetail);
      visibleToolCallIds.push(primaryLine.dataset.toolCallId ?? "");

      for (const hiddenLine of bucket.lines.slice(1)) {
        hiddenLine.dataset.treeHidden = "true";
        hiddenLine.style.display = "none";
        hiddenToolCallIds.push(hiddenLine.dataset.toolCallId ?? "");
      }
    }

    const visibleLines = lines.filter((line) => line.style.display !== "none" && line.dataset.treeHidden !== "true" && !line.hidden);
    group.wrapper.classList.toggle("systemsculpt-chat-tree--empty", visibleLines.length === 0);
    rebuildTreeConnectors(group.linesContainer);
    this.safeLog("aggregate-lines", undefined, {
      messageId: group.messageEl?.dataset?.messageId,
      visibleLines: visibleLines.length,
      hiddenLines: hiddenToolCallIds.length,
      visibleToolCallIds: visibleToolCallIds.filter((id) => Boolean(id)),
      hiddenToolCallIds: hiddenToolCallIds.filter((id) => Boolean(id)),
    });
    this.safeLog("tree-connectors", undefined, {
      messageId: group.messageEl?.dataset?.messageId,
      visibleLines: visibleLines.length,
    });
  }

  private createAggregationBuckets(lines: HTMLElement[]): AggregationBucket[] {
    const buckets: AggregationBucket[] = [];
    const byKey = new Map<string, AggregationBucket>();

    for (const line of lines) {
      const label = line.dataset.aggregateLabel ?? "";
      const detail = line.dataset.aggregateDetail ?? "";
      const allowAggregation = line.dataset.allowAggregation === "true" && Boolean(label);

      if (!allowAggregation) {
        const uniqueKey = label ? `${label}:${buckets.length}` : `__${buckets.length}`;
        buckets.push({
          key: uniqueKey,
          label,
          allowAggregation: false,
          lines: [line],
          details: [detail],
        });
        continue;
      }

      const key = label.toLowerCase();
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = {
          key,
          label,
          allowAggregation: true,
          lines: [],
          details: [],
        };
        byKey.set(key, bucket);
        buckets.push(bucket);
      }

      bucket.lines.push(line);
      bucket.details.push(detail);
    }

    return buckets;
  }

  private aggregateDetails(details: string[]): string {
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const detail of details) {
      const normalized = this.singleLine(detail || "");
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(this.limitText(normalized, 120));
    }

    if (ordered.length === 0) {
      return "";
    }

    return this.singleLine(this.limitText(ordered.join(", "), 160));
  }

  private composeLineText(label: string, detail: string): string {
    const trimmedLabel = this.singleLine(label || "");
    const trimmedDetail = this.singleLine(detail || "");
    if (trimmedLabel && trimmedDetail) {
      return this.singleLine(`${trimmedLabel} ${trimmedDetail}`);
    }
    if (trimmedLabel) return trimmedLabel;
    return trimmedDetail;
  }

  private updateGroupState(group: ToolCallGroup): void {
    const calls = Array.from(group.toolCalls.values());
    if (calls.length === 0) {
      group.titleEl.textContent = "";
      setBulletSymbol(group.bulletEl, "");
      group.bulletEl.classList.remove("is-active", "is-failed", "is-denied");
      this.removeAllowAllButton(group);
      return;
    }

    const activity = this.computeActivity(calls);
    const status = this.computeStatus(calls);

    group.wrapper.dataset.activity = activity;
    group.wrapper.dataset.groupStatus = status;

    group.titleEl.textContent = ACTIVITY_LABELS[activity][status];

    group.bulletEl.className = "systemsculpt-chat-structured-bullet";
    if (status === "active") {
      group.bulletEl.classList.add("is-active");
    } else if (status === "failed") {
      group.bulletEl.classList.add("is-failed");
    } else if (status === "denied") {
      group.bulletEl.classList.add("is-denied");
    }
    setBulletSymbol(group.bulletEl, BULLET_SYMBOLS[status]);

    // Check for multiple pending destructive calls and show "Allow All" button
    const pendingDestructive = calls.filter(
      (tc) => tc.state === "pending" && this.toolRequiresApproval(tc)
    );
    if (pendingDestructive.length > 1) {
      this.renderAllowAllButton(group, pendingDestructive.length);
    } else {
      this.removeAllowAllButton(group);
    }
  }

  /**
   * Render an "Allow All" button when multiple pending destructive calls exist.
   */
  private renderAllowAllButton(group: ToolCallGroup, count: number): void {
    let container = group.wrapper.querySelector<HTMLElement>(".systemsculpt-allow-all-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "systemsculpt-allow-all-container";
      // Insert after the header, before linesContainer
      group.wrapper.insertBefore(container, group.linesContainer);
    }

    container.empty();

    const chatView = this.getChatView();
    const btn = container.createEl("button", {
      cls: "systemsculpt-button systemsculpt-button-primary systemsculpt-button-small",
      text: `Allow All (${count})`,
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      chatView?.approveAllPendingToolCalls?.();
    });
  }

  /**
   * Remove the "Allow All" button from a group.
   */
  private removeAllowAllButton(group: ToolCallGroup): void {
    const container = group.wrapper.querySelector(".systemsculpt-allow-all-container");
    container?.remove();
  }

  private computeActivity(calls: ToolCall[]): ActivityType {
    if (calls.length === 0) return "explore";
    const categories = new Set<ActivityType>();
    for (const call of calls) {
      categories.add(this.categorizeToolCall(call));
    }
    if (categories.size === 1) {
      return categories.values().next().value ?? "explore";
    }
    if (categories.has("mutate")) {
      return "mutate";
    }
    if (categories.has("explore")) {
      return "explore";
    }
    return "run";
  }

  private computeStatus(calls: ToolCall[]): GroupStatus {
    const hasActive = calls.some((call) => this.isActiveState(call.state));
    if (hasActive) return "active";
    if (calls.some((call) => call.state === "failed")) return "failed";
    if (calls.some((call) => call.state === "denied")) return "denied";
    return "completed";
  }

  private isActiveState(state: ToolCall["state"] | undefined): boolean {
    return state === "pending" || state === "approved" || state === "executing";
  }

  private categorizeToolCall(toolCall: ToolCall): ActivityType {
    const fnName = toolCall.request?.function?.name ?? "";
    const canonical = this.canonicalFunctionName(fnName);

    if (isMutatingTool(fnName)) {
      return "mutate";
    }

    if (/(^|_)(search|find|list|read|context)/.test(canonical)) {
      return "explore";
    }

    return "run";
  }

  private getToolCallDescriptor(toolCall: ToolCall): ToolCallDescriptor {
    const fn = getFunctionDataFromToolCall(toolCall);
    if (!fn) {
      return {
        label: "Tool",
        detail: "call",
        allowAggregation: false,
      };
    }

    const canonical = this.canonicalFunctionName(fn.name);
    const args = fn.arguments ?? {};

    if (canonical === "list_items") {
      return {
        label: "Browsed",
        detail: this.describeBrowseDetail(args),
        allowAggregation: true,
      };
    }

    if (/(^|_)(search|find)/.test(canonical)) {
      return {
        label: "Searched",
        detail: this.describeSearchLikeDetail(canonical, args, toolCall.result),
        allowAggregation: true,
      };
    }

    if (/^read/.test(canonical)) {
      return {
        label: "Read",
        detail: this.describeReadDetail(args, toolCall.result),
        allowAggregation: true,
      };
    }

    if (isWriteOrEditTool(fn.name)) {
      return {
        label: "Edited",
        detail: this.describeWriteEditDetail(canonical, args),
        allowAggregation: false,
      };
    }

    if (/(^|_)(write)/.test(canonical)) {
      return {
        label: "Write",
        detail: this.describeWriteDetail(args),
        allowAggregation: false,
      };
    }

    if (/(^|_)(move|trash|delete|rename)/.test(canonical)) {
      return this.describeFileOperationDescriptor(canonical, args);
    }

    const primaryPath = extractPrimaryPathArg(fn.name, args);
    const displayName = this.singleLine(formatToolDisplayName(fn.name));
    const fallbackDetail = primaryPath ? this.prettyPath(primaryPath) : this.describeGenericArguments(args);

    const allowAggregation = !this.isMutatingToolCall(toolCall);

    return {
      label: displayName,
      detail: fallbackDetail,
      allowAggregation,
    };
  }

  private describeToolCall(toolCall: ToolCall): string {
    const descriptor = this.getToolCallDescriptor(toolCall);
    return this.composeLineText(descriptor.label, descriptor.detail);
  }

  private describeBrowseDetail(args: any): string {
    const path = typeof args?.path === "string" ? args.path : null;
    if (path) {
      return this.prettyPath(path);
    }
    const paths = this.normalizeStringArray(args?.paths ?? []);
    if (paths.length > 0) {
      return paths.map((p) => this.prettyPath(p)).join(", ");
    }
    return "folder";
  }

  private describeSearchLikeDetail(canonical: string, args: any, result?: ToolCallResult): string {
    const terms = this.extractSearchTerms(args);
    const fallback = this.singleLine(formatToolDisplayName(canonical));
    const joined = terms.length > 0 ? terms.join(", ") : fallback;
    const summary = this.limitText(joined, 160);
    const location = this.extractSearchLocation(args, result);
    if (location) {
      return this.singleLine(`${summary} in ${location}`);
    }
    return this.singleLine(summary);
  }

  private describeReadDetail(args: any, result?: ToolCallResult): string {
    const paths = this.normalizeStringArray(args?.paths ?? []);
    if (typeof args?.path === "string" && !paths.includes(args.path)) {
      paths.push(args.path);
    }
    const fromResult = this.extractFilePathsFromResult(result);
    const combined = paths.length > 0 ? paths : fromResult;
    const primary = combined.length > 0 ? combined.map((p) => this.prettyPath(p)).join(", ") : "file";
    return this.singleLine(primary);
  }

  private describeWriteEditDetail(canonical: string, args: any): string {
    const path = typeof args?.path === "string" ? args.path : "file";
    const editCount = Array.isArray(args?.edits) ? args.edits.length : 0;
    const detail = canonical.endsWith("edit") && editCount > 1 ? ` (${editCount} edits)` : "";
    return this.singleLine(`${this.prettyPath(path)}${detail}`);
  }

  private describeWriteDetail(args: any): string {
    const path = typeof args?.path === "string" ? args.path : "file";
    return this.singleLine(this.prettyPath(path));
  }

  private extractSearchTerms(args: any): string[] {
    const terms: string[] = [];
    const seen = new Set<string>();
    const addTerm = (value: string) => {
      const normalized = this.singleLine(value);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      terms.push(this.limitText(normalized, 80));
    };

    const addMany = (source: unknown) => {
      for (const entry of this.normalizeStringArray(source)) {
        addTerm(entry);
      }
    };

    addMany(args?.patterns);
    addMany(args?.queries);
    addMany(args?.terms);
    addMany(args?.keywords);
    addMany(args?.searchTerms);

    if (typeof args?.query === "string") {
      this.parseSearchString(args.query, addTerm);
    }
    if (typeof args?.text === "string") {
      this.parseSearchString(args.text, addTerm);
    }
    if (typeof args?.term === "string") {
      this.parseSearchString(args.term, addTerm);
    }

    return terms;
  }

  private parseSearchString(raw: string, addTerm: (term: string) => void): void {
    const trimmed = this.singleLine(raw);
    if (!trimmed) return;

    const colonSplit = trimmed.split(/:+/).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    if (colonSplit.length > 1) {
      for (const segment of colonSplit) {
        addTerm(segment);
      }
      return;
    }

    const commaSplit = trimmed.split(/[\n\r,;]+/).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    if (commaSplit.length > 1) {
      for (const segment of commaSplit) {
        addTerm(segment);
      }
      return;
    }

    addTerm(trimmed);
  }

  private describeFileOperationDescriptor(canonical: string, args: any): ToolCallDescriptor {
    if (canonical.includes("move")) {
      return {
        label: "Moved",
        detail: this.describeMoveDetail(args),
        allowAggregation: false,
      };
    }
    if (canonical.includes("trash") || canonical.includes("delete")) {
      return {
        label: "Deleted",
        detail: this.describeDeleteDetail(args),
        allowAggregation: false,
      };
    }
    if (canonical.includes("rename")) {
      return {
        label: "Renamed",
        detail: this.describeRenameDetail(args),
        allowAggregation: false,
      };
    }
    return {
      label: this.singleLine(formatToolDisplayName(canonical)),
      detail: this.describeGenericArguments(args),
      allowAggregation: false,
    };
  }

  private describeMoveDetail(args: any): string {
    const items = Array.isArray(args?.items) ? args.items : [];
    const destination = this.prettyPath(args?.destination || args?.target || args?.targetPath || "destination");
    const count = items.length || (Array.isArray(args?.paths) ? args.paths.length : 0) || 1;
    return this.singleLine(`${count} item${count === 1 ? "" : "s"} to ${destination}`);
  }

  private describeDeleteDetail(args: any): string {
    const paths = this.normalizeStringArray(args?.paths ?? []);
    if (paths.length === 0) {
      return "item";
    }
    return this.singleLine(paths.map((p) => this.prettyPath(p)).join(", "));
  }

  private describeRenameDetail(args: any): string {
    const source = this.prettyPath(args?.from || args?.source || "item");
    const target = this.prettyPath(args?.to || args?.target || "target");
    return this.singleLine(`${source} → ${target}`);
  }

  private describeGenericArguments(args: Record<string, any>): string {
    if (!args) {
      return "";
    }
    const entries: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        entries.push(`${key}: ${this.limitText(String(value))}`);
      } else if (Array.isArray(value) && value.length > 0) {
        const printable = value
          .slice(0, 3)
          .map((item) => (typeof item === "string" || typeof item === "number" ? String(item) : "…"))
          .join(", ");
        entries.push(`${key}: ${this.limitText(printable)}`);
      }
      if (entries.length >= 2) break;
    }
    return this.singleLine(entries.join(" | "));
  }

  private extractSearchLocation(args: any, _result?: ToolCallResult): string | null {
    const scopes = this.collectSearchScopeValues(args);
    if (scopes.length === 0) {
      return null;
    }

    const formatted = scopes
      .map((scope) => this.prettyPath(scope))
      .filter((value) => value.length > 0);

    if (formatted.length === 0) {
      return null;
    }

    const display = formatted.length > 3
      ? `${formatted.slice(0, 3).join(", ")}…`
      : formatted.join(", ");

    return this.singleLine(this.limitText(display, 120));
  }

  private collectSearchScopeValues(args: any): string[] {
    if (!args || typeof args !== "object") {
      return [];
    }

    const candidateKeys = [
      "path",
      "paths",
      "root",
      "roots",
      "directory",
      "directories",
      "folder",
      "folders",
      "within",
      "scope",
      "scopes",
      "searchRoot",
      "searchRoots",
      "searchPath",
      "searchPaths",
      "location",
      "locations",
      "target",
      "targets",
    ];

    const seen = new Set<string>();
    const results: string[] = [];

    const addCandidate = (value: unknown) => {
      if (!value) return;

      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        results.push(trimmed);
        return;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          addCandidate(entry);
        }
        return;
      }

      if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        if (typeof obj.path === "string") {
          addCandidate(obj.path);
        }
        if (Array.isArray(obj.paths)) {
          addCandidate(obj.paths);
        }
      }
    };

    for (const key of candidateKeys) {
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        addCandidate((args as Record<string, unknown>)[key]);
      }
    }

    return results;
  }

  private extractFilePathsFromResult(result?: ToolCallResult): string[] {
    if (!result?.data) return [];
    const data = result.data as any;
    const paths: string[] = [];

    if (Array.isArray(data?.files)) {
      for (const file of data.files) {
        if (typeof file?.path === "string") {
          paths.push(file.path);
        } else if (typeof file?.file === "string") {
          paths.push(file.file);
        }
      }
    }

    if (Array.isArray(data?.results)) {
      for (const item of data.results) {
        const candidate = item?.path ?? item?.file ?? item?.name;
        if (typeof candidate === "string") {
          paths.push(candidate);
        }
      }
    }

    return paths;
  }

  private normalizeStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item)).filter((item) => item.length > 0);
    }
    if (typeof value === "string" && value.length > 0) {
      return [value];
    }
    return [];
  }

  private prettyPath(path: string): string {
    if (!path) return "";
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/");
    return segments[segments.length - 1] || normalized;
  }

  private limitText(text: string, max = 80): string {
    if (!text) return "";
    const singleLine = text.replace(/\s+/g, " ").trim();
    if (singleLine.length <= max) return singleLine;
    return singleLine.slice(0, max - 1) + "…";
  }

  private singleLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private canonicalFunctionName(name: string): string {
    let canonical = name || "";
    if (canonical.startsWith("mcp-")) {
      const underscoreIndex = canonical.indexOf("_");
      if (underscoreIndex !== -1) {
        canonical = canonical.slice(underscoreIndex + 1);
      } else {
        canonical = canonical.replace(/^mcp-/, "");
      }
    }
    canonical = canonical.replace(/^filesystem_/, "");
    return canonical;
  }

  private populateActions(line: HTMLElement, representativeToolCall: ToolCall): void {
    const actions = line.querySelector<HTMLElement>(".systemsculpt-chat-structured-line-actions");
    if (!actions) {
      return;
    }

    actions.empty();
    actions.style.removeProperty("display");

    // Only show actions for pending state
    if (representativeToolCall.state !== "pending") {
      actions.style.display = "none";
      return;
    }

    // Check if this tool requires user approval
    if (!this.toolRequiresApproval(representativeToolCall)) {
      actions.style.display = "none";
      return;
    }

    // Render approval buttons: [Allow] [Always Allow] [Block]
    this.renderApprovalButtons(actions, representativeToolCall);
  }

  /**
   * Render the approval action buttons for a pending tool call.
   */
  private renderApprovalButtons(container: HTMLElement, toolCall: ToolCall): void {
    const toolCallManager = this.getToolCallManager();
    const chatView = this.getChatView();
    if (!toolCallManager) {
      return;
    }

    const toolName = toolCall.request?.function?.name ?? "";
    const { canonicalName } = splitToolName(toolName);

    // Create button group container
    const buttonGroup = container.createDiv({ cls: "systemsculpt-approval-buttons" });

    // Allow button - approves this single call
    const allowBtn = buttonGroup.createEl("button", {
      cls: "systemsculpt-button systemsculpt-button-primary systemsculpt-button-small",
      text: "Allow",
    });
    allowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      toolCallManager.approveToolCall(toolCall.id);
    });

    // Always Allow button - trusts this tool for the session
    const alwaysBtn = buttonGroup.createEl("button", {
      cls: "systemsculpt-button systemsculpt-button-secondary systemsculpt-button-small",
      text: "Always Allow",
      attr: { title: `Trust "${canonicalName || toolName}" for this session` },
    });
    alwaysBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      chatView?.trustToolForSession?.(toolName);
    });

    // Block button - denies this call
    const blockBtn = buttonGroup.createEl("button", {
      cls: "systemsculpt-button systemsculpt-button-danger systemsculpt-button-small",
      text: "Block",
    });
    blockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      toolCallManager.denyToolCall(toolCall.id);
    });
  }

  private isMutatingToolCall(toolCall: ToolCall): boolean {
    const fn = getFunctionDataFromToolCall(toolCall);
    if (!fn) {
      return false;
    }
    return isMutatingTool(fn.name);
  }

  private safeLog(event: string, toolCall?: ToolCall, extras?: Record<string, unknown>): void {
    try {
      errorLogger.debug(`[ToolCallTreeRenderer] ${event}`, {
        metadata: {
          toolCallId: toolCall?.id,
          state: toolCall?.state,
          ...extras,
        },
        source: "ToolCallTreeRenderer",
        method: event,
      });
    } catch (_) {
      // Ignore logging failures
    }
  }

  // Legacy compatibility stubs used by existing MessageRenderer pathways
  public renderToolCallContent(_container: HTMLElement, _toolCall: ToolCall, _isStreaming: boolean): Promise<void> {
    return Promise.resolve();
  }

  public createStatusIndicator(_headerEl: HTMLElement, _state: string | undefined): void {
    // Intentionally blank; status handled by header context
  }

  public updateStatusIndicator(_statusEl: HTMLElement, _state: string | undefined): void {
    // Intentionally blank; status handled by header context
  }

  public renderHeaderActions(_headerEl: HTMLElement, _toolCall: ToolCall): void {
    // Intentionally blank; compact tree view has no inline actions
  }
}
