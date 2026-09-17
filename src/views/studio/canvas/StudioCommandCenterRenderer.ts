import { renderStudioOrchestrator } from './StudioOrchestratorRenderer';
import { renderStudioCommandExecution } from './StudioCommandExecutionControls';
import type { StudioCommandExecution } from '../../../studio/StudioCommandExecution';
import { statusLabelForNode, type StudioNodeRunDisplayState } from '../StudioRunPresentationState';
import { isStudioVisualOnlyNodeKind } from '../../../studio/StudioNodeKinds';
import { readStudioCommandActions } from '../../../studio/nodes/commandCenterNode';
import { hasHostCapability } from '../../../platform/hostCapabilities';
import type { StudioNodeDefinition, StudioNodeInstance } from '../../../studio/types';
import type { StudioAgentRuns } from '../../../services/codex/StudioAgentRuns';
import { isActiveAgentRun } from '../../../services/codex/StudioAgentRunStore';
import { createStudioAction } from '../StudioAction';
import { markStudioNodeCardInteractive } from './StudioGraphNodeCardPointer';

export function renderStudioCommandCenter(root: HTMLElement, options: {
  node: StudioNodeInstance; nodes: StudioNodeInstance[]; busy: boolean; projectId: string; projectPath?: string; runs?: StudioAgentRuns;
  onExecutionChange?: (value: StudioCommandExecution) => void;
  getRunState?: (nodeId: string) => StudioNodeRunDisplayState;
  definition: (node: StudioNodeInstance) => StudioNodeDefinition | null;
  run: (nodeId: string) => void; focus: (nodeId: string) => void;
}): () => void {
  const panel = root.createDiv({ cls: 'ss-studio-command-center' }); markStudioNodeCardInteractive(panel);
  let actions: ReturnType<typeof readStudioCommandActions>;
  const single = options.node.kind === 'studio.button';
  if (single) panel.addClass('is-single-button');
  try { actions = readStudioCommandActions(single ? (options.node.config.target ? [{ id: 'button', label: options.node.config.label, kind: options.node.config.action, target: options.node.config.target, section: 'Actions', description: options.node.config.description }] : []) : options.node.config.actions); }
  catch (error) { panel.createDiv({ text: error instanceof Error ? error.message : 'Invalid command configuration.' }); return () => {}; }
  const execution = (root: HTMLElement) => renderStudioCommandExecution(root, { value: options.node.config.execution, app: options.runs?.app, onChange: options.onExecutionChange });
  const disposeExecution = single ? () => {} : options.runs && options.projectPath ? renderStudioOrchestrator(panel, { runs: options.runs, projectId: options.projectId, projectPath: options.projectPath, centerId: options.node.id, execution }) : execution(panel);
  if (!actions.length) panel.createDiv({ cls: 'ss-studio-command-intro', text: single ? 'Choose this button’s target in Source.' : 'Add actions in Source.' });
  if (!single && options.node.config.description) panel.createDiv({ cls: 'ss-studio-command-intro', text: String(options.node.config.description) });
  const targets = new Map(options.nodes.map(node => [node.id, node]));
  const summaries = new Map<string, HTMLElement>();
  for (const section of new Set(actions.map(action => action.section))) {
    const region = panel.createEl('section', { cls: 'ss-studio-command-section' });
    region.createEl('h3', { text: section });
    const grid = region.createDiv({ cls: 'ss-studio-command-grid' });
    for (const action of actions.filter(action => action.section === section)) {
      const target = targets.get(action.target), definition = target ? options.definition(target) : null;
      const unavailable = !target || (action.kind === 'run' && (!definition || isStudioVisualOnlyNodeKind(target.kind) || definition.requiredHostCapabilities.some(capability => !hasHostCapability(capability, panel))));
      const card = grid.createDiv({ cls: `ss-studio-command-item is-${action.kind}` });
      createStudioAction(card, { label: action.label, icon: action.kind === 'run' ? 'play' : 'arrow-up-right', testId: `studio.command.${action.id}`, className: 'ss-studio-command-button',
        disabled: unavailable || (action.kind === 'run' && options.busy && target?.kind !== 'studio.codex'), title: unavailable ? 'This action is unavailable on this device or its target was removed.' : action.description,
        onSelect: () => { if (action.kind === 'run') options.run(action.target); else options.focus(action.target); } });
      if (action.description) card.createDiv({ cls: 'ss-studio-command-description', text: action.description });
      if (action.kind === 'run' && target?.kind === 'studio.codex') summaries.set(target.id, card.createDiv({ cls: 'ss-studio-command-status' }));
      else if (action.kind === 'run' && target) { const state = options.getRunState?.(target.id); if (state && state.status !== 'idle') card.createDiv({ cls: 'ss-studio-command-status', text: statusLabelForNode(state.status) }); }
    }
  }
  const update = (): void => { for (const [id, element] of summaries) {
    const records = options.runs?.list(options.projectId, [id]) || [], active = records.filter(run => isActiveAgentRun(run.status));
    element.setText(active.length ? `${active.length} active · ${active[0].currentActivity.slice(0, 80)}` : records.length ? `Last run: ${records[0].status}` : '');
  } };
  update(); const unsubscribe = options.runs?.subscribe(id => { if (id === options.projectId) update(); });
  return () => { disposeExecution(); unsubscribe?.(); };
}
