import { createSurfaceElement, getSurfaceOwnerWindow } from "../../core/ui/surface";
import { setIcon } from "obsidian";
import type { MessagePart } from "../../types";
import type { AgentConversationSnapshot, AgentPart, AgentToolPart } from "../../chat/ChatConversation";
import { finalAgentAnswerPartIds, formatAgentWorkingDuration, groupAdjacentAgentActivity, isAgentActivityPart, splitPreviousAgentActivity, summarizeAgentActivity } from "./AgentActivityPresentation";
import { isActiveAgentToolState, type AgentConversationPresentation } from "./AgentConversationPresentation";
import { agentPartsEqual, historicalAgentPart, partitionHistoricalParts, terminalToolPresentation, toolDisplayFingerprint, toolPartKey } from "./ConversationPartPresentation";
import { presentMessageContent, type PresentedMessageAttachment } from "./ChatMessagePresentation";
import { presentAgentTool } from "./AgentToolPresentation";
import { presentPendingMedia } from "./PendingMedia";
import { presentTurnMedia } from "./TurnMedia";
import { captureDetailsState, findFocusKey, focusedElementWithin, reconcileConversationChildren, restoreDetailsState } from "./ConversationDomState";
import type { AgentApprovalCards } from "./AgentApprovalCards";
import type { AgentToolRenderer } from "./AgentToolRenderer";

type Activity = Readonly<{ element: HTMLDetailsElement; summary: HTMLElement; body: HTMLElement }>;
type ActiveConversationRendererOptions = Readonly<{
  conversation: HTMLElement;
  isRenderingEnabled: () => boolean;
  lifecycleGeneration: () => number;
  backendName?: () => string;
  onAnnounce?: (message: string) => void;
  hasHistoryMessage: (messageId: string) => boolean;
  hasFailedMessage: (messageId: string) => boolean;
  hasCancelledMessage: (messageId: string) => boolean;
  approvals: AgentApprovalCards;
  tools: AgentToolRenderer;
  renderPart: (node: HTMLElement, part: AgentPart, previous?: AgentPart, suppressToolError?: boolean, progressActive?: boolean) => Promise<boolean>;
  forgetMarkdown: (target: HTMLElement) => void;
  renderMessageAttachments: (parent: HTMLElement, attachments: readonly PresentedMessageAttachment[]) => void;
  renderTurnMediaBlock: (parent: HTMLElement, parts: readonly AgentToolPart[], answer: string, live?: boolean) => HTMLElement | null;
  renderTurnChanges: (parent: HTMLElement, parts: readonly AgentToolPart[]) => void;
  addTurnHeading: (row: HTMLElement, user: boolean) => void;
  createCompletedActivity: (parent: HTMLElement, elapsedMs?: number, cancelled?: boolean) => Activity;
  setCompletedActivitySummary: (element: HTMLDetailsElement, parts: readonly AgentPart[], elapsedMs?: number, cancelled?: boolean) => void;
  /** A filled fold settles: a lone call opens to its card, and the body marks an open last card. */
  settleFold: (fold: HTMLDetailsElement) => void;
  workedLabel: (elapsedMs?: number, cancelled?: boolean) => string;
  createActivityOverflow: (parent: HTMLElement, hiddenCount: number, key: string) => Readonly<{ element: HTMLButtonElement }>;
  updateActivityOverflow: (element: HTMLButtonElement, count: number) => void;
  setActivityOverflowItems: (element: HTMLButtonElement, latest: HTMLElement | null, previous: readonly HTMLElement[]) => void;
  overflowBody: (element: HTMLButtonElement) => HTMLElement | undefined;
  forgetOverflow: (element: HTMLButtonElement) => void;
  updateDisclosureOpen: (element: HTMLElement, open: boolean) => void;
}>;

/** Owns keyed live parts, progress, and the one-way handoff of their DOM to history. */
export class ActiveConversationRenderer {
  private readonly activeNodes = new Map<string, HTMLElement>();
  private readonly activeOverflowNodes = new Map<string, HTMLButtonElement>();
  private readonly activePartRefs = new Map<string, AgentPart>();
  private readonly activePartProgressStates = new WeakMap<HTMLElement, boolean>();
  private readonly activeToolDisplayFingerprints = new Map<string, string>();
  private readonly activeToolErrorSuppression = new Map<string, boolean>();
  private toolRenderEpoch = 0;
  private activeTailStatus: HTMLElement | null = null;
  private activeCompletedFold: HTMLDetailsElement | null = null;
  private activeCompletedFoldBody: HTMLElement | null = null;
  private activeWorkingTimer: number | null = null;
  private activeWorkingWindow: Window | null = null;
  private visible = true;
  private activeElapsedBaseline: Readonly<{ elapsedMs: number; observedAt: number }> | null = null;
  private activeTurn: HTMLElement | null = null;
  private activeBody: HTMLElement | null = null;
  private activeTurnId: string | null = null;
  private announcedTurnId: string | null = null;
  private announcedTerminalId: string | null = null;

