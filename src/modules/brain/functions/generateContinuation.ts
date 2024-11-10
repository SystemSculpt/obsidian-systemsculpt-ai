import { BrainModule } from "../BrainModule";
import { MarkdownView } from "obsidian";
import { showCustomNotice } from "../../../modals";

export async function generateContinuation(
  plugin: BrainModule,
  abortSignal: AbortSignal
): Promise<void> {
  const activeView =
    plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!activeView) {
    showCustomNotice("No active note found to generate continuation");
    return;
  }

  const editor = activeView.editor;
  const cursor = editor.getCursor();
  const noteContent = editor.getRange({ line: 0, ch: 0 }, cursor);

  if (abortSignal.aborted) return;

  const modelId = plugin.settings.defaultModelId;
  let model = await plugin.getModelById(modelId);

  if (!model) {
    const models = await plugin.getEnabledModels();
    if (models.length === 0) {
      showCustomNotice(
        "No models available. Please check your model settings and ensure at least one provider is enabled."
      );
      return;
    }
    model = models[0];
    plugin.settings.defaultModelId = model.id;
    await plugin.saveSettings();
    updateModelStatusBar(plugin, model.name);
  }

  let accumulatedResponse = "";
  let currentPos = editor.getCursor();
  await plugin.AIService.createStreamingChatCompletionWithCallback(
    plugin.settings.generalGenerationPrompt,
    noteContent,
    model.id,
    model.maxOutputTokens || 4096,
    (chunk: string) => {
      if (abortSignal.aborted) return;
      accumulatedResponse += chunk;
      editor.replaceRange(chunk, currentPos);
      const lines = chunk.split("\n");
      if (lines.length > 1) {
        currentPos = {
          line: currentPos.line + lines.length - 1,
          ch: lines[lines.length - 1].length,
        };
      } else {
        currentPos.ch += chunk.length;
      }
      editor.setCursor(currentPos);
    },
    abortSignal
  );
}

function updateModelStatusBar(plugin: BrainModule, modelName: string): void {
  if (plugin.plugin.modelToggleStatusBarItem) {
    plugin.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
  }
}
