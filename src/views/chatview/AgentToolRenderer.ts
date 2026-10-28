import type { App, Component } from "obsidian";
import { setIcon } from "obsidian";
import { createSurfaceElement } from "../../core/ui/surface";
import type { ToolCall } from "../../types/toolCalls";
import type { AgentArtifact, AgentToolPart } from "../../chat/ChatConversation";
import { renderOperationsInlinePreview, renderWriteEditInlineDiff } from "./ToolCallPreview";
import { presentAgentTool, presentAgentToolDetails, presentToolLineMeta } from "./AgentToolPresentation";
import type { AgentApprovalCards } from "./AgentApprovalCards";
import { renderNativeToolPreview } from "./NativeToolPresentation";
import { renderHostedToolPreview } from "./HostedToolPreview";
import { ACTIONABLE_ARTIFACT_TOOLS, toolCallForPart, visibleToolError } from "./ConversationPartPresentation";

type ToolApprovalPreviewHydrationState = {
  container: HTMLElement;
  preview: HTMLElement;
  fingerprint: string;
  toolCall: ToolCall;
  part: AgentToolPart;
  lifecycleGeneration: number;
  toolRenderEpoch: number;
  hydration: Promise<void> | null;
};

type AgentToolRendererOptions = Readonly<{
  app: App;
  component: Component;
  approvals: AgentApprovalCards;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  renderArtifact: (parent: HTMLElement, artifact: AgentArtifact) => void;
  beginLayoutMutation?: (control?: HTMLElement, target?: HTMLElement) => (() => void) | undefined;
  nextDisclosureId: () => string;
  isRenderingEnabled: () => boolean;
  lifecycleGeneration: () => number;
  renderEpoch: () => number;
  trackDisclosure: (element: HTMLElement, available: boolean, open: boolean) => void;
  updateDisclosure: (element: HTMLElement, available: boolean, open: boolean) => void;
  untrackDisclosures: (target: HTMLElement) => void;
}>;

/** Owns tool DOM reuse, approval previews, and lazy tool-detail hydration. */
export class AgentToolRenderer {
  private readonly toolApprovalPreviewHydrationStates = new WeakMap<HTMLElement, ToolApprovalPreviewHydrationState>();
  private readonly toolDetailHydrators = new WeakMap<HTMLElement, () => void>();

  constructor(private readonly options: AgentToolRendererOptions) {}

  public render(
    node: HTMLElement,
    part: AgentToolPart,
    suppressToolError = false,
    progressActive = true,
  ): boolean {
    const presentation = presentAgentTool(part);
    const approvalRequired = (part.location === "vault" || part.native)
      && part.state === "approval-required"
      && Boolean(part.approvalId);
    const existingApproval = node.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval",
    );
    let retainedNativePreview = !approvalRequired
      ? node.querySelector<HTMLElement>(
        ":scope > .systemsculpt-agent-tool > .systemsculpt-agent-tool-support > .systemsculpt-agent-resolved-preview",
      )
      : null;
    const reviewedPreview = existingApproval?.querySelector(".systemsculpt-agent-approval-preview")?.hasChildNodes();
    if (!approvalRequired && existingApproval && (part.native || reviewedPreview)) {
      // Keep the exact preview reviewed before execution, not a new diff against
      // the now-modified vault file. Move only the preview and raw disclosure;
      // pending actions and answer fields must not survive resolution.
      retainedNativePreview = createSurfaceElement(node.ownerDocument, "div");
      retainedNativePreview.className = "systemsculpt-agent-resolved-preview";
      retainedNativePreview.dataset.approvalFingerprint = existingApproval.dataset.approvalFingerprint;
      for (const child of existingApproval.querySelectorAll<HTMLElement>(
        ":scope > .systemsculpt-agent-approval-preview, :scope > .systemsculpt-agent-approval-details",
      )) retainedNativePreview.appendChild(child);
      const hydration = this.toolApprovalPreviewHydrationStates.get(node);
      if (hydration?.container === existingApproval) hydration.container = retainedNativePreview;
    }
    const detailRows = presentAgentToolDetails(part);
    const actionableArtifacts = ACTIONABLE_ARTIFACT_TOOLS.has(presentation.canonicalName)
      ? part.output?.artifacts ?? []
      : [];
    const toolError = part.error && !suppressToolError
      ? visibleToolError(part) ?? "This action could not be completed."
      : null;
    const hasReadablePayload = Boolean(part.native) || part.location === "vault";
    const isQuestion = part.name === "AskUserQuestion" || part.native?.requestMethod?.endsWith("/requestUserInput");
    const hasDetail = detailRows.length > 0 || Boolean(toolError) || actionableArtifacts.length > 0
      || Boolean(retainedNativePreview) || hasReadablePayload;
    const supportFingerprint = JSON.stringify({
      input: hasReadablePayload ? part.input : undefined,
      output: hasReadablePayload && !isQuestion ? part.output : undefined,
      detailRows,
      toolError,
      actionableArtifacts,
      suppressToolError,
      retainedNativePreview: Boolean(retainedNativePreview),
    });
    const supportNeedsRender = node.dataset.toolSupportFingerprint !== supportFingerprint
      || !node.querySelector(":scope > .systemsculpt-agent-tool > .systemsculpt-agent-tool-support")
      || !node.querySelector(
        ":scope > .systemsculpt-agent-tool > .systemsculpt-agent-tool-header .systemsculpt-agent-tool-state-icon",
      );

