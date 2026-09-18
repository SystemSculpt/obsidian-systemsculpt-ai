import { updateUiAction } from '../../../core/ui/surface';
import { renderStudioCommandCenter } from './StudioCommandCenterRenderer';
import { renderStudioRunCollection, renderStudioRunStatus } from './StudioRunCollectionRenderer';
import { renderStudioCodex, renderStudioCodexStop } from './StudioCodexRenderer';
import { renderStudioCollection } from './StudioCollectionRenderer';
import { renderStudioWorkflow } from './StudioWorkflowRenderer';
import { renderStudioNodeSourceBody } from './StudioNodeSourceBody';
import { resolveStudioNodeSurface } from './StudioNodeSurface';
import { commitInlineConfigValueChange } from './StudioGraphInlineConfigPanel';
import { renderStudioNodeInlineEditor, shouldSuppressNodeOutputPreview } from './StudioGraphNodeInlineEditors';
import { resolveStudioNodeDetailSectionVisibility } from './StudioGraphNodeDetailMode';
import { renderTextNodeCard } from './StudioGraphTextNodeCard';
import { isManagedOutputPlaceholderNode, readManagedPendingMediaKind } from '../../../studio/StudioManagedOutputNodes';
import { renderNodeHeader, renderNodePorts, renderNodeStatusRow } from './StudioGraphNodeCardSections';
import { bindNodeCardPointerDown, isStudioNodeCardInteractiveTarget } from './StudioGraphNodeCardPointer';
import { renderNodeMediaPreview, renderNodeOutputPreview, resolveMediaIngestRevealPath } from './StudioGraphNodeCardPreviews';
import type { RenderStudioGraphNodeCardOptions } from './StudioGraphNodeCardTypes';
import { renderStudioMediaNodeActionBar } from './StudioMediaNodeActionBar';
import { isStudioExpandedTextNodeKind, resolveStudioGraphNodeMinHeight, resolveStudioGraphNodeWidth } from '../../../studio/StudioNodeGeometry';
import { resolveNodeMediaPreview } from './StudioGraphMediaPreview';
import { mountStudioGraphNodeResizeFrame } from './StudioGraphNodeResizeFrame';
import { hasHostCapability } from '../../../platform/hostCapabilities';
import { nodeActivityFromRunState } from '../activity/StudioActivity';
import { applyStudioNodeActivity } from '../activity/StudioActivityDomApplier';

/**
 * One card per node, one primary surface per kind (see StudioNodeSurface):
 * media is the card, text is chromeless, code shows its source, forms show
 * their fields with the result beneath, panels own their body. No tabs.
 */
export type StudioGraphNodeCardHandle = {
  element: HTMLElement;
  updateGeometry: (node: RenderStudioGraphNodeCardOptions["node"]) => void;
  dispose: () => void;
};

