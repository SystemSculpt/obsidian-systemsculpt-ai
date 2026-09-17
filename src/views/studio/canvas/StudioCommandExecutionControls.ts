import type { App } from 'obsidian';
import { mountCodexModelControls } from '../../../services/codex/CodexModelControls';
import { codexVaultDirectory } from '../../../services/codex/CodexExecutionSettings';
import { readStudioCommandExecution, type StudioCommandExecution } from '../../../studio/StudioCommandExecution';
import { hasHostCapability } from '../../../platform/hostCapabilities';

export function renderStudioCommandExecution(root: HTMLElement, options: { value: unknown; app?: App; onChange?: (value: StudioCommandExecution) => void }): () => void {
  const row = root.createDiv({ cls: 'ss-studio-command-execution' });
  let selection = readStudioCommandExecution(options.value);
  const picker = mountCodexModelControls(row, { variant: 'command', value: () => ({ ...selection, serviceTier: 'default' }),
    enabled: () => !!options.app && hasHostCapability('local-cli', root), workingDirectory: () => codexVaultDirectory(options.app!),
    onChange: options.onChange && (patch => { selection = { model: patch.model ?? selection.model, effort: patch.effort ?? selection.effort }; options.onChange?.({ ...selection }); }),
  });
  return () => picker.dispose();
}
