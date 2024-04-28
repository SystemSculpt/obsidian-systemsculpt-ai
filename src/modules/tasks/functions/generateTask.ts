import { TasksModule } from '../TasksModule';
import { showCustomNotice } from '../../../modals';
import { AIService } from '../../../api/AIService';
import { BrainModule } from '../../brain/BrainModule';

export async function generateTask(
  plugin: TasksModule,
  taskDescription: string
): Promise<string> {
  const systemPrompt = plugin.settings.defaultTaskPrompt;
  const userMessage = taskDescription;

  const modelId = plugin.plugin.brainModule.settings.defaultModelId;

  let model = await plugin.plugin.brainModule.openAIService.getModelById(
    modelId
  );

  if (!model) {
    const localModels = await plugin.plugin.brainModule.openAIService.getModels(
      false
    );
    const onlineModels =
      await plugin.plugin.brainModule.openAIService.getModels(true);
    const firstLocalModel = localModels[0];
    if (firstLocalModel) {
      plugin.plugin.brainModule.settings.defaultModelId = firstLocalModel.id;
      await plugin.plugin.brainModule.saveSettings();
      updateModelStatusBar(plugin.plugin.brainModule, firstLocalModel.name);
      model = firstLocalModel;
    } else if (onlineModels.length > 0) {
      model = onlineModels[0];
      plugin.plugin.brainModule.settings.defaultModelId = model.id;
      await plugin.plugin.brainModule.saveSettings();
      updateModelStatusBar(plugin.plugin.brainModule, model.name);
    } else {
      showCustomNotice(
        'No local or online models available. Please check your model settings.'
      );
      return '';
    }
  }

  const temperature = plugin.plugin.brainModule.settings.temperature || 0.5;
  const maxTokens = plugin.plugin.brainModule.settings.maxTokens || 2048;

  try {
    const apiService = plugin.plugin.brainModule.openAIService;
    const generatedTask = await apiService.createChatCompletion(
      systemPrompt,
      userMessage,
      model.id,
      maxTokens
    );

    return generatedTask.trim();
  } catch (error) {
    console.error('Error generating task:', error);
    throw new Error(
      'Failed to generate task. Please check your API key and try again.'
    );
  }
}

function updateModelStatusBar(plugin: BrainModule, modelName: string): void {
  if (plugin.plugin.modelToggleStatusBarItem) {
    plugin.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
  }
}
