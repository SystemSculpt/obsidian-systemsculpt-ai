import { Notice } from 'obsidian';
import type { StudioAgentRuns } from '../../../services/codex/StudioAgentRuns';
import { isActiveAgentRun } from '../../../services/codex/StudioAgentRunStore';
import { workflowOpen } from '../../../services/codex/StudioWorkflow';
import { hasHostCapability } from '../../../platform/hostCapabilities';
import { createStudioAction } from '../StudioAction';
import { StudioRunDetailModal } from './StudioRunDetailModal';
import { activityPhaseFromWorkflowStatus, activityPhaseFromWorkflowStepStatus } from '../activity/StudioActivity';
const drafts = new Map<string, string>();
const report = (error: unknown): void => { new Notice(error instanceof Error ? error.message : 'Workflow action failed.'); };

/** The model-authored plan is a live canvas surface; input elements survive activity updates. */
export function renderStudioOrchestrator(root: HTMLElement, options: {
  runs: StudioAgentRuns; projectId: string; projectPath: string; centerId: string;
  execution: (root: HTMLElement) => () => void;
}): () => void {
  const { runs, projectId, projectPath, centerId } = options;
  const region = root.createEl('section', { cls: 'ss-studio-orchestrator', attr: { 'aria-label': 'Studio workflows' } });
  const key = `${projectId}:${centerId}`;
  let disposeExecution = () => {};
  if (hasHostCapability('local-cli', region)) {
    region.createEl('h3', { text: 'What do you want to accomplish?' });
    const prompt = region.createEl('textarea', { cls: 'ss-studio-workflow-prompt', attr: { 'data-testid': 'studio.workflow.prompt', 'aria-label': 'Workflow objective', placeholder: 'Find and test a new benchmark. Prepare a local branch for my review…', rows: '3', maxlength: '16000' } });
    prompt.value = drafts.get(key) || '';
    prompt.addEventListener('input', () => { drafts.set(key, prompt.value); while (drafts.size > 50) drafts.delete(drafts.keys().next().value); });
    disposeExecution = options.execution(region);
    let starting = false;
    const start = createStudioAction(region, { label: 'Start workflow', icon: 'play', testId: 'studio.workflow.start', className: 'ss-studio-workflow-start', onSelect: () => {
      if (starting || !prompt.value.trim()) return;
      const objective = prompt.value; starting = true; start.disabled = true;
      void runs.startWorkflow(projectPath, centerId, objective).then(() => { if (prompt.value === objective) { prompt.value = ''; drafts.delete(key); } update(); }).catch(report).finally(() => { starting = false; start.disabled = false; });
    } });
    prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); start.click(); } });
  }
  const list = region.createDiv({ cls: 'ss-studio-workflow-list' });
  let limit = 8;
  const more = createStudioAction(region, { label: 'Show more workflows', testId: 'studio.workflow.more', onSelect: () => { limit += 8; update(); } });
  const cards = new Map<string, { root: HTMLElement; update: () => void }>();
  const update = (): void => {
    const all = runs.list(projectId), matching = all.filter(run => run.nodeId === centerId && run.workflow);
    const active = matching.filter(run => workflowOpen(run.workflow) || isActiveAgentRun(run.status));
    const workflows = [...active, ...matching.filter(run => !active.includes(run))].slice(0, limit);
    more.hidden = workflows.length >= matching.length;
    const visible = new Set(workflows.map(run => run.id));
    for (const [id, card] of cards) if (!visible.has(id)) { card.root.remove(); cards.delete(id); }
    for (const [index, run] of workflows.entries()) {
      if (!cards.has(run.id)) {
        const card = list.createEl('details', { cls: 'ss-studio-workflow-card', attr: { 'data-workflow-id': run.id } });
        card.open = workflowOpen(run.workflow) || isActiveAgentRun(run.status);
        const header = card.createEl('summary', { cls: 'ss-studio-workflow-header' });
        header.createEl('h4', { text: run.workflow!.objective });
        const status = header.createDiv({ cls: 'ss-studio-workflow-status', attr: { role: 'status' } });
        const activity = card.createDiv({ cls: 'ss-studio-command-description' });
        const toolbar = card.createDiv({ cls: 'ss-studio-run-actions' });
        createStudioAction(toolbar, { label: 'Open orchestrator', testId: 'studio.workflow.open', onSelect: () => new StudioRunDetailModal(runs, run.id).open() });
        const stop = createStudioAction(toolbar, { label: 'Stop workflow', testId: 'studio.workflow.stop', onSelect: () => { runs.stop(run.id); update(); } });
        const review = createStudioAction(toolbar, { label: 'Review request', testId: 'studio.workflow.review', onSelect: () => { void runs.review(run.id).catch(report); } });
        const body = card.createDiv({ cls: 'ss-studio-workflow-plan' });
        const followup = card.createEl('textarea', { cls: 'ss-studio-workflow-followup', attr: { 'data-testid': 'studio.workflow.followup', 'aria-label': 'Steer this workflow', placeholder: 'Add context or change direction…', rows: '2', maxlength: '16000' } });
        let sending = false;
        const send = createStudioAction(card, { label: 'Send follow-up', testId: 'studio.workflow.send', onSelect: () => {
          if (sending || !followup.value.trim()) return;
          const message = followup.value; sending = true; send.disabled = true;
          void runs.send(run.id, message).then(receipt => { if (receipt.status === 'failed') throw new Error(receipt.error); if (followup.value === message) followup.value = ''; }).catch(report).finally(() => { sending = false; send.disabled = !runs.canControl(run.id); });
        } });
        let signature = '';
        cards.set(run.id, { root: card, update: () => {
          const current = runs.get(run.id); if (!current?.workflow) return;
          const workflow = current.workflow, children = runs.list(projectId).filter(child => child.workflowId === run.id);
          const label = { active: 'Working', waiting: 'Waiting for results', needs_input: 'Needs your input', completed: 'Completed', stopped: 'Stopped' }[workflow.status];
          status.setText(children.some(child => runs.hasRequest(child.id)) ? 'A child needs your input' : label); card.dataset.status = workflow.status; card.dataset.activity = activityPhaseFromWorkflowStatus(workflow.status); activity.setText(current.persistenceError || current.error || current.currentActivity);
          stop.hidden = !runs.canControl(run.id) || (!workflowOpen(workflow) && !isActiveAgentRun(current.status));
          review.hidden = !runs.hasRequest(run.id); followup.disabled = !runs.canControl(run.id); send.disabled = sending || followup.disabled;
          const next = JSON.stringify([workflow, children.map(child => [child.id, child.status, child.currentActivity])]);
          if (signature === next) return; signature = next; body.empty();
          body.createDiv({ cls: 'ss-studio-workflow-boundaries', text: workflow.boundaries });
          if (!workflow.steps.length) body.createDiv({ cls: 'ss-studio-command-description', text: 'The orchestrator is preparing a plan.' });
          const steps = body.createEl('ol', { cls: 'ss-studio-workflow-steps' });
          for (const step of workflow.steps) {
            const item = steps.createEl('li', { cls: `is-${step.status}`, attr: { 'data-activity': activityPhaseFromWorkflowStepStatus(step.status) } });
            item.createDiv({ cls: 'ss-studio-workflow-step-title', text: `${step.title} · ${step.status}` });
            if (step.dependsOn.length) item.createDiv({ cls: 'ss-studio-command-description', text: `After: ${step.dependsOn.map(id => workflow.steps.find(parent => parent.id === id)?.title || id).join(', ')}` });
            if (step.detail) item.createDiv({ cls: 'ss-studio-command-description', text: step.detail });
            for (const child of children.filter(child => child.assignmentId === step.id)) createStudioAction(item, { label: `${child.title} · ${child.status}`, title: child.currentActivity, testId: 'studio.workflow.child', onSelect: () => new StudioRunDetailModal(runs, child.id).open() });
          }
          if (workflow.outcome) body.createDiv({ cls: 'ss-studio-workflow-outcome', text: workflow.outcome });
        } });
      }
      cards.get(run.id)!.update(); const card = cards.get(run.id)!.root;
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    }
  };
  update(); const unsubscribe = runs.subscribe(id => { if (id === projectId) update(); });
  void runs.load(projectPath, projectId).then(update).catch(report);
  return () => { disposeExecution(); unsubscribe(); };
}
