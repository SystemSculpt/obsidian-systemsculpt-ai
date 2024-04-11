import { BrainModule } from '../BrainModule';
import { showCustomNotice } from '../../../modals';

export async function stopGeneration(plugin: BrainModule): Promise<void> {
  if (plugin.abortController) {
    plugin.abortController.abort();
    plugin.abortController = null;
    plugin.isGenerating = false; // Add this line to ensure the flag is reset
    showCustomNotice('Generation stopped by user', 5000);
  } else {
    showCustomNotice('No generation in progress', 5000);
  }
}
