import { encode } from 'gpt-tokenizer';
import { TFile } from 'obsidian';
import { ChatMessage } from './ChatMessage';
import { Model } from '../../api/Model';

export const DEFAULT_CHATS_PATH = 'SystemSculpt/Chats';
export const DEFAULT_SYSTEM_PROMPT =
  "You are the universe's most intelligent assistant. Your responses are succinct, problem solving, and concise. You don't limit yourself to something as unimportant as a simple AI; you're much more than that - an entity built on human history, ecompassing knowledge from all depths of what has been created thus far.";

export async function getTokenCount(
  app: any,
  chatMessages: ChatMessage[],
  contextFiles: TFile[],
  inputText: string
): Promise<number> {
  const messageHistory = chatMessages
    .map(msg => `${msg.role}\n${msg.text}`)
    .join('\n\n');
  const contextFilesContent = await getContextFilesContent(app, contextFiles);
  const fullMessage = `${contextFilesContent}\n\n${messageHistory}\n\nuser\n${inputText}`;
  const tokens = encode(fullMessage);
  return tokens.length;
}

export async function getContextFilesContent(
  app: any,
  contextFiles: TFile[]
): Promise<string> {
  if (contextFiles.length === 0) return '';
  let contextContent = '';
  for (const file of contextFiles) {
    const content = await app.vault.read(file);
    contextContent += `### ${file.basename}\n${content}\n`;
  }
  return contextContent;
}

import { CostEstimator } from '../../interfaces/CostEstimatorModal';

export function displayTokenCount(
  tokenCount: number,
  containerEl: HTMLElement,
  chatMessagesLength: number,
  model: Model,
  maxOutputTokens: number
) {
  const tokenCountEl = containerEl.querySelector('.token-count') as HTMLElement;
  const costEstimateEl = containerEl.querySelector(
    '.cost-estimate'
  ) as HTMLElement;
  const dollarButton = containerEl.querySelector(
    '.dollar-button'
  ) as HTMLElement;
  const titleContainerEl = containerEl.querySelector(
    '.chat-title-container'
  ) as HTMLElement;

  if (chatMessagesLength === 0) {
    if (tokenCountEl) tokenCountEl.style.display = 'none';
    if (costEstimateEl) costEstimateEl.style.display = 'none';
    if (dollarButton) dollarButton.style.display = 'none';
    if (titleContainerEl) titleContainerEl.style.display = 'none';
  } else {
    if (tokenCountEl) {
      tokenCountEl.style.display = 'inline';
      tokenCountEl.textContent = `Tokens: ${tokenCount}`;
    }
    if (costEstimateEl) {
      if (model.pricing) {
        const { minCost, maxCost } = CostEstimator.calculateCost(
          model,
          tokenCount,
          maxOutputTokens
        );
        costEstimateEl.style.display = 'inline';
        costEstimateEl.textContent = `Estimated Cost: $${formatNumber(
          minCost
        )} - $${formatNumber(maxCost)}`;
      } else {
        costEstimateEl.style.display = 'none';
      }
    }
    if (titleContainerEl) titleContainerEl.style.display = 'flex';
    if (dollarButton) dollarButton.style.display = 'inline';
  }
}

export function formatNumber(num: number): string {
  if (num === 0) return '0.00';
  if (num >= 1) return num.toFixed(2);

  const fixed = num.toFixed(10);
  const [integer, decimal] = fixed.split('.');

  if (decimal.startsWith('00')) {
    const significantIndex = decimal.split('').findIndex(d => d !== '0');
    if (significantIndex === -1) {
      return `${integer}.${'0'.repeat(10)}`;
    }
    const significantDigits = decimal.slice(
      significantIndex,
      significantIndex + 2
    );
    return `${integer}.${'0'.repeat(
      Math.max(0, significantIndex)
    )}${significantDigits}`;
  }

  return Number(fixed).toFixed(2);
}