  constructor(private readonly root: HTMLElement, private readonly options: ActiveConversationRendererOptions) {}

  public get responseElement(): HTMLElement | null { return this.activeTurn; }
  public get responseBody(): HTMLElement | null { return this.activeBody; }
  public get renderEpoch(): number { return this.toolRenderEpoch; }
  public get partCount(): number { return this.activeNodes.size; }

  public canAdopt(turnId: string | null): boolean {
    return turnId !== null && this.activeTurnId === turnId && this.activeTurn !== null && this.activeBody !== null;
  }

  public hasPart(key: string): boolean { return this.activeNodes.has(key); }

  public hasFailure(turnId: string): boolean {
    if (this.activeTurnId !== turnId) return false;
    for (const part of this.activePartRefs.values()) if (part.kind === "error") return true;
    return false;
  }

  public resetAnnouncements(): void {
    this.announcedTurnId = null;
    this.announcedTerminalId = null;
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.activePartRefs.clear();
      this.stopWorkingTimer(false);
    }
  }

  public windowMigrated(): void {
    this.stopWorkingTimer(false);
    if (this.visible && this.activeTailStatus && this.activeElapsedBaseline) {
      this.startWorkingTimer(this.activeTailStatus, this.activeElapsedBaseline.elapsedMs);
    }
  }

  public dispose(): void {
    this.toolRenderEpoch += 1;
    this.stopWorkingTimer();
  }

  public async prepareHistoryHandoff(
    parent: HTMLElement,
    parts: readonly MessagePart[],
    elapsedMs: number | undefined,
    finalAnswerPartIds: ReadonlySet<string>,
    cancelled: boolean,
    failure: AgentPart | undefined,
    isHistoryCurrent: () => boolean,
  ): Promise<Readonly<{ hasActivity: boolean; commit: () => void }> | null> {
    const row = this.activeTurn;
    const epoch = this.toolRenderEpoch;
    const generation = this.options.lifecycleGeneration();
    const isCurrent = (): boolean => this.options.isRenderingEnabled()
      && generation === this.options.lifecycleGeneration()
      && epoch === this.toolRenderEpoch
      && row !== null && row === this.activeTurn
      && parent === this.activeBody
      && isHistoryCurrent();
    if (!isCurrent()) return null;
    const { workParts, finalAnswers, hasActivity } = partitionHistoricalParts(
      parts,
      finalAnswerPartIds,
    );
    const work = await this.adoptHistoricalLanes(workParts, parent, isCurrent);
    if (!isCurrent()) return null;
    const desired: Array<Readonly<{ key: string; node: HTMLElement }>> = [];
    if (hasActivity) {
      if (!this.activeCompletedFold || !this.activeCompletedFoldBody) {
        const created = this.options.createCompletedActivity(parent, elapsedMs, cancelled);
        this.activeCompletedFold = created.element;
        this.activeCompletedFoldBody = created.body;
      } else {
        this.activeCompletedFold.querySelector<HTMLElement>(
          ":scope > .systemsculpt-agent-activity-header > .systemsculpt-agent-activity-label",
        )?.setText(this.options.workedLabel(elapsedMs, cancelled));
      }
      this.options.setCompletedActivitySummary(this.activeCompletedFold, work.map(({ part }) => part), elapsedMs, cancelled);
      const grouped = this.groupActiveTimeline(
        this.activeCompletedFoldBody,
        work.map(({ key, node }) => ({ key, node })),
        work.map(({ part }) => part),
        true,
      );
      reconcileConversationChildren(this.activeCompletedFoldBody, grouped.map(({ node }) => node));
      this.options.settleFold(this.activeCompletedFold);
      desired.push({ key: "turn-fold", node: this.activeCompletedFold });
    } else {
      desired.push(...work.map(({ key, node }) => ({ key, node })));
    }
    const final = await this.adoptHistoricalLanes(finalAnswers, parent, isCurrent);
    if (!isCurrent()) return null;
    desired.push(...final.map(({ key, node }) => ({ key, node })));
    reconcileConversationChildren(parent, desired.map(({ node }) => node));
    if (failure) await this.renderActivePart(failure, failure.id, false, parent, false);
    if (!isCurrent()) return null;
    return {
      hasActivity,
      // Keep live ownership until the history owner has mounted the row.
      commit: () => {
        if (isCurrent() && row?.parentElement !== this.root) this.releaseAdoptedActiveTurn();
      },
    };
  }

  private async adoptHistoricalLanes(
    parts: readonly MessagePart[],
    insertionParent: HTMLElement,
    isCurrent: () => boolean,
  ): Promise<Array<Readonly<{ key: string; node: HTMLElement; part: AgentPart }>>> {
    const lanes: Array<Readonly<{ key: string; node: HTMLElement; part: AgentPart }>> = [];
    for (const messagePart of parts) {
      if (!isCurrent()) return [];
      const part = historicalAgentPart(messagePart);
      if (!part) continue;
      const key = part.kind === "tool" ? toolPartKey(part.callId) : part.id;
      const node = await this.renderActivePart(part, key, false, insertionParent, false);
      if (!isCurrent()) return [];
      if (messagePart.type === "content") {
        const content = presentMessageContent(messagePart.data);
        node.querySelectorAll(":scope > .systemsculpt-agent-message-attachments")
          .forEach((attachment) => attachment.remove());
        if (content.attachments.length > 0) this.options.renderMessageAttachments(node, content.attachments);
      }
      lanes.push({ key, node, part });
    }
    return lanes;
  }

  private releaseAdoptedActiveTurn(): void {
    this.activeTailStatus?.remove();
    this.stopWorkingTimer();
    this.activeTurn = null;
    this.activeBody = null;
    this.activeTurnId = null;
    this.activeTailStatus = null;
    this.activeCompletedFold = null;
    this.activeCompletedFoldBody = null;
    this.activeOverflowNodes.clear();
    this.activeNodes.clear();
    this.activePartRefs.clear();
    this.activeToolDisplayFingerprints.clear();
    this.activeToolErrorSuppression.clear();
    this.options.conversation.setAttribute("aria-busy", "false");
  }

  public async render(
    snapshot: AgentConversationSnapshot,
    presentation: AgentConversationPresentation,
  ): Promise<void> {
    if (!this.options.isRenderingEnabled()) return;
    const lifecycleGeneration = this.options.lifecycleGeneration();
    const isCurrent = (): boolean =>
      this.options.isRenderingEnabled() && lifecycleGeneration === this.options.lifecycleGeneration();
    const focusedApproval = this.options.approvals.captureFocus();
    const body = this.ensureActiveTurn(snapshot.turnId);
    this.options.conversation.setAttribute("aria-busy", String(presentation.busy));
    const identity = snapshot.turnId ?? snapshot.runId;
    const backend = this.options.backendName?.() ?? "SystemSculpt";
    if (presentation.busy && identity && identity !== this.announcedTurnId) {
      this.announcedTurnId = identity;
      this.options.onAnnounce?.(`${backend} is working`);
    } else if (!presentation.busy && identity === this.announcedTurnId && identity !== this.announcedTerminalId) {
      this.announcedTerminalId = identity;
      if (presentation.phase === "completed") this.options.onAnnounce?.(`${backend} replied`);
      if (presentation.phase === "cancelled") this.options.onAnnounce?.("Stopped");
    }
    this.activeTurn?.toggleClass("is-active", presentation.busy);
    this.activeTurn?.setAttribute("data-active", String(presentation.busy));
    const hasCommittedFailedProjection = presentation.phase === "failed"
      && snapshot.messages.some((message) =>
        this.options.hasFailedMessage(message.id));
    const wantedParts = new Set<string>();
    const orderedParts = presentation.visibleParts
      .map((part) => part.kind === "error" && !part.retryMessageId && snapshot.turnId
        ? { ...part, retryMessageId: snapshot.turnId }
        : part)
      .map((part) => terminalToolPresentation(part, presentation))
      .map((part, index) => ({ part, index }))
      .sort((left, right) =>
        left.part.order - right.part.order || left.index - right.index)
      .map(({ part }) => part)
      // History and the live run are sibling containers. Once a part's
      // message is rendered in the committed transcript above, its live copy
      // would show the same content twice; only parts history cannot carry
      // (the terminal error and its Retry affordance) may stay.
      .filter((part) =>
        part.kind === "error" || !this.options.hasHistoryMessage(part.messageId))
      .filter((part) => part.kind !== "error" || !hasCommittedFailedProjection)
      .filter((part) =>
        presentation.phase !== "completed"
        || part.kind !== "reasoning"
        || part.summary.trim().length > 0);
    const terminalErrors = orderedParts.filter(
      (part): part is Extract<AgentPart, { kind: "error" }> => part.kind === "error",
    );
    const hasCommittedCancelledProjection = presentation.phase === "cancelled"
      && snapshot.messages.some((message) =>
        this.options.hasCancelledMessage(message.id));
    const showTerminalStatus = presentation.phase === "cancelled"
      ? !hasCommittedCancelledProjection
      : presentation.phase === "failed"
        && terminalErrors.length === 0
        && !hasCommittedFailedProjection;
    const tailStatus = presentation.busy || showTerminalStatus
      ? this.ensureTailStatus(presentation, snapshot.elapsedMs)
      : null;
    if (!tailStatus && this.activeTailStatus) {
      this.activeTailStatus.remove();
      this.activeTailStatus = null;
      this.stopWorkingTimer();
    }
    if (orderedParts.length === 0 && !tailStatus) {
      this.clear();
      return;
    }
    const duplicatesTerminalError = (part: AgentToolPart): boolean =>
      Boolean(part.error && terminalErrors.some((terminal) =>
        terminal.error.code === part.error?.code
        && terminal.error.message === part.error.message));
    const lanes: Array<Readonly<{ key: string; node: HTMLElement }>> = [];
    const renderErrors: unknown[] = [];
    for (const part of orderedParts) {
      const key = part.kind === "tool" ? toolPartKey(part.callId) : part.id;
      wantedParts.add(key);
      try {
        const node = await this.renderActivePart(
          part,
          key,
          part.kind === "tool" && duplicatesTerminalError(part),
          undefined,
          presentation.progressActive,
        );
        if (!isCurrent()) return;
        lanes.push({ key, node });
      } catch (error) {
        if (!isCurrent()) return;
        renderErrors.push(error);
        const node = this.activeNodes.get(key);
        if (node) lanes.push({ key, node });
      }
    }
    if (!isCurrent()) return;
    const finalAnswerPartIds = presentation.phase === "completed"
      ? finalAgentAnswerPartIds(orderedParts.flatMap((part) => part.kind === "error" ? [] : [{
        id: part.id,
        messageId: part.messageId,
        visible: part.kind === "text"
          ? part.markdown.trim().length > 0
          : part.kind !== "reasoning" || part.summary.trim().length > 0,
        kind: isAgentActivityPart(part)
          ? "activity" as const
          : part.id.startsWith("sources:")
            ? "sources" as const
            : "content" as const,
      }]))
      : new Set<string>();
    // A generation that is drawing its live tile is that tile: its row would say the same
    // words and run a second spinner, so it steps aside until the call finishes.
    const liveTileCalls = presentation.phase === "completed" ? new Set<string>() : new Set(
      presentPendingMedia(orderedParts.filter((part): part is AgentToolPart => part.kind === "tool"), presentation.busy)
        .filter((tile) => tile.state !== "failed")
        .map((tile) => tile.callId),
    );
    const shownIndexes = orderedParts.flatMap((part, index) =>
      part.kind === "tool" && liveTileCalls.has(part.callId) ? [] : [index]);
    // While a picture, video or Studio run is made, the steps and words before it already fold into
    // the turn's one row, so its tile sits where the finished file lands (no jump when it does).
    const mediaSourceIndex = presentation.phase === "completed" || !presentation.busy ? -1 : this.mediaSourceIndex(orderedParts);
    const foldedIndexes = shownIndexes.filter((index) => index < mediaSourceIndex);
    const restIndexes = shownIndexes.filter((index) => index >= mediaSourceIndex);
    const foldLive = foldedIndexes.some((index) => isAgentActivityPart(orderedParts[index]));
    const visibleLanes = presentation.phase === "completed"
      ? this.completedActiveLanes(
        body,
        lanes,
        orderedParts,
        finalAnswerPartIds,
        snapshot.elapsedMs,
      )
      : foldLive
        ? [
          this.liveFold(body, foldedIndexes.map((index) => lanes[index]), foldedIndexes.map((index) => orderedParts[index])),
          ...this.groupActiveTimeline(body, restIndexes.map((index) => lanes[index]), restIndexes.map((index) => orderedParts[index])),
        ]
        : this.groupActiveTimeline(body, shownIndexes.map((index) => lanes[index]), shownIndexes.map((index) => orderedParts[index]));
    if (tailStatus) {
      visibleLanes.push({
        key: "tail-status",
        node: tailStatus,
      });
    }

    // An unchanged receipt survives reconciliation, so a focused link keeps focus.
    const receipt = presentation.busy ? null
      : body.querySelector<HTMLElement>(":scope > .systemsculpt-agent-turn-changes");
    // Generated media shows as soon as a tool saves it, above the working status;
    // while the turn runs, each generation holds its place as a live placeholder.
    const toolParts = orderedParts.filter((part): part is AgentToolPart => part.kind === "tool");
    const media = this.options.renderTurnMediaBlock(
      body,
      toolParts,
      orderedParts.flatMap((part) => part.kind === "text" ? [part.markdown] : []).join("\n"),
      presentation.busy,
    );
    if (tailStatus) {
      // A running call already shows its words and spinner, on its row or its live tile: the tail would say it twice.
      const latest = [...presentation.visibleParts].reverse().find((part) =>
        part.kind === "tool" ? isActiveAgentToolState(part.state)
          : (part.kind === "text" || part.kind === "reasoning") && part.state === "streaming");
      tailStatus.hidden = presentation.phase === "acting" && latest?.kind === "tool";
    }
    const laneNodes = visibleLanes.map((lane) => lane.node);
    if (media) {
      // While the turn runs, media sits right after whatever came before the call that makes it, so the
      // steps that follow (even once they fold into an activity group) land below it, never above.
      const source = presentation.busy && media.dataset.firstTool !== undefined ? toolParts[Number(media.dataset.firstTool)] : undefined;
      const sourceIndex = source ? orderedParts.indexOf(source) : -1;
      const partIndex = new Map(orderedParts.map((part, index) => [part.kind === "tool" ? toolPartKey(part.callId) : part.id, index]));
      let anchor = -1;
      if (sourceIndex >= 0) {
        anchor = 0;
        for (const lane of visibleLanes) {
          // The live fold holds only steps from before the call; it always sits above its tile.
          if (lane.key === "turn-fold") {
            anchor += 1;
            continue;
          }
          // A group's header and its drawer both stand for the steps the group starts with.
          const index = partIndex.get(lane.key.replace(/^overflow:/u, "").replace(/:body$/u, ""));
          if (index === undefined || index >= sourceIndex) break;
          anchor += 1;
        }
      }
      // A settled turn keeps that place too: its work folds into one row and the reply follows the media.
      const fold = visibleLanes.findIndex((lane) => lane.key === "turn-fold");
      if (!presentation.busy && fold >= 0) anchor = fold + 1;
      laneNodes.splice(anchor >= 0 ? anchor : tailStatus ? laneNodes.length - 1 : laneNodes.length, 0, media);
    }
    reconcileConversationChildren(body, [...laneNodes, ...(receipt ? [receipt] : [])]);
    for (const [key, node] of this.activeNodes) {
      if (!wantedParts.has(key)) {
        this.options.forgetMarkdown(node);
        node.remove();
        this.activeNodes.delete(key);
        this.activePartRefs.delete(key);
        this.activeToolDisplayFingerprints.delete(key);
        this.activeToolErrorSuppression.delete(key);
      }
    }
    if (!presentation.busy) {
      this.options.renderTurnChanges(body, orderedParts.filter((part): part is AgentToolPart => part.kind === "tool"));
    }
    this.options.approvals.sync(orderedParts.filter((part): part is AgentToolPart => part.kind === "tool"), focusedApproval);
    if (renderErrors.length > 0) throw renderErrors[0];
  }

  private completedActiveLanes(
    body: HTMLElement,
    lanes: Array<Readonly<{ key: string; node: HTMLElement }>>,
    parts: readonly AgentPart[],
    finalAnswerPartIds: ReadonlySet<string>,
    elapsedMs?: number,
  ): Array<Readonly<{ key: string; node: HTMLElement }>> {
    const finalAnswers = lanes.filter((_, index) => finalAnswerPartIds.has(parts[index].id));
    const workLanes = lanes.filter((_, index) => !finalAnswerPartIds.has(parts[index].id));
    const workParts = parts.filter((part) => !finalAnswerPartIds.has(part.id));
    const hasActivity = workParts.some(isAgentActivityPart);
    if (!hasActivity) return lanes;
    const focusedElement = focusedElementWithin(body);
    const moveFocusToFold = focusedElement !== null
      && workLanes.some(({ node }) => node.contains(focusedElement));
    if (!this.activeCompletedFold || !this.activeCompletedFoldBody) {
      const created = this.options.createCompletedActivity(body, elapsedMs);
      this.activeCompletedFold = created.element;
      this.activeCompletedFoldBody = created.body;
    } else {
      this.activeCompletedFold.querySelector<HTMLElement>(
        ":scope > .systemsculpt-agent-activity-header > .systemsculpt-agent-activity-label",
      )?.setText(this.options.workedLabel(elapsedMs));
    }
    this.options.setCompletedActivitySummary(this.activeCompletedFold, workParts, elapsedMs);
    // The settled fold is the summary of its work, so its rows sit flat inside it: no second group header.
    const rendered = this.groupActiveTimeline(this.activeCompletedFoldBody, workLanes, workParts, true);
    reconcileConversationChildren(this.activeCompletedFoldBody, rendered.map(({ node }) => node));
    this.options.settleFold(this.activeCompletedFold);
    if (moveFocusToFold) {
      this.activeCompletedFold.querySelector<HTMLElement>(
        ":scope > .systemsculpt-agent-activity-header",
      )?.focus({ preventScroll: true });
    }
    return [
      { key: "turn-fold", node: this.activeCompletedFold },
      ...finalAnswers,
    ];
  }

  /** Where in the turn the first picture, video or Studio run (live or saved) comes from; -1 if none. */
  private mediaSourceIndex(parts: readonly AgentPart[]): number {
    const tools = parts.filter((part): part is AgentToolPart => part.kind === "tool");
    const answer = parts.flatMap((part) => part.kind === "text" ? [part.markdown] : []).join("\n");
    const media = presentTurnMedia(tools, answer, true);
    const first = Math.min(...media.media.map((item) => item.order ?? Infinity), ...media.pending.map((tile) => tile.order));
    return Number.isFinite(first) ? parts.indexOf(tools[first]) : -1;
  }

  /**
   * The turn's fold, made early: while a generation runs, what came before it is already the one row
   * the finished turn shows, so the tile below it is where the file lands. The same element settles
   * when the turn ends.
   */
  private liveFold(
    body: HTMLElement,
    lanes: readonly Readonly<{ key: string; node: HTMLElement }>[],
    parts: readonly AgentPart[],
  ): Readonly<{ key: string; node: HTMLElement }> {
    if (!this.activeCompletedFold || !this.activeCompletedFoldBody) {
      const created = this.options.createCompletedActivity(body);
      this.activeCompletedFold = created.element;
      this.activeCompletedFoldBody = created.body;
    }
    // No time beside it: the tile keeps the clock while the turn runs.
    this.options.setCompletedActivitySummary(this.activeCompletedFold, parts);
    const rendered = this.groupActiveTimeline(this.activeCompletedFoldBody, lanes, parts, true, false);
    reconcileConversationChildren(this.activeCompletedFoldBody, rendered.map(({ node }) => node));
    this.options.settleFold(this.activeCompletedFold);
    return { key: "turn-fold", node: this.activeCompletedFold };
  }

  private groupActiveTimeline(
    parent: HTMLElement,
    lanes: readonly Readonly<{ key: string; node: HTMLElement }>[],
    parts: readonly AgentPart[],
    flat = false,
    // The live fold groups only its own steps; the rows after it decide which drawers stay.
    dropUnusedDrawers = true,
  ): Array<Readonly<{ key: string; node: HTMLElement }>> {
    const result: Array<Readonly<{ key: string; node: HTMLElement }>> = [];
    const timeline = groupAdjacentAgentActivity(
      lanes.map((lane, index) => ({ lane, part: parts[index] })),
      ({ part }) => !flat && isAgentActivityPart(part),
    );
    const wantedOverflowKeys = new Set<string>();
    for (const entry of timeline) {
      if (entry.kind === "item") {
        result.push(entry.item.lane);
        continue;
      }
      const split = splitPreviousAgentActivity(entry.items);
      if (split.previous.length > 0) {
        const first = split.previous[0];
        const key = `overflow:${first.lane.key}`;
        wantedOverflowKeys.add(key);
        let overflow = this.activeOverflowNodes.get(key);
        if (!overflow) {
          overflow = this.options.createActivityOverflow(parent, split.previous.length, key).element;
          this.activeOverflowNodes.set(key, overflow);
        } else {
          this.options.updateActivityOverflow(overflow, split.previous.length);
        }
        // The latest step shows as its own row under the header, so the header names only the steps before it.
        const previousParts = split.previous.map(({ part }) => part);
        const summary = summarizeAgentActivity(previousParts);
        overflow.dataset.activitySummary = summary.label;
        overflow.dataset.failedCount = String(summary.failedCount);
        const previousRunning = previousParts.some((part) => part.kind === "tool"
          ? isActiveAgentToolState(part.state)
          : part.kind === "reasoning" && part.state === "streaming");
        overflow.dataset.summaryIcon = summary.failedCount || summary.refused ? "circle-alert"
          : summary.gated ? "lock" : summary.denied ? "ban" : previousRunning ? "loader-circle" : "check";
        const previousLanes = split.previous.map(({ lane }) => lane);
        this.options.setActivityOverflowItems(
          overflow,
          split.latest?.lane.node ?? null,
          previousLanes.map(({ node }) => node),
        );
        result.push({ key, node: overflow });
        const overflowBody = this.options.overflowBody(overflow);
        if (overflowBody) result.push({ key: `${key}:body`, node: overflowBody });
        if (split.latest) result.push(split.latest.lane);
        continue;
      }
      if (split.latest) result.push(split.latest.lane);
    }
    if (!dropUnusedDrawers) return result;
    for (const [key, overflow] of this.activeOverflowNodes) {
      if (wantedOverflowKeys.has(key)) continue;
      this.options.overflowBody(overflow)?.remove();
      this.options.forgetMarkdown(overflow);
      overflow.remove();
      this.activeOverflowNodes.delete(key);
      this.options.forgetOverflow(overflow);
    }
    return result;
  }

  private async renderActivePart(
    part: AgentPart,
    key: string,
    suppressToolError = false,
    insertionParent?: HTMLElement,
    progressActive = true,
  ): Promise<HTMLElement> {
    const lifecycleGeneration = this.options.lifecycleGeneration();
    const renderEpoch = this.toolRenderEpoch;
    let node = this.activeNodes.get(key);
    const createdNode = !node;
    if (!node) {
      node = createSurfaceElement(this.root.ownerDocument, "div");
      node.addClass("systemsculpt-agent-part", `is-${part.kind}`);
      node.dataset.testid = "chat.part";
      node.dataset.kind = part.kind;
      node.dataset.partKey = key;
      if (isAgentActivityPart(part)) {
        node.dataset.agentActivityRow = "";
        node.dataset.activityKind = part.kind;
      }
      this.activeNodes.set(key, node);
    }
    const needsInsertion = node.parentElement === null;
    const activeElement = focusedElementWithin(node);
    const preservedFocusKey = activeElement
      ? activeElement.dataset.focusKey
      : undefined;
    const incomingToolFingerprint = part.kind === "tool"
      ? toolDisplayFingerprint(part)
      : undefined;
    const suppressionChanged = part.kind === "tool"
      && this.activeToolErrorSuppression.get(key) !== suppressToolError;
    if (
      !agentPartsEqual(
        this.activePartRefs.get(key),
        part,
        this.activeToolDisplayFingerprints.get(key),
        incomingToolFingerprint,
      )
      || suppressionChanged
      // Frozen snapshots can reuse every part object. Lifecycle changes still
      // need to pause/resume visuals without changing the authoritative parts.
      || this.activePartProgressStates.get(node) !== progressActive
    ) {
      const committed = await this.options.renderPart(
        node,
        part,
        this.activePartRefs.get(key),
        suppressToolError,
        progressActive,
      );
      if (
        !this.options.isRenderingEnabled()
        || lifecycleGeneration !== this.options.lifecycleGeneration()
        || renderEpoch !== this.toolRenderEpoch
      ) {
        if (createdNode && this.activeNodes.get(key) === node) {
          this.options.forgetMarkdown(node);
          node.remove();
          this.activeNodes.delete(key);
          this.activePartRefs.delete(key);
          this.activeToolDisplayFingerprints.delete(key);
          this.activeToolErrorSuppression.delete(key);
        }
        return node;
      }
      if (committed) {
        this.activePartRefs.set(key, part);
        this.activePartProgressStates.set(node, progressActive);
        if (part.kind === "tool") {
          this.activeToolDisplayFingerprints.set(key, incomingToolFingerprint!);
          this.activeToolErrorSuppression.set(key, suppressToolError);
        } else {
          this.activeToolDisplayFingerprints.delete(key);
          this.activeToolErrorSuppression.delete(key);
        }
        if (needsInsertion) {
          if (insertionParent) insertionParent.appendChild(node);
          else this.insertActiveNode(node);
        }
        if (part.kind === "tool") void this.options.tools.hydrateApprovalPreview(node);
      }
    }
    if (preservedFocusKey) {
      findFocusKey(node, preservedFocusKey)?.focus();
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
    this.clear();
    this.activeTurnId = turnId;
    this.activeTurn = this.root.createDiv({
      cls: "systemsculpt-agent-turn is-assistant is-active",
      attr: {
        "data-testid": "chat.turn",
        "data-role": "assistant",
        "data-active": "true",
        ...(turnId ? { "data-turn-id": turnId } : {}),
      },
    });
    this.options.addTurnHeading(this.activeTurn, false);
    this.activeBody = this.activeTurn.createDiv({ cls: "systemsculpt-agent-turn-body" });
    return this.activeBody;
  }

  private ensureTailStatus(
    presentation: AgentConversationPresentation,
    elapsedMs?: number,
  ): HTMLElement {
    let status = this.activeTailStatus;
    if (!status) {
      status = this.root.createDiv({
        cls: "systemsculpt-agent-tail-status",
        attr: { "data-testid": "chat.tail-status" },
      });
      status.createSpan({ cls: "systemsculpt-agent-tail-status-icon" });
      status.createSpan({ cls: "systemsculpt-agent-tail-status-label", attr: { "data-testid": "chat.tail-status.label" } });
      this.activeTailStatus = status;
    }
    status.className =
      `systemsculpt-agent-tail-status is-${presentation.phase}`;
    status.dataset.phase = presentation.phase;
    const timed = presentation.progressActive && presentation.phase !== "awaiting-approval";
    const backend = this.options.backendName?.() ?? "SystemSculpt";
    const latestActivity = [...presentation.visibleParts].reverse().find((part) =>
      part.kind === "tool" ? isActiveAgentToolState(part.state)
        : (part.kind === "text" || part.kind === "reasoning") && part.state === "streaming",
    );
    const activity = presentation.phase === "submitting"
      ? backend === "SystemSculpt" ? "Connecting…" : `Starting ${backend}…`
      : latestActivity && ["acting", "reasoning", "responding"].includes(presentation.phase)
        // The row adds its own elapsed time (spec 3.3: "Editing Plan.md · 12s").
        ? latestActivity.kind === "tool" ? presentAgentTool(latestActivity).label
          : latestActivity.kind === "text" ? "Writing" : "Thinking"
        : presentation.activityStatus;
    status.dataset.activityLabel = activity;
    const workingElapsedMs = timed ? this.startWorkingTimer(status, elapsedMs) : undefined;
    const workingDuration = formatAgentWorkingDuration(workingElapsedMs);
    const displayStatus = timed && workingDuration ? `${activity} · ${workingDuration}` : activity;
    const statusChanged = status.dataset.status !== displayStatus;
    if (statusChanged) {
      status.dataset.status = displayStatus;
      this.setTextNode(
        status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-label"),
        displayStatus,
      );
    }
    status.toggleAttribute("data-agent-working-timer", timed);
    const label = status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-label");
    label?.toggleAttribute("data-agent-working-duration", timed);
    if (!timed) this.stopWorkingTimer();
    const icon = status.querySelector<HTMLElement>(
      ".systemsculpt-agent-tail-status-icon",
    );
    const iconName = presentation.phase === "cancelled"
      ? "circle-stop"
      : presentation.phase === "failed"
        ? "circle-alert"
        : presentation.phase === "awaiting-approval"
          // A question carries the card's own question glyph; a permission, the shield.
          ? presentation.activityStatus === "Waiting for your answer" ? "message-circle-question" : "shield-question"
          : "loader-circle";
    if (icon && icon.dataset.iconState !== iconName) {
      setIcon(icon, iconName);
      icon.dataset.iconState = iconName;
    }
    icon?.classList.toggle("is-animated", timed);
    // Error cards announce failures; all polite events use the workspace announcer.
    // A failure without an error card still needs one alert (spec 6.3).
    const unannouncedFailure = presentation.phase === "failed"
      && !presentation.visibleParts.some((part) => part.kind === "error");
    if (unannouncedFailure) {
      status.setAttrs({ role: "alert", "aria-live": "assertive", "aria-atomic": "true" });
    } else {
      status.removeAttribute("role");
      status.removeAttribute("aria-live");
      status.removeAttribute("aria-atomic");
    }
    return status;
  }

  private startWorkingTimer(
    status: HTMLElement,
    elapsedMs: number | undefined,
  ): number | undefined {
    if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
      this.stopWorkingTimer();
      return undefined;
    }
    const observedAt = this.monotonicNow(status);
    const projectedElapsedMs = this.activeElapsedBaseline
      ? this.activeElapsedBaseline.elapsedMs
        + Math.max(0, observedAt - this.activeElapsedBaseline.observedAt)
      : elapsedMs;
    const rebasedElapsedMs = Math.max(elapsedMs, projectedElapsedMs);
    this.activeElapsedBaseline = {
      elapsedMs: rebasedElapsedMs,
      observedAt,
    };
    if (!this.visible || this.activeWorkingTimer !== null) return rebasedElapsedMs;
    const ownerWindow = getSurfaceOwnerWindow(status);
    this.activeWorkingWindow = ownerWindow;
    this.activeWorkingTimer = ownerWindow.setInterval(() => {
      if (!status.isConnected || !this.activeElapsedBaseline) {
        this.stopWorkingTimer();
        return;
      }
      const current = this.activeElapsedBaseline.elapsedMs
        + Math.max(0, this.monotonicNow(status) - this.activeElapsedBaseline.observedAt);
      const text = `${status.dataset.activityLabel ?? "Working"} · ${formatAgentWorkingDuration(current) ?? "0s"}`;
      if (status.dataset.status === text) return;
      status.dataset.status = text;
      this.setTextNode(
        status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-label"),
        text,
      );
    }, 1_000);
    return rebasedElapsedMs;
  }

  private monotonicNow(element: HTMLElement): number {
    const performance = getSurfaceOwnerWindow(element).performance;
    return performance
      ? (Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : 0) + performance.now()
      : Date.now();
  }

  private setTextNode(element: HTMLElement | null, text: string): void {
    if (!element) return;
    if (element.childNodes.length === 1 && element.firstChild!.nodeType === Node.TEXT_NODE) {
      element.firstChild!.nodeValue = text;
      return;
    }
    element.replaceChildren(element.ownerDocument.createTextNode(text));
  }

  private stopWorkingTimer(clearBaseline = true): void {
    if (this.activeWorkingTimer !== null) {
      this.activeWorkingWindow?.clearInterval(this.activeWorkingTimer);
      this.activeWorkingTimer = null;
      this.activeWorkingWindow = null;
    }
    if (clearBaseline) this.activeElapsedBaseline = null;
  }

  public transferPresentationState(
    desiredRows: readonly HTMLElement[],
  ): HTMLElement | null {
    const focusedElement = focusedElementWithin(this.options.conversation);
    let focusReplacement: HTMLElement | null = null;
    for (const row of desiredRows) {
      for (const historical of row.querySelectorAll<HTMLElement>(
        ".systemsculpt-agent-part[data-part-key]",
      )) {
        // The selector above guarantees the attribute exists. An empty value
        // cannot match a canonical active-node key, so the map lookup already
        // provides the same safe miss without a second lifecycle branch.
        const active = this.activeNodes.get(historical.dataset.partKey!);
        if (!active || active === historical) continue;

        restoreDetailsState(
          historical,
          captureDetailsState(active.querySelectorAll<HTMLDetailsElement>("details")),
          Array.from(historical.querySelectorAll<HTMLDetailsElement>("details")),
          (element, open) => this.options.updateDisclosureOpen(element, open),
        );

        if (!focusedElement || !active.contains(focusedElement)) continue;
        const focusKey = focusedElement.dataset.focusKey;
        focusReplacement = focusKey
          ? findFocusKey(historical, focusKey)
          : historical;
      }
    }
    return focusReplacement;
  }

  public clear(): void {
    this.options.approvals?.clear();
    this.toolRenderEpoch += 1;
    this.options.forgetMarkdown(this.root);
    this.root.empty();
    this.activeTurn = null;
    this.activeBody = null;
    this.activeTurnId = null;
    this.activeTailStatus = null;
    this.activeCompletedFold = null;
    this.activeCompletedFoldBody = null;
    this.stopWorkingTimer();
    this.activeOverflowNodes.clear();
    this.activeNodes.clear();
    this.activePartRefs.clear();
    this.activeToolDisplayFingerprints.clear();
    this.activeToolErrorSuppression.clear();
    this.options.conversation.setAttribute("aria-busy", "false");
  }


}
