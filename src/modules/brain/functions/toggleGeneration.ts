import { BrainModule } from '../BrainModule';
import { showCustomNotice, hideCustomNotice } from '../../../modals';
import { generateContinuation } from './generateContinuation';
import { stopGeneration } from './stopGeneration';

export async function toggleGeneration(plugin: BrainModule): Promise<void> {
  if (plugin.isGenerating) {
    await stopGeneration(plugin);
  } else {
    plugin.isGenerating = true;
    plugin.abortController = new AbortController();
    showCustomNotice('Generating...', 5000, true);
    try {
      await generateContinuation(plugin, plugin.abortController.signal);
    } catch (error) {
      if (error.name === 'AbortError') {
        // Request was aborted, no need to show an error message
      } else {
        showCustomNotice(
          "Generation stopped early upon user's request.",
          5000,
          true
        );
      }
    } finally {
      plugin.isGenerating = false;
      hideCustomNotice();
    }
  }
}
