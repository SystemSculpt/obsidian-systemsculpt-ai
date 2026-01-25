import { Notice } from "obsidian";
import { LargeTextHelpers } from "../../../constants/largeText";

export interface KeyHandlersContext {
  isGenerating: () => boolean;
  handleSendMessage: () => Promise<void>;
  handleStopGeneration: () => Promise<void> | void;
  input: HTMLTextAreaElement;
  slashCommandMenu?: { handleKeydown: (e: KeyboardEvent) => boolean; isOpen: () => boolean; show: (q: string) => void; updateQuery: (q: string) => void; hide: () => void };
  atMentionMenu?: { handleKeydown: (e: KeyboardEvent) => boolean; isOpen: () => boolean; show: (atIndex: number, tokenEnd: number, query: string) => void; updateQuery: (atIndex: number, tokenEnd: number, query: string) => void; hide: () => void };
  agentSelectionMenu?: { isOpen: () => boolean; show: (triggerPos: number) => Promise<void>; hide: () => void };
}

export async function handleKeyDown(ctx: KeyHandlersContext, event: KeyboardEvent): Promise<void> {
  // Agent menu takes priority when open
  if (ctx.agentSelectionMenu?.isOpen()) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter' || event.key === 'Escape') {
      return;
    }
  }

  if (ctx.slashCommandMenu?.handleKeydown(event)) {
    return;
  }

  if (ctx.atMentionMenu?.handleKeydown(event)) {
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (ctx.isGenerating()) {
      new Notice("Please wait for the current response to complete before sending another message");
      return;
    }
    await ctx.handleSendMessage();
  }

  if (event.key === 'Escape' && ctx.isGenerating()) {
    event.preventDefault();
    await ctx.handleStopGeneration();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === '.') {
    if (ctx.isGenerating()) {
      event.preventDefault();
      await ctx.handleStopGeneration();
    }
  }
}

export function handleInputChange(ctx: { input: HTMLTextAreaElement; adjustInputHeight: () => void; slashCommandMenu?: any; atMentionMenu?: any; agentSelectionMenu?: any; setPendingLargeTextContent: (text: string | null) => void; }): void {
  ctx.adjustInputHeight();
  handleAgentSelectionDetection(ctx);
  handleSlashCommandDetection(ctx);
  handleAtMentionDetection(ctx);

  if (ctx.input && ctx.setPendingLargeTextContent) {
    if (!LargeTextHelpers.containsPlaceholder(ctx.input.value)) {
      ctx.setPendingLargeTextContent(null);
    }
  }
}

export function handleAgentSelectionDetection(ctx: { input: HTMLTextAreaElement; agentSelectionMenu?: any; slashCommandMenu?: any }): void {
  if (!ctx.agentSelectionMenu) return;
  
  const value = ctx.input.value;
  const cursorPos = ctx.input.selectionStart || 0;
  
  // Check if input starts with /agent followed by space or just /agent
  const agentCommandPattern = /^\/agent(\s|$)/;
  const match = value.match(agentCommandPattern);
  
  if (match && cursorPos >= match[0].length) {
    // User has typed /agent (with optional space) - show agent menu
    if (!ctx.agentSelectionMenu.isOpen()) {
      ctx.agentSelectionMenu.show(cursorPos);
    }
    // Hide slash command menu if it's open
    if (ctx.slashCommandMenu?.isOpen()) {
      ctx.slashCommandMenu.hide();
    }
  } else if (ctx.agentSelectionMenu.isOpen()) {
    // Input no longer matches /agent pattern - hide agent menu
    ctx.agentSelectionMenu.hide();
  }
}

export function handleSlashCommandDetection(ctx: { input: HTMLTextAreaElement; slashCommandMenu?: any; agentSelectionMenu?: any }): void {
  if (!ctx.slashCommandMenu) return;
  
  // Don't show slash menu if agent menu is handling it
  if (ctx.agentSelectionMenu?.isOpen()) return;
  
  const value = ctx.input.value;
  const cursorPos = ctx.input.selectionStart || 0;
  const isLeadingSlash = value.startsWith('/') && cursorPos >= 1;
  
  if (isLeadingSlash) {
    const query = value.substring(1, cursorPos);
    if (!ctx.slashCommandMenu.isOpen()) ctx.slashCommandMenu.show(query);
    else ctx.slashCommandMenu.updateQuery(query);
  } else if (ctx.slashCommandMenu.isOpen()) {
    ctx.slashCommandMenu.hide();
  }
}

export function handleAtMentionDetection(ctx: { input: HTMLTextAreaElement; atMentionMenu?: any }): void {
  if (!ctx.atMentionMenu) return;
  const value = ctx.input.value;
  const cursorPos = ctx.input.selectionStart || 0;
  let atIndex = -1;
  for (let i = cursorPos - 1; i >= 0; i--) {
    if (value[i] === '@') {
      if (i === 0 || /\s/.test(value[i - 1])) { atIndex = i; break; }
    } else if (/\s/.test(value[i])) { break; }
  }
  if (atIndex !== -1) {
    let tokenEnd = cursorPos;
    while (tokenEnd < value.length && !/\s/.test(value[tokenEnd])) {
      tokenEnd++;
    }
    const query = value.substring(atIndex + 1, cursorPos);
    if (!ctx.atMentionMenu.isOpen()) ctx.atMentionMenu.show(atIndex, tokenEnd, query);
    else ctx.atMentionMenu.updateQuery(atIndex, tokenEnd, query);
  } else if (ctx.atMentionMenu.isOpen()) {
    ctx.atMentionMenu.hide();
  }
}

