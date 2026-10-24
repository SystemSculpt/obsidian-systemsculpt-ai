import type { App } from 'obsidian';
import type { StudioPresentation } from '../StudioPresentation';
import { mountCodexModelControls } from '../../../services/codex/CodexModelControls';
import { codexVaultDirectory } from '../../../services/codex/CodexExecutionSettings';
import { readStudioCommandExecution, type StudioCommandExecution } from '../../../studio/StudioCommandExecution';
import { hasHostCapability } from '../../../platform/hostCapabilities';

export function renderStudioCommandExecution(root: HTMLElement, options: { value: unknown; app?: App; onChange?: (value: StudioCommandExecution) => void; presentation?: StudioPresentation }): () => void {
  const row = root.createDiv({ cls: 'ss-studio-command-execution' });
  let selection = readStudioCommandExecution(options.value);
  const picker = mountCodexModelControls(row, { variant: 'command', value: () => ({ ...selection, serviceTier: 'default' }),
    enabled: () => !!options.app && hasHostCapability('local-cli', root), workingDirectory: () => codexVaultDirectory(options.app!),
    isVisible: () => options.presentation?.isVisible() !== false,
    onChange: options.onChange && (patch => { selection = { model: patch.model ?? selection.model, effort: patch.effort ?? selection.effort }; options.onChange?.({ ...selection }); }),
  });
  const observation = options.presentation?.watch(picker.refresh, () => () => {});
  return () => { observation?.dispose(); picker.dispose(); };
}
