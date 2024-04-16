import { Editor } from 'obsidian';
import { showCustomNotice } from '../../../modals';
import { IGenerationModule } from '../../../interfaces/IGenerationModule';

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
          // Escape backticks to prevent formatting issues
          content = content.replace(/`/g, '`');
          editor.replaceRange(content, editor.getCursor());
          const endPosition = editor.getCursor();
          endPosition.ch += content.length;
          editor.setCursor(endPosition);
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
          console.error('Error parsing JSON:', error); // Log other errors
        }
      }
    } else {
    }
  }
}
