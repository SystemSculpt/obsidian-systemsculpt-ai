/** @jest-environment jsdom */
import { App } from 'obsidian';
import { answerCodexRequest } from '../CodexRequestModal';
afterEach(() => document.body.empty());
it('shows the concrete native command and forwards approval only after a click', async () => {
  const result = answerCodexRequest(new App(), 'item/commandExecution/requestApproval', { command: 'touch /workspace/report.md', cwd: '/workspace' }, new AbortController().signal);
  expect(document.body.textContent).toContain('touch /workspace/report.md');
  (document.querySelector('[data-testid="studio.codex.approve"]') as HTMLButtonElement).click();
  await expect(result).resolves.toEqual({ decision: 'accept' });
});
it('returns cancellation when an open native request is aborted', async () => {
  const controller = new AbortController();
  const result = answerCodexRequest(new App(), 'item/fileChange/requestApproval', { reason: 'Write a report' }, controller.signal);
  controller.abort(); await expect(result).resolves.toEqual({ decision: 'cancel' });
});
it('does not open a modal for an already canceled request', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(answerCodexRequest(new App(), 'item/commandExecution/requestApproval', {}, controller.signal)).resolves.toEqual({ decision: 'cancel' });
  expect(document.querySelector('.ss-modal')).toBeNull();
});
it('grants only the requested permissions for this turn', async () => {
  const result = answerCodexRequest(new App(), 'item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: null } }, new AbortController().signal);
  (document.querySelector('[data-testid="studio.codex.approve"]') as HTMLButtonElement).click();
  await expect(result).resolves.toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
});
it('submits a native question answer and rejects unsupported or oversized requests', async () => {
  const signal = new AbortController().signal;
  const result = answerCodexRequest(new App(), 'item/tool/requestUserInput', { questions: [{ id: 'q1', question: 'Which directory?', options: [{ label: 'Docs' }] }] }, signal);
  (document.querySelector('[data-testid="studio.codex.option.q1.Docs"]') as HTMLButtonElement).click();
  (document.querySelector('[data-testid="studio.codex.answer"]') as HTMLButtonElement).click();
  await expect(result).resolves.toEqual({ answers: { q1: { answers: ['Docs'] } } });
  await expect(answerCodexRequest(new App(), 'unknown', {}, signal)).rejects.toThrow('does not support');
  await expect(answerCodexRequest(new App(), 'item/fileChange/requestApproval', { text: 'x'.repeat(130_000) }, signal)).rejects.toThrow('not approved');
});