    const stagedSupport = createSurfaceElement(node.ownerDocument, "div");
    stagedSupport.className = "systemsculpt-agent-tool-support";
    if (supportNeedsRender && detailRows.length > 0) {
      const detailsList = stagedSupport.createEl("pre", {
        cls: "systemsculpt-agent-tool-details",
        attr: { tabindex: "0" },
      });
      for (const detail of detailRows) {
        const row = detailsList.createSpan({ cls: "systemsculpt-agent-tool-detail" });
        row.createSpan({ cls: "systemsculpt-agent-tool-detail-label", text: detail.label });
        row.appendText(": ");
        row.createSpan({ cls: "systemsculpt-agent-tool-detail-value", text: detail.value });
      }
    }
    if (supportNeedsRender && hasReadablePayload && !retainedNativePreview) {
      stagedSupport.createDiv({ cls: "systemsculpt-agent-tool-preview" });
      const raw = stagedSupport.createEl("details", { cls: "systemsculpt-agent-tool-raw" });
      raw.createEl("summary", { text: "Details" });
      const rawCode = raw.createEl("pre", { attr: { tabindex: "0" } }).createEl("code");
      raw.addEventListener("toggle", () => {
        if (raw.open && !rawCode.hasChildNodes()) {
          rawCode.setText(JSON.stringify({ input: part.input, ...(!isQuestion && part.output ? { output: part.output.data } : {}) }, null, 2));
        }
      });
    }
    if (supportNeedsRender && toolError) {
      stagedSupport.createDiv({
        cls: "systemsculpt-agent-tool-error",
        text: toolError,
        attr: { role: "alert" },
      });
    }
    if (supportNeedsRender) {
      for (const artifact of actionableArtifacts) {
        this.options.renderArtifact(stagedSupport, artifact);
      }
    }

