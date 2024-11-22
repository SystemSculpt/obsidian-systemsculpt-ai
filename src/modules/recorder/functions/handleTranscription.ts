import { RecorderModule } from "../RecorderModule";
import { showCustomNotice } from "../../../modals";
import { transcribeRecording } from "./transcribeRecording";
import { MarkdownView, TFile, normalizePath } from "obsidian";
import { ChatView } from "../../chat/ChatView";

export async function handleTranscription(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  recordingFile: TFile,
  skipPaste: boolean = false
): Promise<string> {
  const whisperProvider = plugin.settings.whisperProvider;

  if (whisperProvider !== "local") {
    let apiKey = "";

    if (whisperProvider === "groq") {
      apiKey = plugin.plugin.brainModule.settings.groqAPIKey;
    } else if (whisperProvider === "openai") {
      apiKey = plugin.plugin.brainModule.settings.openAIApiKey;
    }

    if (!apiKey) {
      showCustomNotice(
        `No ${whisperProvider.toUpperCase()} API Key found. Please set your ${whisperProvider.toUpperCase()} API Key in the Brain settings.`
      );
      throw new Error("No API Key found");
    }
  }

  try {
    showCustomNotice("Transcribing audio...");
    let transcription = await transcribeRecording(
      plugin,
      arrayBuffer,
      (current, total) => {
        console.log(`Transcription progress: ${current}/${total}`);
      }
    );

    console.log("Received transcription:", transcription);

    if (!transcription || typeof transcription !== "string") {
      console.error("Invalid transcription response:", transcription);
      throw new Error("Invalid transcription response from server");
    }

    // Check if we're in a ChatView
    const activeLeaf = plugin.plugin.app.workspace.activeLeaf;
    const activeView = activeLeaf?.view;
    const isInChatView = activeView instanceof ChatView;

    // If in ChatView, return just the transcription text
    if (isInChatView) {
      if (plugin.settings.copyToClipboard) {
        navigator.clipboard.writeText(transcription);
      }

      // Get the chat input element
      const chatView = activeView as ChatView;
      const inputEl = chatView.containerEl.querySelector(
        ".systemsculpt-chat-input"
      ) as HTMLTextAreaElement;

      if (inputEl) {
        const start = inputEl.selectionStart;
        const end = inputEl.selectionEnd;
        const currentValue = inputEl.value;

        // If cursor position is detected, insert at cursor
        if (typeof start === "number" && typeof end === "number") {
          const newValue =
            currentValue.substring(0, start) +
            transcription +
            currentValue.substring(end);
          inputEl.value = newValue;
          // Move cursor to end of inserted text
          inputEl.selectionStart = start + transcription.length;
          inputEl.selectionEnd = start + transcription.length;
        } else {
          // If no cursor position, append to end
          inputEl.value =
            currentValue + (currentValue.length > 0 ? " " : "") + transcription;
        }

        // Focus the input
        inputEl.focus();
      }

      showCustomNotice("Transcription completed!");
      return transcription;
    }

    // Otherwise, proceed with normal formatting
    let finalTranscription = transcription;

    if (plugin.settings.enablePostProcessingPrompt) {
      showCustomNotice("Processing transcription...");
      const processedTranscription = await postProcessTranscription(
        plugin,
        transcription
      );

      if (plugin.settings.includeLinkToRecording) {
        const recordingLink = `![[${recordingFile.path}]]`;
        finalTranscription = `## Raw Transcription\n${recordingLink}\n${transcription}\n\n## Processed Transcription\n${processedTranscription}`;
      } else {
        finalTranscription = `## Raw Transcription\n${transcription}\n\n## Processed Transcription\n${processedTranscription}`;
      }
    } else if (plugin.settings.includeLinkToRecording) {
      const recordingLink = `![[${recordingFile.path}]]`;
      finalTranscription = `## Raw Transcription\n${recordingLink}\n${transcription}`;
    }

    if (plugin.settings.saveTranscriptionToFile) {
      await saveTranscriptionToFile(plugin, finalTranscription, recordingFile);
    }

    if (plugin.settings.copyToClipboard) {
      navigator.clipboard.writeText(finalTranscription);
    }

    showCustomNotice("Transcription completed!");

    if (!skipPaste) {
      const activeLeaf = plugin.plugin.app.workspace.activeLeaf;
      const activeView = activeLeaf?.view;

      if (activeView instanceof ChatView) {
        const chatView = activeView as ChatView;
        chatView.setChatInputValue(finalTranscription);
      } else if (
        activeLeaf &&
        activeLeaf.view.getViewType() === "markdown" &&
        plugin.settings.pasteIntoActiveNote
      ) {
        const markdownView = activeLeaf.view as MarkdownView;
        const editor = markdownView.editor;
        if (editor) {
          editor.replaceSelection(finalTranscription);
        }
      }
    }

    return finalTranscription;
  } catch (error) {
    console.error("Transcription error:", error);

    if (error instanceof Error) {
      if (error.message.includes("Invalid API Key")) {
        showCustomNotice(
          `Invalid ${whisperProvider.toUpperCase()} API Key. Please check your ${whisperProvider.toUpperCase()} API Key in the Brain settings.`
        );
      } else if (error.message.includes("Failed to fetch")) {
        showCustomNotice(
          `Connection error: Could not reach ${whisperProvider} server. Please check your connection and server status.`
        );
      } else {
        showCustomNotice(
          `Error generating transcription: ${error.message}. Please check the console for more details.`
        );
      }
    } else {
      showCustomNotice(
        "An unexpected error occurred during transcription. Please check the console for more details."
      );
    }
    throw error;
  }
}

