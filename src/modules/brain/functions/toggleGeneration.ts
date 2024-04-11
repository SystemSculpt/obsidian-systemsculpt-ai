import { BrainModule } from '../BrainModule';
import { MarkdownView, Editor } from 'obsidian';
import { showCustomNotice } from '../../../modals';
import { generateContinuation } from './generateContinuation';
import { stopGeneration } from './stopGeneration';
import { TemplatesModule } from '../../templates/TemplatesModule';

export async function toggleGeneration(plugin: BrainModule): Promise<void> {
  let proceedWithGeneralGeneration = true;

  // Stop template generation if it's running and not already completed
  if (
    plugin.plugin.templatesModule.abortController &&
    !plugin.plugin.templatesModule.isGenerationCompleted
  ) {
    plugin.plugin.templatesModule.stopGeneration();
    proceedWithGeneralGeneration = false; // Set flag to false to prevent starting general generation
  }

  // Only proceed with toggling general generation if appropriate
  if (proceedWithGeneralGeneration) {
    if (plugin.isGenerating) {
      await stopGeneration(plugin);
    } else {
      plugin.isGenerating = true;
      plugin.abortController = new AbortController();
      showCustomNotice('Generating...', 5000);
      await generateContinuation(plugin, plugin.abortController.signal);
      plugin.isGenerating = false;
    }
  }
}
