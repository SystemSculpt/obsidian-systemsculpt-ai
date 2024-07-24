import { TFile } from 'obsidian';
import { ChatMessage } from '../ChatMessage';
import { handleStreamingResponse } from './handleStreamingResponse';
import { logger } from '../../../utils/logger';

export async function sendMessage(
  inputEl: HTMLTextAreaElement,
  addMessage: (message: ChatMessage) => void,
  createChatFile: (messageText: string) => Promise<TFile>,
  updateChatFile: (content: string) => Promise<void>,
  updateTokenCount: () => Promise<void>,
  chatFile: TFile | null,
  brainModule: any,
  chatModule: any,
  constructMessageHistory: () => Promise<{ role: string; content: string }[]>,
  appendToLastMessage: (content: string) => void,
  showLoading: () => void,
  hideLoading: () => void
) {
  const messageText = inputEl.value.trim();
  if (messageText === '') return;

  const userMessage = new ChatMessage('user', messageText);
  addMessage(userMessage);
  inputEl.value = '';

  if (!chatFile) {
    chatFile = await createChatFile(messageText);
  } else {
    await updateChatFile(`\`\`\`\`\`user\n${messageText}\n\`\`\`\`\`\n\n`);
  }

  console.log('Test 1');
  const aiService = brainModule.AIService;
  const modelId = brainModule.settings.defaultModelId;
  const maxOutputTokens = brainModule.getMaxOutputTokens();
  let accumulatedResponse = '';
  console.log('Test 2');

  const systemPrompt = chatModule.settings.systemPrompt;
  const messageHistory = await constructMessageHistory();

  const updatedMessageHistory = messageHistory.map(msg => ({
    role:
      msg.role === 'ai' || msg.role.startsWith('ai-') ? 'assistant' : msg.role,
    content: msg.content,
  }));

  showLoading();

  try {
    await aiService.createStreamingConversationWithCallback(
      systemPrompt,
      updatedMessageHistory,
      modelId,
      maxOutputTokens,
      async (chunk: string) => {
        accumulatedResponse += handleStreamingResponse(
          chunk,
          (content: string) => {
            appendToLastMessage(content);
          },
          (message: ChatMessage) => {
            addMessage(message);
          }
        );
      }
    );

    const modelInfo = await brainModule.getModelById(modelId);
    const modelName = modelInfo ? modelInfo.name : 'unknown model';

    await updateChatFile(
      `\`\`\`\`\`ai-${modelName}\n${accumulatedResponse}\n\`\`\`\`\`\n\n`
    );
  } catch (error) {
    logger.error('Error streaming AI response:', error);
  } finally {
    hideLoading();
  }

  await updateTokenCount();
}
