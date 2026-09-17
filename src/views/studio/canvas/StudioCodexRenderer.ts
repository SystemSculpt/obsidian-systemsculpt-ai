import { codexRunKey, getStudioCodexRun, stopStudioCodexRun } from '../../../services/codex/StudioCodexRuns';
import type { StudioJsonValue, StudioNodeInstance } from '../../../studio/types';
import { isRecord } from '../../../studio/utils';
import { createStudioAction } from '../StudioAction';

export function renderStudioCodexStop(root: HTMLElement, nodeId: string, projectId: string): void {
  const key = codexRunKey(projectId, nodeId);
  if (getStudioCodexRun(key)) createStudioAction(root, { label: 'Stop Codex', testId: `studio.codex.stop.${nodeId}`, onSelect: () => stopStudioCodexRun(key) });
}

export function renderStudioCodex(root: HTMLElement, node: StudioNodeInstance, projectId: string, outputs: Record<string, StudioJsonValue>, onChange: (key: string, value: StudioJsonValue) => void): void {
  const key = codexRunKey(projectId, node.id), active = getStudioCodexRun(key);
  root.createEl('p', { text: active ? 'Codex is running on this machine.' : 'Uses this machine’s Codex login and selected model, thinking level and speed.' });
  if (active) {

    if (active.threadId) root.createEl('p', { text: `Thread: ${active.threadId}` });
  }
  const result = isRecord(outputs.json) ? outputs.json : null;
  if (result) {
    root.createEl('pre', { text: String(result.text || '').slice(-256_000) });
    root.createEl('p', { text: `Thread: ${String(result.threadId || '')}` });
    if (typeof result.threadId === 'string') createStudioAction(root, { label: 'Use this thread for the next run', testId: `studio.codex.resume.${node.id}`, onSelect: () => onChange('threadId', result.threadId) });
  } else if (!active) root.createEl('p', { text: 'Edit the task source, then run the card. Results and the Codex thread ID appear here.' });
}
