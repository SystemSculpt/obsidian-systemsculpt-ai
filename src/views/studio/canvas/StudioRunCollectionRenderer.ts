import { Notice } from 'obsidian';
import { StudioRunDetailModal } from './StudioRunDetailModal';
export { StudioRunDetailModal } from './StudioRunDetailModal';
import type { StudioAgentRuns } from '../../../services/codex/StudioAgentRuns';
import { isActiveAgentRun, type StudioAgentRun } from '../../../services/codex/StudioAgentRunStore';
import { createStudioAction } from '../StudioAction';
import { markStudioNodeCardInteractive } from './StudioGraphNodeCardPointer';
import { activityPhaseFromAgentRunStatus } from '../activity/StudioActivity';

const statusLabels: Record<StudioAgentRun['status'], string> = { queued: 'Queued', running: 'Working', waiting: 'Waiting', completed: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
const shortId = (id: string): string => id.slice(-8);
const report = (error: unknown): void => { new Notice(error instanceof Error ? error.message : 'The run action failed.'); };

export function renderStudioRunCollection(root: HTMLElement, options: { runs: StudioAgentRuns; projectId: string; projectPath: string; sources?: string[]; compact?: boolean; groupBy?: string; showCompleted?: boolean }): () => void {
  const { runs } = options;
  const container = root.createDiv({ cls: `ss-studio-run-board${options.compact ? ' is-compact' : ''}`, attr: { 'data-testid': 'studio.run.board' } });
  markStudioNodeCardInteractive(container);
  const toolbar = container.createDiv({ cls: 'ss-studio-run-toolbar' });
  let query = '', groupBy = options.groupBy || 'status', showCompleted = options.showCompleted !== false, limit = 25;
  const search = toolbar.createEl('input', { type: 'search', attr: { 'data-testid': 'studio.run.search', 'aria-label': 'Search runs', placeholder: 'Search runs…' } });
  search.addEventListener('input', () => { query = search.value.toLowerCase(); render(); });
  const grouping = createStudioAction(toolbar, { label: groupBy === 'status' ? 'Group: status' : 'Group: role', testId: 'studio.run.group', onSelect: () => { groupBy = groupBy === 'status' ? 'role' : 'status'; grouping.setText(groupBy === 'status' ? 'Group: status' : 'Group: role'); render(); } });
  const completed = createStudioAction(toolbar, { label: showCompleted ? 'Hide finished' : 'Show finished', testId: 'studio.run.finished', onSelect: () => { showCompleted = !showCompleted; completed.setText(showCompleted ? 'Hide finished' : 'Show finished'); render(); } });
  createStudioAction(toolbar, { label: 'Refresh', testId: 'studio.run.refresh', onSelect: () => { void runs.refresh(options.projectPath, options.projectId).catch(report); } });
  const body = container.createDiv({ cls: 'ss-studio-run-lanes' });
  let disposed = false, layoutSignature = '';
  const liveCards = new Map<string, HTMLElement>();
  const render = (): void => {
    if (disposed) return;
    const records = runs.list(options.projectId, options.sources).filter(run => (showCompleted || isActiveAgentRun(run.status)) && `${run.title} ${run.id} ${run.currentActivity}`.toLowerCase().includes(query));
    const signature = JSON.stringify([groupBy, query, showCompleted, limit, records.map(run => [run.id, run.status])]);
    if (signature === layoutSignature) {
      for (const run of records) {
        const card = liveCards.get(run.id); if (!card) continue;
        card.querySelector('.ss-studio-run-current')?.setText(run.currentActivity);
        card.querySelector('.ss-studio-run-message-count')?.setText(run.messages.length ? `${run.messages.length} ${run.messages.length === 1 ? 'message' : 'messages'}` : '');
      }
      return;
    }
    layoutSignature = signature; body.empty(); liveCards.clear();
    if (!records.length) { body.createDiv({ cls: 'ss-studio-run-empty', text: 'No runs yet.' }); return; }
    const groups = groupBy === 'status' ? Object.keys(statusLabels) : [...new Set(records.map(run => run.nodeId))];
    for (const group of groups) {
      const members = records.filter(run => (groupBy === 'status' ? run.status : run.nodeId) === group);
      if (!members.length) continue;
      const lane = body.createDiv({ cls: 'ss-studio-run-lane' });
      lane.createEl('h3', { text: `${groupBy === 'status' ? statusLabels[group as StudioAgentRun['status']] : members[0].title} · ${members.length}` });
      for (const run of members.slice(0, limit)) {
        const card = lane.createEl('article', { cls: `ss-studio-run-card is-${run.status}`, attr: { tabindex: '0', 'aria-label': `${run.title}, ${statusLabels[run.status]}, ${shortId(run.id)}`, 'data-run-id': run.id, 'data-activity': activityPhaseFromAgentRunStatus(run.status) } });
        liveCards.set(run.id, card);
        const open = (): void => { new StudioRunDetailModal(runs, run.id).open(); };
        card.addEventListener('dblclick', event => { event.stopPropagation(); open(); });
        card.addEventListener('keydown', event => { if (event.target === card && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); open(); } });
        card.createEl('strong', { text: run.title });
        card.createDiv({ cls: 'ss-studio-run-meta', text: `${shortId(run.id)} · ${new Date(run.createdAt).toLocaleTimeString()} · ${statusLabels[run.status]}` });
        card.createDiv({ cls: 'ss-studio-run-current', text: run.currentActivity });
        card.createDiv({ cls: 'ss-studio-run-meta ss-studio-run-message-count', text: run.messages.length ? `${run.messages.length} ${run.messages.length === 1 ? 'message' : 'messages'}` : '' });
        if (run.persistenceError) card.createDiv({ cls: 'ss-studio-run-error', text: run.persistenceError });
        createStudioAction(card, { label: 'Open', testId: 'studio.run.open', size: 'small', onSelect: open });
      }
      if (members.length > limit) createStudioAction(lane, { label: 'Show more', testId: 'studio.run.more', onSelect: () => { limit += 25; render(); } });
    }
  };
  const unsubscribe = runs.subscribe(projectId => { if (projectId === options.projectId) render(); });
  void runs.load(options.projectPath, options.projectId).then(render).catch(error => { if (!disposed) body.setText(error instanceof Error ? error.message : 'Run history could not load.'); });
  render();
  return () => { disposed = true; unsubscribe(); };
}

export function renderStudioRunStatus(root: HTMLElement, runs: StudioAgentRuns, projectId: string, nodeId: string): () => void {
  const el = root.createDiv({ cls: 'ss-studio-run-inline' }); markStudioNodeCardInteractive(el);
  const render = (): void => {
    el.empty(); const records = runs.list(projectId, [nodeId]), active = records.filter(run => isActiveAgentRun(run.status));
    const latest = active[0] || records[0]; if (!latest) return;
    createStudioAction(el, { label: `${active.length ? `${active.length} active` : statusLabels[latest.status]} · ${latest.currentActivity.slice(0, 120)}`, testId: 'studio.run.latest', size: 'small', onSelect: () => new StudioRunDetailModal(runs, latest.id).open() });
  };
  const unsubscribe = runs.subscribe(id => { if (id === projectId) render(); }); render(); return unsubscribe;
}
