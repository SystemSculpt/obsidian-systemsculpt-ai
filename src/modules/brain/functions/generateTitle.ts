import { BrainModule } from '../BrainModule';
import { showCustomNotice } from '../../../modals';
import { AIService } from '../../../api/AIService';

export async function generateTitle(
  plugin: BrainModule,
  noteContent: string
): Promise<string> {
  const systemPrompt = plugin.settings.generateTitlePrompt;
  const userMessage = noteContent;

  const modelId = plugin.settings.defaultModelId;

  let model = await plugin.getModelById(modelId);

  if (!model) {
    const localModels = await plugin.openAIService.getModels(false);
    const onlineModels = await plugin.openAIService.getModels(true);
    const firstLocalModel = localModels[0];
    if (firstLocalModel) {
      plugin.settings.defaultModelId = firstLocalModel.id;
      await plugin.saveSettings();
      updateModelStatusBar(plugin, firstLocalModel.name);
      model = firstLocalModel;
    } else if (onlineModels.length > 0) {
      model = onlineModels[0];
      plugin.settings.defaultModelId = model.id;
      await plugin.saveSettings();
      updateModelStatusBar(plugin, model.name);
    } else {
      showCustomNotice(
        'No local or online models available. Please check your model settings.'
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
    console.error('Error generating title:', error);
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
