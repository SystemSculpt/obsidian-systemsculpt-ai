import { RecorderModule } from "../RecorderModule";
import { showCustomNotice } from "../../../modals";
import { transcribeRecording } from "./transcribeRecording";
import { MarkdownView, TFile, normalizePath } from "obsidian";
import { ChatView } from "../../chat/ChatView";
import { BrainModule } from "../../brain/BrainModule";

export async function handleTranscription(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  recordingFile: TFile,
  skipPaste: boolean = false
): Promise<string> {
  const whisperProvider = plugin.settings.whisperProvider;
  const apiKey =
    whisperProvider === "groq"
      ? plugin.plugin.brainModule.settings.groqAPIKey
      : plugin.plugin.brainModule.settings.openAIApiKey;

  if (!apiKey) {
    showCustomNotice(
      `No ${whisperProvider.toUpperCase()} API Key found. Please set your ${whisperProvider.toUpperCase()} API Key in the Brain settings.`
    );
    throw new Error("No API Key found");
  }

  const updateProgress = (current: number, total: number) => {
    let message: string;
    if (total > 1) {
      message = `Large audio file detected. Transcribing chunk ${current} of ${total}...`;
    } else {
      message = "Transcribing...";
    }

    const noticeEl = document.querySelector(
      ".systemsculpt-custom-notice .systemsculpt-custom-notice-message"
    );
    if (noticeEl) {
      noticeEl.innerHTML = "";

      if (message.includes("...")) {
        const parts = message.split("...");
        const textPart = document.createElement("span");
        textPart.textContent = parts[0];
        noticeEl.appendChild(textPart);

        const dotsSpan = document.createElement("span");
        dotsSpan.classList.add("revolving-dots");
        dotsSpan.textContent = "...";
        noticeEl.appendChild(dotsSpan);

        if (parts.length > 1 && parts[1].trim() !== "") {
          const extraSpan = document.createElement("span");
          extraSpan.textContent = parts[1];
          noticeEl.appendChild(extraSpan);
        }
      } else {
        noticeEl.textContent = message;
      }
    }
  };

  try {
    let transcription = await transcribeRecording(
      plugin,
      arrayBuffer,
      updateProgress
    );

    let finalTranscription = transcription;

    if (plugin.settings.enablePostProcessingPrompt) {
      const processedTranscription = await postProcessTranscription(
        plugin,
        transcription
      );
      finalTranscription = `## Raw Transcription\n\n${transcription}\n\n## Processed Transcription\n\n${processedTranscription}`;
    }

    if (plugin.settings.includeLinkToRecording) {
      const recordingLink = `![[${recordingFile.path}]]`;
      finalTranscription = `${recordingLink}\n\n${finalTranscription}`;
    }

    if (plugin.settings.saveTranscriptionToFile) {
      await saveTranscriptionToFile(plugin, finalTranscription, recordingFile);
    }
    if (plugin.settings.copyToClipboard) {
      navigator.clipboard.writeText(finalTranscription);
      showCustomNotice(
        "Transcribed, post-processed, and copied to your clipboard!"
      );
    } else {
      showCustomNotice("Transcription and post-processing completed!");
    }

    if (!skipPaste) {
      const activeLeaf = plugin.plugin.app.workspace.activeLeaf;
      const activeView = activeLeaf?.view;

      if (activeView instanceof ChatView) {
        const chatView = activeView as ChatView;
        chatView.setChatInputValue(finalTranscription);
        showCustomNotice(
          "Successfully pasted post-processed transcription into the chat input!"
        );
      } else if (
        activeLeaf &&
        activeLeaf.view.getViewType() === "markdown" &&
        plugin.settings.pasteIntoActiveNote
      ) {
        const markdownView = activeLeaf.view as MarkdownView;
        const editor = markdownView.editor;
        if (editor) {
          editor.replaceSelection(finalTranscription);
          showCustomNotice(
            "Successfully pasted post-processed transcription into your note at the cursor position!"
          );
        }
      }
    }

    return finalTranscription;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Invalid API Key")) {
      showCustomNotice(
        `Invalid ${whisperProvider.toUpperCase()} API Key. Please check your ${whisperProvider.toUpperCase()} API Key in the Brain settings.`
      );
    } else {
      showCustomNotice(
        `Error generating transcription: ${error instanceof Error ? error.message : "Unknown error"}. Please check your internet connection and try again.`
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
        model.id,
        model.maxOutputTokens || 4096
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