export function renderStudioGraphNodeCard(options: RenderStudioGraphNodeCardOptions): StudioGraphNodeCardHandle {
  const { node, graphInteraction, nodeRunState } = options;
  const definition = options.findNodeDefinition(node);
  const placeholder = isManagedOutputPlaceholderNode(node);
  const locked = options.busy || placeholder;
  const teardowns: (() => void)[] = [];
  const nodeEl = options.layer.createDiv({ cls: 'ss-studio-node-card' });
  nodeEl.dataset.nodeId = node.id; nodeEl.dataset.nodeKind = node.kind;
  nodeEl.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
  nodeEl.style.width = `${resolveStudioGraphNodeWidth(node)}px`;
  const minimum = resolveStudioGraphNodeMinHeight(node);
  if (minimum > 0) nodeEl.style.minHeight = `${minimum}px`;
  nodeEl.classList.toggle('is-expanded-text-node', isStudioExpandedTextNodeKind(node.kind));
  nodeEl.classList.toggle('is-detail-collapsed', options.nodeDetailMode === 'collapsed');
  nodeEl.classList.toggle('is-selected', graphInteraction.isNodeSelected(node.id));
  nodeEl.classList.toggle('is-managed-pending', placeholder);
  graphInteraction.registerNodeElement(node.id, nodeEl);
  bindNodeCardPointerDown({ nodeEl, nodeId: node.id, graphInteraction });
  const outputs = nodeRunState.outputs as Record<string, unknown> | null;
  const media = resolveNodeMediaPreview(node, outputs);
  const mediaSrc = media && options.resolveAssetPreviewSrc ? options.resolveAssetPreviewSrc(media.path) : null;
  const surface = resolveStudioNodeSurface(node, { hasMedia: Boolean(definition && media && mediaSrc), placeholder });
  nodeEl.dataset.surface = surface.kind;
  const activity = options.nodeActivity ?? (placeholder ? { phase: 'active', label: 'Generating', detail: '', progress: null } as const : nodeActivityFromRunState(nodeRunState, 'running'));
  // The selected media model decides which inputs exist on this card.
  const mediaPlan = options.resolveMediaNodeInputPlan?.(node) ?? null;
  const portGating = { hiddenInputPortIds: new Set(mediaPlan?.hiddenInputPortIds ?? []), inputPortNotes: mediaPlan?.inputPortNotes ?? {},
    connectedInputPortIds: new Set((options.inboundEdges ?? []).map(edge => edge.toPortId)) };
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const teardown of teardowns) {
      try { teardown(); } catch { /* One detached surface must not block the remaining card cleanup. */ }
    }
  };
  const handle: StudioGraphNodeCardHandle = {
    element: nodeEl,
    updateGeometry: (nextNode) => {
      nodeEl.style.transform = `translate(${nextNode.position.x}px, ${nextNode.position.y}px)`;
      nodeEl.style.width = `${resolveStudioGraphNodeWidth(nextNode)}px`;
      const nextMinimum = resolveStudioGraphNodeMinHeight(nextNode);
      nodeEl.style.minHeight = nextMinimum > 0 ? `${nextMinimum}px` : "";
    },
    dispose,
  };
  const finish = (): StudioGraphNodeCardHandle => {
    applyStudioNodeActivity(nodeEl, activity);
    options.registerNodeTeardown?.(node.id, dispose);
    return handle;
  };
  const mountResizeFrame = (aspectContentEl?: HTMLElement | null): void => { mountStudioGraphNodeResizeFrame({ node, nodeEl,
    title: node.kind === 'studio.terminal' ? 'Resize terminal node' : 'Resize node', ariaLabel: node.kind === 'studio.terminal' ? 'Resize terminal node' : 'Resize node',
    interactionLocked: locked, getGraphZoom: () => graphInteraction.getGraphZoom(),
    showResizeGuides: (moving, edges) => graphInteraction.showNodeResizeGuides(node.id, moving, edges),
    onResizeGuidesEnd: () => graphInteraction.clearAlignmentGuides(), hasAspectMediaContent: media !== null,
    onNodeConfigMutated: options.onNodeConfigMutated, onNodeConfigValueChange: options.onNodeConfigValueChange,
    onNodeResize: options.onNodeResize, onNodeGeometryMutated: options.onNodeGeometryMutated,
    applySize: ({ width, height }) => { nodeEl.style.width = `${width}px`; if (height === null) return; if (node.kind === 'studio.terminal') nodeEl.style.height = `${height}px`; else nodeEl.style.minHeight = `${height}px`; },
    readInitialSize: () => { const aspect = aspectContentEl?.offsetHeight ?? 0; return { width: resolveStudioGraphNodeWidth(node), height: aspect > 0 ? aspect : nodeEl.offsetHeight > 0 ? nodeEl.offsetHeight : Math.max(minimum, 1) }; },
  }); };

  // ── Text: chromeless Markdown that edits in place ──
  if (surface.kind === 'text') {
    const registerEditorTeardown = options.registerTextNodeEditorTeardown
      ? (nodeId: string, teardown: Parameters<NonNullable<typeof options.registerTextNodeEditorTeardown>>[1]): void => {
          let snapshot: ReturnType<typeof teardown> | undefined;
          let tornDown = false;
          const guarded = (): ReturnType<typeof teardown> => {
            if (!tornDown) {
              snapshot = teardown();
              tornDown = true;
            }
            return snapshot!;
          };
          teardowns.push(() => { guarded(); });
          options.registerTextNodeEditorTeardown?.(nodeId, guarded);
        }
      : undefined;
    renderTextNodeCard({ nodeEl, node, busy: options.busy, graphInteraction,
      onNodeConfigMutated: options.onNodeConfigMutated, onNodeConfigValueChange: options.onNodeConfigValueChange,
      onNodeResize: options.onNodeResize, onNodeGeometryMutated: options.onNodeGeometryMutated,
      ...options.takeTextNodeEditorMountState(node.id),
      onRequestTextNodeEdit: options.onRequestTextNodeEdit, onStopTextNodeEdit: options.onStopTextNodeEdit,
      renderMarkdownPreview: options.renderMarkdownPreview, createMarkdownEditor: options.createTextNodeMarkdownEditor,
      registerEditorTeardown });
    renderNodePorts({ nodeEl, node, definition, graphInteraction, interactionLocked: locked, ...portGating });
    return finish();
  }

  // ── Media: the image or video is the card; actions ride below it ──
  if (surface.kind === 'media' && definition && media) {
    nodeEl.dataset.chromeLayout = 'media'; nodeEl.dataset.mediaKind = media.kind;
    const content = nodeEl.createDiv({ cls: 'ss-studio-media-content' });
    renderNodeStatusRow({ nodeEl: content, node, activity, resolveNodeBadge: options.resolveNodeBadge });
    renderNodePorts({ nodeEl: content, node, definition, graphInteraction, interactionLocked: locked, ...portGating });
    renderNodeMediaPreview({ nodeEl: content, node, nodeRunState, resolveAssetPreviewSrc: options.resolveAssetPreviewSrc,
      onRevealPathInFinder: options.onRevealPathInFinder, onOpenMediaPreview: options.onOpenMediaPreview });
    mountResizeFrame(content);
    renderStudioMediaNodeActionBar({ nodeEl: media.kind === 'video' ? content : nodeEl, node, definition, mediaKind: media.kind, interactionLocked: locked,
      onRunNode: options.onRunNode, onRemoveNode: options.onRemoveNode, onNodeConfigValueChange: options.onNodeConfigValueChange,
      onOpenImageEditor: options.onOpenImageEditor, onEditImageWithAi: options.onEditImageWithAi, onCopyNodeImageToClipboard: options.onCopyNodeImageToClipboard, pathBrowseOptions: options.pathBrowseOptions });
    if (hasHostCapability('file-manager-reveal', nodeEl)) nodeEl.addEventListener('dblclick', event => {
      if (isStudioNodeCardInteractiveTarget(event.target)) return;
      const path = resolveMediaIngestRevealPath(node, outputs, '');
      if (path) { event.stopPropagation(); options.onRevealPathInFinder(path); }
    });
    // The activity chip lives inside the media content for this layout.
    const chip = content.querySelector<HTMLElement>(':scope > .ss-studio-node-activity');
    if (chip) nodeEl.appendChild(chip);
    return finish();
  }

  // ── Code, form, and panel cards share the compact header chrome ──
  nodeEl.addClass('ss-studio-surface-card');
  const unavailable = definition?.requiredHostCapabilities.some(capability => !hasHostCapability(capability, nodeEl));
  let sourceBody: ReturnType<typeof renderStudioNodeSourceBody> | null = null;
  const header = renderNodeHeader({ nodeEl, node, interactionLocked: locked, runLocked: node.kind === 'studio.codex' && options.agentRuns ? false : locked,
    runUnavailableReason: unavailable ? 'This node needs a desktop execution connection.' : undefined,
    sourceToggle: surface.sourceToggle ? { isActive: () => sourceBody?.isSourceView() ?? false, onToggle: () => sourceBody?.toggleSource() } : undefined,
    onNodeTitleInput: options.onNodeTitleInput, onRunNode: options.onRunNode,
    onCopyTextGenerationPromptBundle: options.onCopyTextGenerationPromptBundle,
    onToggleTextGenerationOutputLock: options.onToggleTextGenerationOutputLock, onRemoveNode: options.onRemoveNode,
  });
  if (node.kind === 'studio.codex' || node.kind === 'studio.text_generation') renderStudioCodexStop(nodeEl, node.id, options.projectId || '');
  renderNodeStatusRow({ nodeEl, node, activity, resolveNodeBadge: options.resolveNodeBadge });
  if (node.kind === 'studio.codex' && options.agentRuns) teardowns.push(renderStudioRunStatus(nodeEl, options.agentRuns, options.projectId || '', node.id));
  renderNodePorts({ nodeEl, node, definition, graphInteraction, interactionLocked: locked, ...portGating });

  if (placeholder) {
    const pending = nodeEl.createDiv({ cls: `ss-studio-node-pending-preview ${node.kind === 'studio.media_ingest' ? 'is-media' : 'is-text'}` });
    pending.createDiv({ cls: 'ss-studio-node-pending-title', text: node.kind === 'studio.media_ingest' ? (readManagedPendingMediaKind(node) === 'video' ? 'Generating video…' : 'Generating image…') : 'Generating text…' });
    if (node.kind === 'studio.media_ingest') pending.createDiv({ cls: 'ss-studio-node-pending-frame' });
    else { pending.createDiv({ cls: 'ss-studio-node-pending-line' }); pending.createDiv({ cls: 'ss-studio-node-pending-line' }); pending.createDiv({ cls: 'ss-studio-node-pending-line is-short' }); }
    mountResizeFrame(); return finish();
  }
  if (!definition) {
    nodeEl.createEl('p', { cls: 'ss-studio-inline-error', text: `Missing definition for ${node.kind}@${node.version}.` });
    mountResizeFrame(); return finish();
  }

  const change = (key: string, value: Parameters<typeof commitInlineConfigValueChange>[0]['value']) => commitInlineConfigValueChange({ node, key, value, onNodeConfigValueChange: options.onNodeConfigValueChange, onNodeConfigMutated: options.onNodeConfigMutated });
  const renderPanel = (root: HTMLElement): (() => void) | void => {
    if (node.kind === 'studio.command_center' || node.kind === 'studio.button') return renderStudioCommandCenter(root, { node, nodes: options.projectNodes || [], projectId: options.projectId || '', projectPath: options.projectPath, busy: options.busy, runs: options.agentRuns, getRunState: options.getRelatedNodeRunState, definition: options.findNodeDefinition, run: options.onRunNode,
      onExecutionChange: value => change('execution', value), focus: id => { graphInteraction.setSelectedNodeIds([id]); graphInteraction.fitSelectedNodesInViewport(); } });
    if (node.kind === 'studio.run_collection' && options.agentRuns && options.projectPath) return renderStudioRunCollection(root, { runs: options.agentRuns, projectId: options.projectId || '', projectPath: options.projectPath, sources: Array.isArray(node.config.sources) ? node.config.sources.filter((value): value is string => typeof value === 'string') : [], compact: false, groupBy: String(node.config.groupBy || 'status'), showCompleted: node.config.showCompleted !== false });
    if (node.kind === 'studio.collection') return renderStudioCollection(root, { node, outputs: nodeRunState.outputs || {}, scope: options.projectId, onChange: change });
    if (node.kind === 'studio.workflow') return renderStudioWorkflow(root, { node, onChange: change });
    root.createDiv({ cls: 'ss-studio-source-empty', text: 'This panel is available once its project is open.' });
  };

  if (surface.kind === 'code' || surface.kind === 'panel') {
    sourceBody = renderStudioNodeSourceBody(nodeEl, { node, definition, scope: options.projectId, locked, mode: surface.kind === 'panel' ? 'panel' : 'source',
      onApply: options.onNodeSourceApply, renderPanel: surface.kind === 'panel' ? renderPanel : undefined,
      onViewChange: view => { if (header.sourceToggle) updateUiAction(header.sourceToggle, { selected: view === 'source' }); } });
    teardowns.push(sourceBody.dispose);
    if (surface.kind === 'code') renderNodeOutputPreview({ nodeEl, node, nodeRunState, showOutputPreview: true });
  } else {
    const visible = (section: 'textEditor' | 'systemPrompt' | 'outputPreview' | 'fieldHelp') => resolveStudioNodeDetailSectionVisibility({ node, mode: options.nodeDetailMode, section });
    renderStudioNodeInlineEditor({ nodeEl, node, nodeRunState, definition, inboundEdges: options.inboundEdges, interactionLocked: locked,
      onNodeConfigMutated: options.onNodeConfigMutated, onNodeConfigValueChange: options.onNodeConfigValueChange,
      renderMarkdownPreview: options.renderMarkdownPreview, resolveDynamicSelectOptions: options.resolveDynamicSelectOptions, pathBrowseOptions: options.pathBrowseOptions,
      openMediaModelPicker: options.openMediaModelPicker, mediaInputPlan: mediaPlan,
      nodeDetailMode: options.nodeDetailMode, showTextEditor: visible('textEditor'), showSystemPromptField: visible('systemPrompt'), showOutputPreview: visible('outputPreview'), showFieldHelp: visible('fieldHelp') });
    if (node.kind === 'studio.codex') {
      const result = nodeEl.createDiv({ cls: 'ss-studio-node-result' });
      if (options.agentRuns && options.projectPath) teardowns.push(renderStudioRunCollection(result, { runs: options.agentRuns, projectId: options.projectId || '', projectPath: options.projectPath, sources: [node.id], compact: true, groupBy: 'status', showCompleted: node.config.showCompleted !== false }) || (() => {}));
      else renderStudioCodex(result, node, options.projectId || '', nodeRunState.outputs || {}, change);
    } else if (media && mediaSrc) {
      renderNodeMediaPreview({ nodeEl, node, nodeRunState, resolveAssetPreviewSrc: options.resolveAssetPreviewSrc, onRevealPathInFinder: options.onRevealPathInFinder, onOpenMediaPreview: options.onOpenMediaPreview });
    } else if (!shouldSuppressNodeOutputPreview(node.kind)) {
      renderNodeOutputPreview({ nodeEl, node, nodeRunState, showOutputPreview: visible('outputPreview') });
    }
  }
  mountResizeFrame();
  return finish();
}
