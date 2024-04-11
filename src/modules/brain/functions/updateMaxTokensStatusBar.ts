import { BrainModule } from '../BrainModule';

export function updateMaxTokensStatusBar(plugin: BrainModule): void {
  if (plugin.plugin.maxTokensToggleStatusBarItem) {
    plugin.plugin.maxTokensToggleStatusBarItem.setText(
      `Max Tokens: ${plugin.settings.maxTokens}`
    );
  }
}
