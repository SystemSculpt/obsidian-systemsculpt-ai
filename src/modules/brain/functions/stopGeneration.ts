import { BrainModule } from '../BrainModule';
import { showCustomNotice } from '../../../modals';
import { TemplatesModule } from '../../templates/TemplatesModule';

export async function stopGeneration(plugin: BrainModule): Promise<void> {
  console.log('Checking brain abort controller: ', plugin.abortController);
  if (plugin.abortController) {
    plugin.abortController.abort();
    plugin.abortController = null;
    plugin.isGenerating = false;
    showCustomNotice('Generation stopped by user', 5000);
  } else {
    showCustomNotice('No generation in progress', 5000);
  }

  console.log(
    'Checking templates abort controller: ',
    plugin.plugin.templatesModule.abortController
  );
}
