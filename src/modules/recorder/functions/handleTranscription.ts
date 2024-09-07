import { RecorderModule } from '../RecorderModule';
import { showCustomNotice, hideCustomNotice } from '../../../modals';
import { transcribeRecording } from './transcribeRecording';
import { MarkdownView, TFile, normalizePath } from 'obsidian';
import { ChatView } from '../../chat/ChatView';
import { logger } from '../../../utils/logger';

export async function handleTranscription(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  recordingFile: TFile
): Promise<void> {
  const whisperProvider = plugin.settings.whisperProvider;
  const apiKey =
    whisperProvider === 'groq'
      ? plugin.plugin.brainModule.settings.groqAPIKey
      : plugin.plugin.brainModule.settings.openAIApiKey;

  if (!apiKey) {
    showCustomNotice(
      `No ${whisperProvider.toUpperCase()} API Key found. Please set your ${whisperProvider.toUpperCase()} API Key in the Brain settings.`,
      5000
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
        //@ts-ignore
    if (error.message.includes('Invalid API Key')) {
      showCustomNotice(
        `Invalid ${whisperProvider.toUpperCase()} API Key. Please check your ${whisperProvider.toUpperCase()} API Key in the Brain settings.`,
        10000
      );
    } else {
      showCustomNotice(
        //@ts-ignore
        `Error generating transcription: ${error.message}. Please check your internet connection and try again.`,
        10000
      );
    }
    logger.error('Error generating transcription', error);
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
      .replace(/\.(mp3|mp4)$/, '')}.md`; // Ensure .md extension
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