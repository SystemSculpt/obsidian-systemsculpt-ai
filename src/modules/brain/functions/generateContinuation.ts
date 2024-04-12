import { BrainModule } from '../BrainModule';
import { MarkdownView, Editor } from 'obsidian';
import { showCustomNotice } from '../../../modals';

export async function generateContinuation(
  plugin: BrainModule,
  abortSignal: AbortSignal
): Promise<void> {
  const activeView =
    plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView) {
    const editor = activeView.editor;
    const cursor = editor.getCursor();
    const line = cursor.line;
    const ch = cursor.ch;

    const noteContent = editor.getRange({ line: 0, ch: 0 }, { line, ch });

    // Check if abort has been signaled before proceeding
    if (abortSignal.aborted) {
      return;
    }

    await plugin.openAIService.createStreamingChatCompletionWithCallback(
      plugin.settings.generalGenerationPrompt,
      noteContent,
      plugin.settings.defaultOpenAIModelId,
      plugin.settings.maxTokens,
      (chunk: string) => {
        if (abortSignal.aborted) {
          return;
        }
        handleStreamingResponse(chunk, editor);
      },
      abortSignal
    );

    if (abortSignal.aborted) {
      return;
    }
  } else {
    showCustomNotice('No active note found to generate continuation');
  }
}

function handleStreamingResponse(chunk: string, editor: Editor): void {
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
        } else {
          console.error('Error parsing JSON:', error);
        }
      }
    } else {
    }
  }
}
