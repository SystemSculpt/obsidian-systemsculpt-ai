import { BrainModule } from '../BrainModule';
import { showCustomNotice } from '../../../modals';
import { TemplatesModule } from '../../templates/TemplatesModule';

export async function stopGeneration(plugin: BrainModule): Promise<void> {
  if (plugin.abortController) {
    plugin.abortController.abort();
    plugin.abortController = null;
    plugin.isGenerating = false;
    showCustomNotice('Generation stopped by user', 5000);
  } else {
    showCustomNotice('No generation in progress', 5000);
  }
  plugin.openAIService.setRequestInProgress(false);

  // Stop template generation if it's running
  const templatesModule = plugin.plugin.templatesModule as TemplatesModule;
  if (templatesModule.abortController) {
    templatesModule.stopGeneration();
  }
}
