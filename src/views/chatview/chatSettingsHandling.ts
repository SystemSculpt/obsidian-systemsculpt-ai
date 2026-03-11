import { ChatView } from "./ChatView";
import { showStandardChatSettingsModal } from "../../modals/StandardChatSettingsModal";
export const chatSettingsHandling = {
  async openChatSettings(chatView: ChatView): Promise<void> {
    try {
      await showStandardChatSettingsModal(chatView.app, {
        chatView,
        plugin: chatView.plugin,
      });
    } catch (error) {
      chatView.handleError("Failed to open chat settings");
    }
  }
};
