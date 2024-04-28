import { RecorderModule } from '../RecorderModule';
import { showCustomNotice, hideCustomNotice } from '../../../modals';
import { transcribeRecording } from './transcribeRecording';
import { AIService } from '../../../api/AIService';
import { MarkdownView, TFile, normalizePath } from 'obsidian';

export async function handleTranscription(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  recordingFile: TFile
): Promise<void> {
  // Check if OpenAI API key is valid
  const currentOpenAIApiKey = plugin.plugin.brainModule.settings.openAIApiKey;
  const isValidApiKey = await AIService.validateOpenAIApiKey(
    currentOpenAIApiKey
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

    if (plugin.settings.saveTranscriptionToFile) {
      await saveTranscriptionToFile(plugin, transcription, recordingFile);
    }
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
      const markdownView = activeLeaf.view as MarkdownView;
      const editor = markdownView.editor;
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

  async function saveTranscriptionToFile(
    plugin: RecorderModule,
    transcription: string,
    recordingFile: TFile
  ): Promise<void> {
    const { vault } = plugin.plugin.app;
    const { transcriptionsPath } = plugin.settings;

    const recordingFileName = recordingFile.basename;
    const transcriptionFileName =
      recordingFileName.replace('recording-', 'transcription-') + '.md';
    let transcriptionFilePath = normalizePath(
      `${transcriptionsPath}/${transcriptionFileName}`
    );

    const transcriptionContent = `![${recordingFileName}](${recordingFile.path})\n${transcription}`;

    // Ensure the entire directory path exists
    const directories = transcriptionsPath.split('/');
    let currentPath = '';
    for (const directory of directories) {
      currentPath += directory + '/';
      if (!(await vault.adapter.exists(currentPath))) {
        await vault.createFolder(currentPath);
      }
    }

    // Check if the transcription file already exists
    if (await vault.adapter.exists(transcriptionFilePath)) {
      const timestamp = Date.now();
      const newTranscriptionFileName = `${recordingFileName.replace(
        'recording-',
        'transcription-'
      )}-${timestamp}.md`;
      transcriptionFilePath = normalizePath(
        `${transcriptionsPath}/${newTranscriptionFileName}`
      );
    }

    // Create the transcription file
    await vault.create(transcriptionFilePath, transcriptionContent);
  }
}
