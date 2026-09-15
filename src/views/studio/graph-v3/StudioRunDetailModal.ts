import { Component, MarkdownRenderer, Notice } from 'obsidian';
import { StandardModal } from '../../../core/ui/modals/standard/StandardModal';
import type { StudioAgentRuns } from '../../../services/codex/StudioAgentRuns';
import { isActiveAgentRun, type StudioAgentRun } from '../../../services/codex/StudioAgentRunStore';
import { createStudioAction } from '../StudioAction';
const statusLabels: Record<StudioAgentRun['status'], string> = { queued: 'Queued', running: 'Working', waiting: 'Needs input', completed: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
const shortId = (id: string): string => id.slice(-8);
const report = (error: unknown): void => { new Notice(error instanceof Error ? error.message : 'The run action failed.'); };

export class StudioRunDetailModal extends StandardModal {
  private unsubscribe?: () => void;
  private markdown?: Component;
  private renderEpoch = 0;
  constructor(private readonly runs: StudioAgentRuns, private readonly runId: string) { super(runs.app); }
  onOpen(): void {
    super.onOpen(); this.setSize('fullwidth'); this.modalEl.addClass('ss-studio-run-detail');
    const initial = this.runs.get(this.runId); if (!initial) { this.addTitle('Run unavailable'); return; }
    this.addTitle(initial.title, `Run ${shortId(initial.id)}`);
    const summary = this.contentEl.createDiv({ cls: 'ss-studio-run-summary' });
    const actions = this.contentEl.createDiv({ cls: 'ss-studio-run-actions' });
    const tabs = this.contentEl.createDiv({ cls: 'ss-studio-run-tabs' });
    const stream = this.contentEl.createDiv({ cls: 'ss-studio-run-stream' });
    let selected: 'Response' | 'Activity' | 'Conversation' | 'Messages' = initial.result && !isActiveAgentRun(initial.status) ? 'Response' : 'Activity';
    let source = false, contentSignature = '', viewKey = '';
    const format = createStudioAction(tabs, { label: 'Show source', testId: 'studio.run.source', className: 'ss-studio-run-source-toggle', onSelect: () => { source = !source; render(); } });
    for (const label of ['Response', 'Activity', 'Conversation', 'Messages'] as const) {
      const button = createStudioAction(tabs, { label, testId: `studio.run.tab.${label.toLowerCase()}`, onSelect: () => { selected = label; render(); } });
      button.dataset.runTab = label;
    }
    tabs.appendChild(format);
    const composer = this.footerEl.createEl('textarea', { cls: 'ss-studio-run-composer', attr: { 'data-testid': 'studio.run.composer', 'aria-label': 'Message this run', placeholder: 'Message this run…', maxlength: '16000', rows: '3' } });
    let sending = false;
    const send = this.addActionButton('studio.run.send', 'Send', () => {
      if (sending || !composer.value.trim()) return;
      sending = true; send.disabled = true; const text = composer.value;
      void this.runs.send(this.runId, text).then(receipt => { if (receipt.status === 'failed') throw new Error(receipt.error); if (composer.value === text) composer.value = ''; }).catch(report).finally(() => { sending = false; send.disabled = !this.runs.canControl(this.runId); });
    }, true);
    const render = (): void => {
      const run = this.runs.get(this.runId); if (!run) return;
      for (const button of tabs.querySelectorAll<HTMLElement>('[data-run-tab]')) button.setAttribute('aria-pressed', String(button.dataset.runTab === selected));
      format.setText(source ? 'Show Markdown' : 'Show source'); format.setAttribute('aria-pressed', String(source));
      summary.empty();
      summary.createDiv({ cls: `ss-studio-run-status is-${run.status}`, text: `${run.workflow?.status === 'waiting' ? 'Waiting for results' : statusLabels[run.status]} · ${run.currentActivity}` });
      summary.createDiv({ cls: 'ss-studio-run-meta', text: `${run.request.model || 'Native model'} · ${run.request.effort || 'Native thinking'} · ${['priority', 'fast'].includes(run.request.serviceTier || '') ? 'Fast' : 'Standard'} · ${run.machine}` });
      if (run.threadId) summary.createEl('code', { text: run.threadId });
      if (run.error || run.persistenceError) summary.createDiv({ cls: 'ss-studio-run-error', text: run.error || run.persistenceError });
      actions.empty();
      if (run.parentRunId && this.runs.get(run.parentRunId)) createStudioAction(actions, { label: 'Parent run', testId: 'studio.run.parent', onSelect: () => new StudioRunDetailModal(this.runs, run.parentRunId!).open() });
      if (this.runs.canControl(run.id) && isActiveAgentRun(run.status)) createStudioAction(actions, { label: 'Stop', testId: 'studio.run.stop', onSelect: () => this.runs.stop(run.id) });
      if (this.runs.hasRequest(run.id)) createStudioAction(actions, { label: 'Review request', testId: 'studio.run.review', onSelect: () => { void this.runs.review(run.id).catch(report); } });
      composer.disabled = !this.runs.canControl(run.id); send.disabled = sending || composer.disabled;
      const nextViewKey = `${selected}:${source}`;
      const signature = JSON.stringify([nextViewKey, selected === 'Response' ? run.result : selected === 'Conversation' ? [run.request.prompt, run.result] : selected === 'Messages' ? run.messages : [run.activity, run.currentActivity]]);
      if (signature === contentSignature) return;
      contentSignature = signature;
      const atBottom = viewKey === nextViewKey && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
      const previousScroll = viewKey === nextViewKey ? stream.scrollTop : 0; viewKey = nextViewKey;
      this.markdown?.unload(); const component = new Component(); component.load(); this.markdown = component;
      const epoch = ++this.renderEpoch, pending: Promise<void>[] = [];
      const prose = (parent: HTMLElement, text: string): void => {
        if (source) { parent.createEl('pre', { text }); return; }
        const element = parent.createDiv({ cls: 'ss-studio-run-markdown markdown-rendered' });
        pending.push(MarkdownRenderer.render(this.app, text, element, run.projectPath, component).then(() => {
          if (epoch !== this.renderEpoch) return;
          for (const table of element.querySelectorAll('table')) { const wrapper = element.createDiv({ cls: 'ss-studio-run-table', attr: { tabindex: '0', role: 'region', 'aria-label': 'Scrollable table' } }); table.before(wrapper); wrapper.appendChild(table); }
        }).catch(() => { element.empty(); element.createEl('pre', { text }); }));
      };
      stream.empty();
      if (selected === 'Response') {
        prose(stream, run.result || 'Waiting for a public response…');
      } else if (selected === 'Conversation') {
        stream.createEl('h3', { text: 'Task' }); prose(stream, run.request.prompt);
        stream.createEl('h3', { text: 'Latest response' }); prose(stream, run.result || 'Waiting for a public response…');
      } else if (selected === 'Messages') {
        if (!run.messages.length) stream.createDiv({ cls: 'ss-studio-run-empty', text: 'No messages yet.' });
        for (const message of run.messages) {
          const item = stream.createDiv({ cls: 'ss-studio-run-event' });
          item.createDiv({ cls: 'ss-studio-run-meta', text: `${message.from === 'you' ? 'You' : shortId(message.from)} → ${shortId(message.to)} · ${message.status} · ${new Date(message.at).toLocaleTimeString()}` });
          prose(item, message.text);
          if (message.error) item.createDiv({ cls: 'ss-studio-run-error', text: message.error });
          const peer = message.from === run.id ? message.to : message.from;
          if (this.runs.get(peer)) createStudioAction(item, { label: 'Open peer', testId: 'studio.run.peer', onSelect: () => new StudioRunDetailModal(this.runs, peer).open() });
        }
      } else {
        if (!run.activity.length) stream.createDiv({ cls: 'ss-studio-run-empty', text: run.currentActivity });
        for (const activity of run.activity) {
          const item = stream.createDiv({ cls: 'ss-studio-run-event' });
          item.createDiv({ cls: 'ss-studio-run-meta', text: `${activity.kind} · ${activity.status} · ${new Date(activity.at).toLocaleTimeString()}` });
          item.createEl('strong', { text: activity.title });
          if (activity.detail) { if (activity.kind === 'message') prose(item, activity.detail); else item.createEl('pre', { text: activity.detail }); }
        }
      }
      stream.scrollTop = atBottom ? stream.scrollHeight : previousScroll;
      const initialScroll = stream.scrollTop;
      void Promise.all(pending).then(() => { if (epoch !== this.renderEpoch) { component.unload(); return; } if (stream.scrollTop === initialScroll) stream.scrollTop = atBottom ? stream.scrollHeight : previousScroll; });
    };
    this.unsubscribe = this.runs.subscribe(projectId => { if (projectId === initial.projectId) render(); }); render();
  }
  onClose(): void { this.renderEpoch++; this.markdown?.unload(); this.markdown = undefined; this.unsubscribe?.(); this.unsubscribe = undefined; super.onClose(); }
}

