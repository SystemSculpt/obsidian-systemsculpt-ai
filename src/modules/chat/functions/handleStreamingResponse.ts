import { ChatMessage } from '../ChatMessage';

export function handleStreamingResponse(
  chunk: string,
  appendToLastMessage: (content: string) => void,
  addMessage: (message: ChatMessage) => void
): string {
  const dataLines = chunk.split('\n');
  let incompleteJSON = '';
  let accumulatedContent = '';

  for (const line of dataLines) {
    if (line.trim() === '' || line.includes('OPENROUTER PROCESSING')) {
      continue;
    }

    if (line.startsWith('data:')) {
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') {
        return accumulatedContent;
      }

      try {
        const jsonStr = incompleteJSON + dataStr;
        incompleteJSON = '';
        const data = JSON.parse(jsonStr);

        if (
          data.choices &&
          data.choices[0].delta &&
          data.choices[0].delta.content
        ) {
          accumulatedContent += data.choices[0].delta.content;
          appendToLastMessage(accumulatedContent);
        }
      } catch (error) {
        if (
          error instanceof SyntaxError &&
          error.message.includes('Unexpected end of JSON input')
        ) {
          incompleteJSON += dataStr;
        } else if (
          (error as Error).message.includes(
            'Unterminated string in JSON at position'
          )
        ) {
        } else {
        }
      }
    }
  }

  return accumulatedContent;
}
