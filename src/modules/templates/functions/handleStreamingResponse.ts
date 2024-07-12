import { Editor } from 'obsidian';
import { showCustomNotice } from '../../../modals';
import { IGenerationModule } from '../../../interfaces/IGenerationModule';
import { ChatMessage } from '../../chat/ChatMessage';
import { logger } from '../../../utils/logger';

export function handleStreamingResponse(
  chunk: string,
  editor: Editor,
  plugin: IGenerationModule
): void {
  const signal = plugin.abortController?.signal;
  if (signal?.aborted) {
    return;
  }

  const dataLines = chunk.split('\n');
  let incompleteJSON = '';

  for (const line of dataLines) {
    if (line.trim() === '') {
      continue;
    }

    if (line.startsWith('data:')) {
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') {
        showCustomNotice('Generation completed!', 5000); // Display the completion notice
        plugin.abortController = null; // Reset the abortController
        plugin.isGenerationCompleted = true; // Mark generation as completed
        return;
      }

      try {
        const jsonStr = incompleteJSON + dataStr;
        incompleteJSON = '';
        const data = JSON.parse(jsonStr);

        if (data.choices && data.choices[0].delta.content) {
          let content = data.choices[0].delta.content;
          const startPos = editor.getCursor(); // Get the starting cursor position before insertion
          editor.replaceSelection(content); // Paste the content directly

          const lines = content.split('\n');
          let endPos = {
            line: startPos.line + lines.length - 1,
            ch:
              lines.length === 1
                ? startPos.ch + lines[lines.length - 1].length
                : lines[lines.length - 1].length,
          };

          editor.setCursor(endPos); // Set the cursor at the end of the inserted content
        }
      } catch (error) {
        // Check if the error is due to an incomplete JSON string
        if (
          error instanceof SyntaxError &&
          error.message.includes('Unexpected end of JSON input')
        ) {
          incompleteJSON += dataStr;
        } else if (
          error.message.includes('Unterminated string in JSON at position')
        ) {
          // Suppress specific error message from being logged
        } else {
          logger.error('Error parsing JSON:', error); // Log other errors
        }
      }
    } else {
      // Handle chat response
      if (plugin.addMessage) {
        const aiMessage = new ChatMessage('ai', line.trim());
        plugin.addMessage(aiMessage);
      }
    }
  }
}
