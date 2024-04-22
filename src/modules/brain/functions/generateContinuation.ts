import { BrainModule } from '../BrainModule';
import { MarkdownView, Editor } from 'obsidian';
import { showCustomNotice } from '../../../modals';
import { handleStreamingResponse } from '../../templates/functions/handleStreamingResponse';
import { AIService } from '../../../api/AIService';

export async function generateContinuation(
  plugin: BrainModule,
  abortSignal: AbortSignal
): Promise<void> {
  const activeView =
    plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView) {
    const editor = activeView.editor;
    const cursor = editor.getCursor();
    const line = cursor.line;
    const ch = cursor.ch;

    const noteContent = editor.getRange({ line: 0, ch: 0 }, { line, ch });

    // Check if abort has been signaled before proceeding
    if (abortSignal.aborted) {
      return;
    }

    const modelId = plugin.settings.defaultOpenAIModelId;
    let model = await plugin.openAIService.getModelById(modelId);

    if (!model) {
      const localModels = await plugin.openAIService.getModels(false);
      const firstLocalModel = localModels[0];
      if (firstLocalModel) {
        plugin.settings.defaultOpenAIModelId = firstLocalModel.id;
        await plugin.saveSettings();
        updateModelStatusBar(plugin, firstLocalModel.name);
        model = firstLocalModel;
      } else {
        showCustomNotice(
          'No local models available. Please check your local endpoint settings.'
        );
        return;
      }
    }

    await plugin.openAIService.createStreamingChatCompletionWithCallback(
      plugin.settings.generalGenerationPrompt,
      noteContent,
      model.id,
      plugin.settings.maxTokens,
      (chunk: string) => {
        if (abortSignal.aborted) {
          return;
        }
        handleStreamingResponse(chunk, editor, plugin);
      },
      abortSignal
    );

    if (abortSignal.aborted) {
      return;
    }
  } else {
    showCustomNotice('No active note found to generate continuation');
  }
}

function updateModelStatusBar(plugin: BrainModule, modelName: string): void {
  if (plugin.plugin.modelToggleStatusBarItem) {
    plugin.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
  }
}
