import type { App } from 'obsidian';
import { StandardModal } from '../../core/ui/modals/standard/StandardModal';
import type { ClaudePermissionRequest } from './LocalClaudeClient';

/** Shows one Claude Code permission prompt. Resolves true only after an explicit approval click. */
export function answerClaudePermission(app: App, request: ClaudePermissionRequest, signal: AbortSignal): Promise<boolean> {
  const details = JSON.stringify(request.input, null, 2);
  if (details.length > 128_000) return Promise.resolve(false);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let answered = false;
    class PermissionModal extends StandardModal {
      private finish(allow: boolean) { if (!answered) { answered = true; resolve(allow); } this.close(); }
      onOpen() {
        super.onOpen(); this.addTitle('Claude Code requests approval');
        this.contentEl.createEl('p', { text: `${request.toolName}: ${request.description}` });
        this.contentEl.createEl('pre', { cls: 'ss-native-request-details', text: details });
        this.addActionButton('claude.permission.decline', 'Decline', () => this.finish(false));
        this.addActionButton('claude.permission.approve', 'Approve once', () => this.finish(true), true);
      }
      onClose() { signal.removeEventListener('abort', abort); if (!answered) { answered = true; resolve(false); } super.onClose(); }
    }
    const modal = new PermissionModal(app), abort = () => modal.close();
    signal.addEventListener('abort', abort, { once: true });
    modal.open();
  });
}
