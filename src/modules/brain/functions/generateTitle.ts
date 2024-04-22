import { BrainModule } from '../BrainModule';
import { showCustomNotice } from '../../../modals';
import { handleStreamingResponse } from '../../templates/functions/handleStreamingResponse';
import { AIService } from '../../../api/AIService';

export async function generateTitle(
  plugin: BrainModule,
  noteContent: string
): Promise<string> {
  const systemPrompt = plugin.settings.generateTitlePrompt;
  const userMessage = noteContent;

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
      return '';
    }
  }

  try {
    let generatedTitle = '';
    let isGenerationComplete = false;
    const abortController = new AbortController();

    await plugin.openAIService.createStreamingChatCompletionWithCallback(
      systemPrompt,
      userMessage,
      model.id,
      plugin.settings.maxTokens,
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
                generatedTitle += json.choices[0].delta.content;
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
      throw new Error('Title generation incomplete');
    }

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
