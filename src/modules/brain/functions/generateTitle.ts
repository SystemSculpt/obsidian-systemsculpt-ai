import { BrainModule } from '../BrainModule';

export async function generateTitle(
  plugin: BrainModule,
  noteContent: string
): Promise<string> {
  const prompt = buildGenerateTitlePrompt(
    noteContent,
    plugin.settings.generateTitlePrompt
  );

  const modelId = plugin.settings.defaultOpenAIModelId || 'gpt-3.5-turbo';

  try {
    const generatedTitle = await plugin.openAIService.createChatCompletion(
      prompt,
      modelId,
      plugin.settings.temperature,
      plugin.settings.maxTokens
    );
    return sanitizeFileName(generatedTitle);
  } catch (error) {
    console.error('Error generating title:', error);
    throw new Error(
      'Failed to generate title. Please check your API key and try again.'
    );
  }
}

function buildGenerateTitlePrompt(
  noteContent: string,
  promptTemplate: string
): string {
  return promptTemplate.replace('{note}', noteContent);
}

export function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^\w\-. ]/g, '') // Remove invalid characters
    .replace(/^\.+/, '') // Remove leading dots
    .trim() // Trim leading/trailing whitespace
    .replace(/\s+/g, ' '); // Replace multiple spaces with a single space
}
