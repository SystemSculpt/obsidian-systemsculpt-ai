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

    const modelId = plugin.settings.defaultModelId;
    let model = await plugin.getModelById(modelId);

    if (!model) {
      console.log('model not found, trying to find a local/ online model...');
      const localModels = await plugin.openAIService.getModels(false);
      const onlineModels = await plugin.openAIService.getModels(true);
      const firstLocalModel = localModels[0];
      if (firstLocalModel) {
        plugin.settings.defaultModelId = firstLocalModel.id;
        await plugin.saveSettings();
        updateModelStatusBar(plugin, firstLocalModel.name);
        model = firstLocalModel;
        // if there's no local model, use the first online model
      } else if (onlineModels.length > 0) {
        model = onlineModels[0];
        plugin.settings.defaultModelId = model.id;
        await plugin.saveSettings();
        updateModelStatusBar(plugin, model.name);
      } else {
        showCustomNotice(
          'No local or online models available. Please check your model settings.'
        );
        return;
      }
    }

    console.log('model found: ', model);

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
