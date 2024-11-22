import { TasksModule } from "../TasksModule";
import { showCustomNotice } from "../../../modals";
import { BrainModule } from "../../brain/BrainModule";

export async function generateTask(
  plugin: TasksModule,
  taskDescription: string
): Promise<string> {
  const systemPrompt = plugin.settings.defaultTaskPrompt;
  const userMessage = taskDescription;

  const modelId = plugin.plugin.brainModule.settings.defaultModelId;

  let model = await plugin.plugin.brainModule.getModelById(modelId);

  if (!model) {
    const models = await plugin.plugin.brainModule.getEnabledModels();

    if (models.length > 0) {
      model = models[0];
      plugin.plugin.brainModule.settings.defaultModelId = model.id;
      await plugin.plugin.brainModule.saveSettings();
      updateModelStatusBar(plugin.plugin.brainModule, model.name);
    } else {
      showCustomNotice(
        "No models available. Please check your model settings and ensure at least one provider is enabled."
      );
      return "";
    }
  }

  const temperature = plugin.plugin.brainModule.settings.temperature || 0.5;

  try {
    const apiService = plugin.plugin.brainModule.AIService;
    const generatedTask = await apiService.createChatCompletion(
      systemPrompt,
      userMessage,
      model.id
    );

    return generatedTask.trim();
  } catch (error) {
    throw new Error(
      "Failed to generate task. Please check your API key and try again."
    );
  }
}

function updateModelStatusBar(plugin: BrainModule, modelName: string): void {
  if (plugin.plugin.modelToggleStatusBarItem) {
    plugin.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
  }
}
