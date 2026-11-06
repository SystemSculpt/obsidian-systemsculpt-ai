import type { App } from 'obsidian';
import { StandardModal } from '../../core/ui/modals/standard/StandardModal';
import { codexClientRequestKind, codexClientResponse } from './CodexClientRequests';
import { isRecord } from '../../utils/jsonRecord';

export function answerCodexRequest(app: App, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const kind = codexClientRequestKind(method);
  if (!kind) return Promise.reject(new Error(`Studio does not support the Codex client request ${method}.`));
  const approval = kind !== 'question';
  const details = JSON.stringify(params, null, 2);
  if (details.length > 128_000) return Promise.reject(new Error('This native request exceeds the review display limit; it was not approved.'));
  const decision = (approve: boolean, cancel = false): unknown => codexClientResponse(kind, params, {
    action: approve ? 'accept' : cancel ? 'cancel' : 'decline', omitNullPermissions: true,
  });
  if (signal.aborted) return Promise.resolve(approval ? decision(false, true) : { answers: {} });
  return new Promise(resolve => {
    let answered = false;
    class RequestModal extends StandardModal {
      private finish(value: unknown) { if (!answered) { answered = true; resolve(value); } this.close(); }
      onOpen() {
        super.onOpen(); this.addTitle(approval ? 'Codex requests approval' : 'Codex needs your input');
        if (approval) {
          this.contentEl.createEl('pre', { cls: 'ss-native-request-details', text: details });
          this.addActionButton('studio.codex.decline', 'Decline', () => this.finish(decision(false)));
          this.addActionButton('studio.codex.approve', 'Approve once', () => this.finish(decision(true)), true);
        } else {
          const answers: Record<string, HTMLInputElement> = {};
          for (const q of (Array.isArray(params.questions) ? params.questions : []).filter(isRecord).slice(0, 10)) {
            const label = this.contentEl.createEl('label', { text: String(q.question || q.header) });
            const input = label.createEl('input', { type: q.isSecret ? 'password' : 'text', attr: { 'data-testid': `studio.codex.question.${String(q.id)}` } }); answers[String(q.id)] = input;
            for (const option of (Array.isArray(q.options) ? q.options : []).filter(isRecord)) {
              const button = this.contentEl.createEl('button', { text: String(option.label), attr: { type: 'button', 'data-testid': `studio.codex.option.${String(q.id)}.${String(option.label)}` } });
              button.addEventListener('click', () => { input.value = String(option.label); });
            }
          }
          this.addActionButton('studio.codex.answer', 'Send answer', () => this.finish(codexClientResponse(kind, params, { action: 'accept', answers: Object.fromEntries(Object.entries(answers).map(([id, input]) => [id, [input.value]])) })), true);
        }
      }
      onClose() { signal.removeEventListener('abort', abort); if (!answered) { answered = true; resolve(approval ? decision(false, true) : { answers: {} }); } super.onClose(); }
    }
    const modal = new RequestModal(app), abort = () => modal.close();
    signal.addEventListener('abort', abort, { once: true });
    modal.open();
  });
}
