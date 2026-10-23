/** @jest-environment jsdom */
import { App } from 'obsidian';
import { answerClaudePermission } from '../ClaudeRequestModal';
afterEach(() => document.body.empty());
const request = { toolName: 'Edit', description: 'note.md', input: { file_path: '/vault/note.md', old_string: 'teh', new_string: 'the' } };
it('shows the proposed edit and allows it only after a click', async () => {
  const result = answerClaudePermission(new App(), request, new AbortController().signal);
  expect(document.body.textContent).toContain('Claude Code requests approval');
  expect(document.body.textContent).toContain('"new_string": "the"');
  (document.querySelector('[data-testid="claude.permission.approve"]') as HTMLButtonElement).click();
  await expect(result).resolves.toBe(true);
});
it('declines on Decline, on withdrawal and for an already withdrawn request', async () => {
  const declined = answerClaudePermission(new App(), request, new AbortController().signal);
  (document.querySelector('[data-testid="claude.permission.decline"]') as HTMLButtonElement).click();
  await expect(declined).resolves.toBe(false);
  const controller = new AbortController();
  const withdrawn = answerClaudePermission(new App(), request, controller.signal);
  controller.abort(); await expect(withdrawn).resolves.toBe(false);
  await expect(answerClaudePermission(new App(), request, controller.signal)).resolves.toBe(false);
});
