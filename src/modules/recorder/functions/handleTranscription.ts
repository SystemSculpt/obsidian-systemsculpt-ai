import { RecorderModule } from '../RecorderModule';
import { showCustomNotice, hideCustomNotice } from '../../../modals';
import { transcribeRecording } from './transcribeRecording';
import { AIService } from '../../../api/AIService';
import { MarkdownView, TFile, normalizePath } from 'obsidian';
import { ChatView } from '../../chat/ChatView';

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

  const notice = showCustomNotice('Transcribing...', 5000, true);
  try {
    const transcription = await transcribeRecording(plugin, arrayBuffer);
    hideCustomNotice();

    if (plugin.settings.saveTranscriptionToFile) {
      await saveTranscriptionToFile(plugin, transcription, recordingFile);
    }
    // Always copy to clipboard if the setting is enabled
    if (plugin.settings.copyToClipboard) {
      navigator.clipboard.writeText(transcription);
      showCustomNotice('Transcribed and copied to your clipboard!');
    } else {
      showCustomNotice('Transcription completed!');
    }

    const activeLeaf = plugin.plugin.app.workspace.activeLeaf;
    const activeView = activeLeaf?.view;

    if (activeView instanceof ChatView) {
      const chatView = activeView as ChatView;
      chatView.setChatInputValue(transcription);
      showCustomNotice('Transcribed and pasted into the chat input!');
      return; // Exit early since paste was successful
    }

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
        hideCustomNotice();
        return; // Exit early since paste was successful
      }
    }
  } catch (error) {
    hideCustomNotice();
    plugin.handleError(error, 'Error generating transcription');
  }

  async function saveTranscriptionToFile(
    plugin: RecorderModule,
    transcription: string,
    recordingFile: TFile
  ): Promise<void> {
    const { vault } = plugin.plugin.app;
    const { transcriptionsPath } = plugin.settings;

    const recordingFileName = recordingFile.basename;
    const transcriptionFileName = `Transcription ${recordingFileName
      .replace('Recording-', '')
      .replace('.mp3', '')}.md`; // Ensure .md extension
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
      const timestamp = new Date();
      const formattedTimestamp = `${timestamp.getFullYear()}-${String(
        timestamp.getMonth() + 1
      ).padStart(2, '0')}-${String(timestamp.getDate()).padStart(
        2,
        '0'
      )} ${String(timestamp.getHours()).padStart(2, '0')}-${String(
        timestamp.getMinutes()
      ).padStart(2, '0')}-${String(timestamp.getSeconds()).padStart(2, '0')}`;
      const newTranscriptionFileName = `Transcription ${formattedTimestamp}.md`;
      transcriptionFilePath = normalizePath(
        `${transcriptionsPath}/${newTranscriptionFileName}`
      );
    }

    // Create the transcription file
    await vault.create(transcriptionFilePath, transcriptionContent);
  }
}