async function postProcessTranscription(
  plugin: RecorderModule,
  transcription: string
): Promise<string> {
  const systemPrompt = plugin.settings.postProcessingPrompt;
  const userMessage = transcription;

  const modelId = plugin.plugin.brainModule.settings.defaultModelId;
  let model = await plugin.plugin.brainModule.getModelById(modelId);

  if (!model) {
    const models = await plugin.plugin.brainModule.getEnabledModels();
    if (models.length > 0) {
      model = models[0];
      plugin.plugin.brainModule.settings.defaultModelId = model.id;
      await plugin.plugin.brainModule.saveSettings();
    } else {
      showCustomNotice(
        "No models available for post-processing. Please check your model settings and ensure at least one provider is enabled."
      );
      return transcription;
    }
  }

  try {
    const processedTranscription =
      await plugin.plugin.brainModule.AIService.createChatCompletion(
        systemPrompt,
        userMessage,
        model.id
      );

    return processedTranscription.trim();
  } catch (error) {
    console.error("Failed to post-process transcription:", error);
    showCustomNotice(
      "Failed to post-process transcription. Using original transcription."
    );
    return transcription;
  }
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
    .replace("Recording-", "")
    .replace(/\.(mp3|mp4)$/, "")}.md`;
  let transcriptionFilePath = normalizePath(
    `${transcriptionsPath}/${transcriptionFileName}`
  );

  const transcriptionContent = `![${recordingFileName}](${recordingFile.path})\n${transcription}`;

  const directories = transcriptionsPath.split("/");
  let currentPath = "";
  for (const directory of directories) {
    currentPath += directory + "/";
    if (!(await vault.adapter.exists(currentPath))) {
      await vault.createFolder(currentPath);
    }
  }

  if (await vault.adapter.exists(transcriptionFilePath)) {
    const timestamp = new Date();
    const formattedTimestamp = `${timestamp.getFullYear()}-${String(
      timestamp.getMonth() + 1
    ).padStart(2, "0")}-${String(timestamp.getDate()).padStart(
      2,
      "0"
    )} ${String(timestamp.getHours()).padStart(2, "0")}-${String(
      timestamp.getMinutes()
    ).padStart(2, "0")}-${String(timestamp.getSeconds()).padStart(2, "0")}`;
    const newTranscriptionFileName = `Transcription ${formattedTimestamp}.md`;
    transcriptionFilePath = normalizePath(
      `${transcriptionsPath}/${newTranscriptionFileName}`
    );
  }

  await vault.create(transcriptionFilePath, transcriptionContent);
}
