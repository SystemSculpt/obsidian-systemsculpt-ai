import { ChatView } from "./ChatView";
import { showStandardChatSettingsModal } from "../../modals/StandardChatSettingsModal";
import { SystemPromptService } from "../../services/SystemPromptService";
import { GENERAL_USE_PRESET, CONCISE_PRESET } from "../../constants/prompts";

/**
 * Helper methods for handling system prompt editing
 */
export const systemPromptHandling = {
  /**
   * Handle the editing of system prompts
   * @param chatView The current chat view
   * @returns Promise that resolves when editing is complete
   */
  async handleSystemPromptEdit(chatView: ChatView): Promise<void> {
    try {
      // Get current prompt content
      const currentPromptContent = await chatView.getCurrentSystemPrompt();
      
      // Get current type and path from chat state
      const currentType = chatView.systemPromptType || "general-use";
      const currentPath = chatView.systemPromptPath;
      
      // Open the modal with the correct options object structure
      const result = await showStandardChatSettingsModal(
        chatView.app, // Argument 1: App instance
        {             // Argument 2: Options object
          // Core properties for the modal
          currentPrompt: currentPromptContent,
          currentSystemPromptType: currentType,
          systemPromptPath: currentPath,
          chatView: chatView, // Pass the chatView instance itself
          plugin: chatView.plugin, // Pass the plugin instance
          
          // Properties needed for title editing
          chatTitle: chatView.getChatTitle(),
          onTitleChange: async (newTitle) => {
              await chatView.setTitle(newTitle); // Use ChatView's method
          },
          messages: chatView.getMessages(), // Pass messages for title generation
          
          // Properties needed for model selection
          currentModelId: chatView.getSelectedModelId(), // Get current model from ChatView
          onModelSelect: async (modelId) => {
              await chatView.setSelectedModelId(modelId); // Use ChatView's method
          }
        }
      );
      
      if (result) {
        // User saved changes - the modal now handles applying changes via ChatView
      } else {
        // User canceled
      }
    } catch (error) {
      chatView.handleError("Failed to edit system prompt");
    }
  }
};
