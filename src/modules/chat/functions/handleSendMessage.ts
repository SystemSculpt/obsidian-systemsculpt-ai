import { ChatMessage } from "../ChatMessage";
import { TFile } from "obsidian";

export async function handleSendMessage(
  inputEl: HTMLTextAreaElement,
  addMessage: (message: ChatMessage) => void,
  createChatFile: (messageText: string) => Promise<void>,
  updateChatFile: (content: string) => Promise<void>,
  sendMessageToAI: () => Promise<void>,
  updateTokenCount: () => void,
  chatFile: TFile | null,
) {
  const messageText = inputEl.value.trim();
  if (messageText === "") return;

  const userMessage = new ChatMessage("user", messageText);
  addMessage(userMessage);
  inputEl.value = "";

  if (!chatFile) {
    await createChatFile(messageText);
  } else {
    await updateChatFile(`\`\`\`\`\`user\n${messageText}\n\`\`\`\`\`\n\n`);
  }

  await sendMessageToAI();
  updateTokenCount(); // Update token count after sending message
}
