import { BrainModule } from "../BrainModule";
import { showCustomNotice } from "../../../modals";

export async function generateTitle(
  plugin: BrainModule,
  noteContent: string
): Promise<string> {
  const systemPrompt = plugin.settings.generateTitlePrompt;
  const userMessage = noteContent;
  const modelId = plugin.settings.defaultModelId;

  let model = await plugin.getModelById(modelId);

  if (!model) {
    const models = await plugin.getEnabledModels();

    if (models.length > 0) {
      model = models[0];
      plugin.settings.defaultModelId = model.id;
      await plugin.saveSettings();
      updateModelStatusBar(plugin, model.name);
    } else {
      showCustomNotice(
        "No models available. Please check your model settings and ensure at least one provider is enabled."
      );
      return "";
    }
  }

  try {
    const generatedTitle = await plugin.AIService.createChatCompletion(
      systemPrompt,
      userMessage,
      model.id,
      model.maxOutputTokens || 4096
    );

    return sanitizeFileName(generatedTitle.trim());
  } catch (error) {
    throw new Error(
      "Failed to generate title. Please check your API key and try again."
    );
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^\w\-. ]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .replace(/\s+/g, " ");
}

function updateModelStatusBar(plugin: BrainModule, modelName: string): void {
  if (plugin.plugin.modelToggleStatusBarItem) {
    plugin.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
  }
}
