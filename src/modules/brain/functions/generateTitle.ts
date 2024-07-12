import { BrainModule } from '../BrainModule';
import { showCustomNotice } from '../../../modals';
import { logger } from '../../../utils/logger';

export async function generateTitle(
  plugin: BrainModule,
  noteContent: string
): Promise<string> {
  const systemPrompt = plugin.settings.generateTitlePrompt;
  const userMessage = noteContent;

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
      return '';
    }
  }

  try {
    const generatedTitle = await plugin.openAIService.createChatCompletion(
      systemPrompt,
      userMessage,
      model.id,
      plugin.settings.maxTokens
    );

    return sanitizeFileName(generatedTitle.trim());
  } catch (error) {
    logger.error('Error generating title:', error);
    throw new Error(
      'Failed to generate title. Please check your API key and try again.'
    );
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^\w\-. ]/g, '') // Remove invalid characters
    .replace(/^\.+/, '') // Remove leading dots
    .trim() // Trim leading/trailing whitespace
    .replace(/\s+/g, ' '); // Replace multiple spaces with a single space
}

function updateModelStatusBar(plugin: BrainModule, modelName: string): void {
  if (plugin.plugin.modelToggleStatusBarItem) {
    plugin.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
  }
}
