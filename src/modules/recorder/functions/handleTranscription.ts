import { RecorderModule } from '../RecorderModule';
import { showCustomNotice, hideCustomNotice } from '../../../modals';
import { transcribeRecording } from './transcribeRecording';
import { OpenAIService } from '../../../api/OpenAIService';

export async function handleTranscription(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer
): Promise<void> {
  // Check if OpenAI API key is valid
  const isValidApiKey = await OpenAIService.validateApiKey(
    plugin.plugin.settings.openAIApiKey
  );
  if (!isValidApiKey) {
    showCustomNotice(
      'Invalid OpenAI API Key. Please check your Brain settings -> OpenAI API Key.'
    );
    return;
  }

  const notice = showCustomNotice('Transcribing...');
  try {
    const transcription = await transcribeRecording(plugin, arrayBuffer);
    hideCustomNotice(notice);
    // Always copy to clipboard if the setting is enabled
    if (plugin.settings.copyToClipboard) {
      navigator.clipboard.writeText(transcription);
    }
    // Attempt to paste into the active note if possible
    const activeLeaf = plugin.plugin.app.workspace.activeLeaf;
    if (
      activeLeaf &&
      activeLeaf.view.getViewType() === 'markdown' &&
      plugin.settings.pasteIntoActiveNote
    ) {
      const markdownView = activeLeaf.view as any; // Temporarily cast to 'any' to bypass type checking
      const editor = markdownView.editor; // Directly access the 'editor' for 'MarkdownView'
      if (editor) {
        editor.replaceSelection(transcription);
        showCustomNotice(
          'Transcribed and pasted into your note at the cursor position!'
        );
        return; // Exit early since paste was successful
      }
    }
    // Fallback notice if paste wasn't possible but transcription was copied
    if (plugin.settings.copyToClipboard) {
      showCustomNotice('Transcribed and copied to your clipboard!');
    } else {
      showCustomNotice('Transcription completed!');
    }
  } catch (error) {
    plugin.handleError(error, 'Error generating transcription');
    hideCustomNotice(notice);
  }
}
