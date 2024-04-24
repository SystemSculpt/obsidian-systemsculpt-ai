import { TasksModule } from '../TasksModule';
import { showCustomNotice } from '../../../modals';
import { handleStreamingResponse } from '../../templates/functions/handleStreamingResponse';
import { AIService } from '../../../api/AIService';
import { BrainModule } from '../../brain/BrainModule';

export async function generateTask(
  plugin: TasksModule,
  taskDescription: string
): Promise<string> {
  const systemPrompt = plugin.settings.defaultTaskPrompt;
  const userMessage = taskDescription;

  const modelId = plugin.plugin.brainModule.settings.defaultOpenAIModelId;

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
      plugin.plugin.brainModule.settings.defaultOpenAIModelId =
        firstLocalModel.id;
      await plugin.plugin.brainModule.saveSettings();
      updateModelStatusBar(plugin.plugin.brainModule, firstLocalModel.name);
      model = firstLocalModel;
    } else if (onlineModels.length > 0) {
      model = onlineModels[0];
      plugin.plugin.brainModule.settings.defaultOpenAIModelId = model.id;
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

  if (plugin.plugin.brainModule.openAIService.isRequestCurrentlyInProgress()) {
    console.warn(
      'An OpenAI request is already in progress. Skipping task generation.'
    );
    return '';
  }

  try {
    const apiService = plugin.plugin.brainModule.openAIService;
    let generatedTask = '';
    let isGenerationComplete = false;
    const abortController = new AbortController();

    await apiService.createStreamingChatCompletionWithCallback(
      systemPrompt,
      userMessage,
      model.id,
      maxTokens,
      (chunk: string) => {
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              isGenerationComplete = true;
              break;
            }
            try {
              const json = JSON.parse(data);
              if (json.choices && json.choices[0].delta.content) {
                generatedTask += json.choices[0].delta.content;
              }
            } catch (error) {
              console.error('Error parsing JSON:', error);
            }
          }
        }
      },
      abortController.signal
    );

    if (!isGenerationComplete) {
      throw new Error('Task generation incomplete');
    }

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
