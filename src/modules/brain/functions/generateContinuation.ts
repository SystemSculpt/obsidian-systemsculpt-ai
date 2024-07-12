import { BrainModule } from '../BrainModule';
import { MarkdownView, Editor } from 'obsidian';
import { showCustomNotice } from '../../../modals';
import { handleStreamingResponse } from '../../templates/functions/handleStreamingResponse';
import { logger } from '../../../utils/logger';

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
      logger.log('Model not found, trying to find an available model...');
      const models = await plugin.openAIService.getModels(
        plugin.settings.showopenAISetting,
        plugin.settings.showgroqSetting,
        plugin.settings.showlocalEndpointSetting,
        plugin.settings.showopenRouterSetting
      );

      if (models.length > 0) {
        model = models[0];
        plugin.settings.defaultModelId = model.id;
        await plugin.saveSettings();
        updateModelStatusBar(plugin, model.name);
      } else {
        showCustomNotice(
          'No models available. Please check your model settings and ensure at least one provider is enabled.'
        );
        return;
      }
    }

    logger.log('Model found: ', model);

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
