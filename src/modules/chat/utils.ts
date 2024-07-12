import { encode } from 'gpt-tokenizer';
import { TFile } from 'obsidian';
import { ChatMessage } from './ChatMessage';

export const DEFAULT_CHATS_PATH = 'SystemSculpt/Chats';
export const DEFAULT_SYSTEM_PROMPT = "You are the universe's most intelligent assistant. Your responses are succinct, problem solving, and concise. You don't limit yourself to something as unimportant as a simple AI; you're much more than that - an entity built on human history, ecompassing knowledge from all depths of what has been created thus far.";

export async function getTokenCount(app: any, chatMessages: ChatMessage[], contextFiles: TFile[], inputText: string): Promise<number> {
    const messageHistory = chatMessages.map(msg => `${msg.role}\n${msg.text}`).join('\n\n');
    const contextFilesContent = await getContextFilesContent(app, contextFiles);
    const fullMessage = `${contextFilesContent}\n\n${messageHistory}\n\nuser\n${inputText}`;
    const tokens = encode(fullMessage);
    return tokens.length;
}

export async function getContextFilesContent(app: any, contextFiles: TFile[]): Promise<string> {
    if (contextFiles.length === 0) return '';
    let contextContent = '';
    for (const file of contextFiles) {
        const content = await app.vault.read(file);
        contextContent += `### ${file.basename}\n${content}\n`;
    }
    return contextContent;
}

export function displayTokenCount(tokenCount: number, containerEl: HTMLElement, chatMessagesLength: number) {
    const tokenCountEl = containerEl.querySelector('.token-count') as HTMLElement;
    const dollarButton = containerEl.querySelector('.dollar-button') as HTMLElement;
    const titleContainerEl = containerEl.querySelector('.chat-title-container') as HTMLElement;

    if (chatMessagesLength === 0) {
        if (tokenCountEl) tokenCountEl.style.display = 'none';
        if (dollarButton) dollarButton.style.display = 'none';
        if (titleContainerEl) titleContainerEl.style.display = 'none';
    } else {
        if (tokenCountEl) {
            tokenCountEl.style.display = 'inline';
            tokenCountEl.textContent = `Tokens: ${tokenCount}`;
        }
        if (titleContainerEl) titleContainerEl.style.display = 'flex';
        if (dollarButton) dollarButton.style.display = 'inline';
    }
}