    const approvalFingerprint = approvalRequired
      ? JSON.stringify({
        approvalId: part.approvalId,
        canonicalName: presentation.canonicalName,
        input: part.input,
        native: part.native,
      })
      : null;
    const reusableApproval = approvalFingerprint
      && existingApproval?.dataset.approvalFingerprint === approvalFingerprint
      ? existingApproval
      : null;
    const stagedApproval = approvalRequired && !reusableApproval
      ? this.options.approvals.create(part, presentation.canonicalName)
      : null;
    if (stagedApproval && approvalFingerprint) {
      stagedApproval.dataset.approvalFingerprint = approvalFingerprint;
    }
    node.className = `systemsculpt-agent-part is-tool is-${presentation.displayState}`;
    node.dataset.agentActivityRow = "";
    node.dataset.activityKind = "tool";
    delete node.dataset.toolCount;
    let shell = node.querySelector<HTMLElement>(":scope > .systemsculpt-agent-tool");
    let header = shell?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-header",
    ) ?? null;
    let copy = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-copy",
    ) ?? null;
    let controls = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-controls",
    ) ?? null;
    let disclosureIcon = header?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-disclosure",
    ) ?? null;
    let icon = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-icon",
    ) ?? null;
    let label = header?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-label",
    ) ?? null;
    let summary = header?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-summary",
    ) ?? null;
    let stateIcon = header?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-state-icon",
    ) ?? null;
    let support = shell?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-support",
    ) ?? null;
    const preservedOpen = shell?.instanceOf(HTMLDetailsElement) === true
      ? shell.open
      : false;
    let rebuiltShell = false;
    if (
      !shell
      || !shell.instanceOf(HTMLDetailsElement)
      || !header
      || !copy
      || !controls
      || !disclosureIcon
      || !icon
      || !label
      || !summary
      || !stateIcon
      || !support
    ) {
      this.options.untrackDisclosures(node);
      node.empty();
      rebuiltShell = true;
      shell = node.createEl("details", {
        cls: "systemsculpt-agent-tool",
        attr: {
          "data-agent-part-disclosure": "",
          "data-activity-kind": "tool",
        },
      });
      header = shell.createEl("summary", {
        cls: "systemsculpt-agent-tool-header",
        attr: { role: "button", "aria-expanded": "false", "data-testid": "chat.tool.toggle" },
      });
      icon = header.createSpan({ cls: "systemsculpt-agent-tool-icon" });
      copy = header.createSpan({ cls: "systemsculpt-agent-tool-copy" });
      label = copy.createEl("strong", {
        cls: "systemsculpt-agent-tool-label",
      });
      summary = copy.createSpan({
        cls: "systemsculpt-agent-tool-summary",
      });
      controls = header.createSpan({ cls: "systemsculpt-agent-tool-controls" });
      disclosureIcon = controls.createSpan({
        cls: "systemsculpt-agent-tool-disclosure",
      });
      disclosureIcon.setAttribute("aria-hidden", "true");
      stateIcon = controls.createSpan({ cls: "systemsculpt-agent-tool-state-icon" });
      stateIcon.setAttribute("aria-hidden", "true");
      header.dataset.focusKey = "tool-summary";
      const createdShell = shell as HTMLDetailsElement;
      header.addEventListener("click", (event) => {
        if (!createdShell.classList.contains("is-disclosure")) event.preventDefault();
      });
      createdShell.addEventListener("toggle", () => {
        createdShell.querySelector("summary")?.setAttribute("aria-expanded", String(createdShell.open));
        if (createdShell.open) this.toolDetailHydrators.get(node)?.();
        this.options.updateDisclosure(
          createdShell,
          createdShell.classList.contains("is-disclosure"),
          createdShell.open,
        );
      });
      const supportId = this.options.nextDisclosureId();
      header.setAttribute("aria-controls", supportId);
      support = shell.createDiv({ cls: "systemsculpt-agent-tool-support", attr: { id: supportId } });
      createdShell.open = preservedOpen && hasDetail;
    }

    shell.classList.toggle("is-disclosure", hasDetail);
    if (!hasDetail && (shell as HTMLDetailsElement).open) {
      (shell as HTMLDetailsElement).open = false;
    }
    this.options.trackDisclosure(
      shell,
      hasDetail,
      hasDetail && (shell as HTMLDetailsElement).open,
    );
    if (hasDetail) {
      if (disclosureIcon.dataset.iconName !== "chevron-down") {
        setIcon(disclosureIcon, "chevron-down");
        disclosureIcon.dataset.iconName = "chevron-down";
      }
    } else if (disclosureIcon.hasChildNodes()) {
      disclosureIcon.empty();
      delete disclosureIcon.dataset.iconName;
    }
    const accessibleState = presentation.displayState === "succeeded" ? "Done" : "";
    header.removeAttribute("aria-label");
    if (accessibleState) header.setAttribute("aria-description", accessibleState);
    else header.removeAttribute("aria-description");
    header.setAttribute("aria-expanded", String((shell as HTMLDetailsElement).open));
    icon.setAttribute("aria-hidden", "true");
    icon.classList.toggle("is-animated", progressActive && presentation.icon === "loader-circle");
    const actionIcon = presentation.icon;
    if (icon.dataset.iconName !== actionIcon) {
      setIcon(icon, actionIcon);
      icon.dataset.iconName = actionIcon;
    }
    if (stateIcon.dataset.iconState !== presentation.icon) {
      setIcon(stateIcon, presentation.icon);
      stateIcon.dataset.iconState = presentation.icon;
    }
    const decision = part.approvalDecision ?? (part.approvalId && !approvalRequired
      ? part.state === "denied" ? "denied"
        : part.state === "cancelled" || part.state === "outcome-unknown" ? "withdrawn"
          : part.state === "approved" || part.state === "running" || part.state === "succeeded" ? "approved" : undefined
      : undefined);
    const decisionLabel = decision === "withdrawn" ? "Withdrawn" : decision === "denied" ? "Denied"
      : part.approvalScope === "session" ? "Approved for this chat" : "Approved";
    const planDecision = part.name === "ExitPlanMode" && decision;
    const displayLabel = planDecision
      ? decision === "denied" ? "Kept planning" : decision === "withdrawn" ? "Plan withdrawn" : "Plan started"
      : isQuestion && decision ? decision === "denied" ? "Skipped" : "Answered question"
        : decision ? `${presentation.label} · ${decisionLabel}` : presentation.label;
    if (label.textContent !== displayLabel) {
      label.setText(displayLabel);
      const target = presentation.targetPath;
      const basename = target?.split("/").pop();
      const index = basename ? displayLabel.indexOf(basename) : -1;
      if (target && basename && index >= 0) {
        label.setText(displayLabel.slice(0, index));
        const link = label.createEl("a", {
          text: basename, attr: { href: target, "data-href": target, "data-testid": "chat.tool.open-path" },
        });
        link.onclick = (event) => {
          event.preventDefault(); event.stopPropagation();
          void this.options.onOpenArtifact({ id: target, path: target, title: basename, kind: "vault_file" });
        };
        label.appendText(displayLabel.slice(index + basename.length));
      }
    }
    shell.toggleAttribute("hidden", Boolean(approvalRequired));
    if (existingApproval && !approvalRequired) (shell as HTMLDetailsElement).open = false;
    const meta = presentToolLineMeta(presentation);
    if (meta) {
      if (summary.textContent !== meta) summary.setText(meta);
      summary.toggleAttribute("hidden", false);
    } else {
      if (summary.textContent) summary.setText("");
      summary.toggleAttribute("hidden", true);
    }
    if (supportNeedsRender || rebuiltShell) {
      support.replaceChildren(...Array.from(stagedSupport.childNodes));
      node.dataset.toolSupportFingerprint = supportFingerprint;
    }
    if (retainedNativePreview && retainedNativePreview.parentElement !== support) {
      support.appendChild(retainedNativePreview);
    }
    support.toggleAttribute("hidden", !support.hasChildNodes());
    const previewHost = support.querySelector<HTMLElement>(":scope > .systemsculpt-agent-tool-preview");
    if (previewHost && !retainedNativePreview) {
      const currentSupport = support;
      const currentHeader = header;
      this.toolDetailHydrators.set(node, () => {
        if (previewHost.dataset.hydrated === supportFingerprint) return;
        previewHost.dataset.hydrated = supportFingerprint;
        const staging = createSurfaceElement(node.ownerDocument, "div");
        const rendered = part.native
          ? renderNativeToolPreview(this.options.app, staging, part, this.options.component)
          : Promise.resolve().then(() => renderHostedToolPreview(this.options.app, staging, part, this.options.component, {
            onOpenPath: (path) => this.options.onOpenArtifact({ id: path, path, title: path, kind: "vault_file" }),
          }));
        void rendered.then((hasPreview) => {
          if (!this.options.isRenderingEnabled() || !node.isConnected || !currentSupport.contains(previewHost)
            || node.dataset.toolSupportFingerprint !== supportFingerprint) return;
          const finish = this.options.beginLayoutMutation?.(currentHeader, previewHost);
          try {
            if (hasPreview) currentSupport.querySelector(":scope > .systemsculpt-agent-tool-details")?.remove();
            previewHost.replaceChildren(...Array.from(staging.childNodes));
          } finally { finish?.(); }
        }).catch(() => { delete previewHost.dataset.hydrated; });
      });
      // A pending card hides the shell and shows its own preview; hydrate once it resolves.
      if ((shell as HTMLDetailsElement).open && !approvalRequired) this.toolDetailHydrators.get(node)?.();
    } else {
      this.toolDetailHydrators.delete(node);
    }
    const currentApproval = node.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval",
    );
    const desiredApproval = reusableApproval ?? stagedApproval;
    if (desiredApproval) {
      if (currentApproval && currentApproval !== desiredApproval) {
        currentApproval.replaceWith(desiredApproval);
      } else if (desiredApproval.parentElement !== node) {
        node.appendChild(desiredApproval);
      }
    } else {
      currentApproval?.remove();
    }
    if (desiredApproval && approvalFingerprint) {
      this.prepareToolApprovalPreviewHydration(
        node,
        desiredApproval,
        approvalFingerprint,
        toolCallForPart(part),
        part,
      );
    } else if (!retainedNativePreview) {
      this.toolApprovalPreviewHydrationStates.delete(node);
    }
    return true;
  }

  private prepareToolApprovalPreviewHydration(
    node: HTMLElement,
    approval: HTMLElement,
    fingerprint: string,
    toolCall: ToolCall,
    part: AgentToolPart,
  ): void {
    const existing = this.toolApprovalPreviewHydrationStates.get(node);
    if (
      existing
      && existing.container === approval
      && existing.fingerprint === fingerprint
      && existing.lifecycleGeneration === this.options.lifecycleGeneration()
    ) {
      return;
    }
    const preview = approval.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval-preview",
    );
    if (!preview) return;
    this.toolApprovalPreviewHydrationStates.set(node, {
      container: approval,
      preview,
      fingerprint,
      toolCall,
      part,
      lifecycleGeneration: this.options.lifecycleGeneration(),
      toolRenderEpoch: this.options.renderEpoch(),
      hydration: null,
    });
  }

  public hydrateApprovalPreview(
    node: HTMLElement,
  ): Promise<void> | null {
    const state = this.toolApprovalPreviewHydrationStates.get(node);
    if (!state) return null;
    if (state.hydration) return state.hydration;
    state.hydration = this.hydrateToolApprovalPreview(node, state).catch(() => undefined);
    return state.hydration;
  }

  private async hydrateToolApprovalPreview(
    node: HTMLElement,
    state: ToolApprovalPreviewHydrationState,
  ): Promise<void> {
    const staging = createSurfaceElement(state.preview.ownerDocument, "div");
    try {
      const native = await renderNativeToolPreview(this.options.app, staging, state.part, this.options.component);
      if (!native) {
        const diff = await renderWriteEditInlineDiff(this.options.app, staging, state.toolCall);
        if (!diff) await renderOperationsInlinePreview(staging, state.toolCall);
      }
    } catch {
      return;
    }
    if (!this.isCurrentToolApprovalPreview(node, state)) return;
    const finishLayoutMutation = this.options.beginLayoutMutation?.(
      undefined,
      state.preview,
    );
    try {
      if (!this.isCurrentToolApprovalPreview(node, state)) return;
      state.preview.replaceChildren(...Array.from(staging.childNodes));
      if (staging.dataset.changeSize) {
        const meta = state.container.querySelector<HTMLElement>(".systemsculpt-agent-approval-meta");
        if (meta && !meta.querySelector(".systemsculpt-agent-change-size")) {
          if (meta.textContent?.trim()) meta.appendText(" · ");
          meta.createSpan({ cls: "systemsculpt-agent-change-size", text: staging.dataset.changeSize });
          meta.removeAttribute("hidden");
        }
      }
      state.preview.toggleAttribute("hidden", !state.preview.hasChildNodes());
    } finally {
      finishLayoutMutation?.();
    }
  }

  private isCurrentToolApprovalPreview(
    node: HTMLElement,
    state: ToolApprovalPreviewHydrationState,
  ): boolean {
    return this.options.isRenderingEnabled()
      && state.lifecycleGeneration === this.options.lifecycleGeneration()
      && state.toolRenderEpoch === this.options.renderEpoch()
      && this.toolApprovalPreviewHydrationStates.get(node) === state
      && node.isConnected
      && state.container.isConnected
      && state.container.dataset.approvalFingerprint === state.fingerprint
      && state.container.contains(state.preview)
      && node.contains(state.container);
  }

}
