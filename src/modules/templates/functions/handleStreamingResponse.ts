import { Editor } from "obsidian";
import { showCustomNotice } from "../../../modals";
import { IGenerationModule } from "../../../interfaces/IGenerationModule";
import { ChatMessage } from "../../chat/ChatMessage";

export function handleStreamingResponse(
  chunk: string,
  editor: Editor,
  plugin: IGenerationModule
): void {
  const signal = plugin.abortController?.signal;
  if (signal?.aborted) {
    return;
  }

  try {
    const data = JSON.parse(chunk);
    if (data.choices && data.choices[0].message) {
      // Non-streaming response
      const content = data.choices[0].message.content;
      const startPos = editor.getCursor();
      editor.replaceSelection(content);
      const lines = content.split("\n");
      let endPos = {
        line: startPos.line + lines.length - 1,
        ch:
          lines.length === 1
            ? startPos.ch + lines[lines.length - 1].length
            : lines[lines.length - 1].length,
      };
      editor.setCursor(endPos);
      showCustomNotice("Generation completed!", 5000);
      plugin.abortController = null;
      plugin.isGenerationCompleted = true;
      return;
    }
  } catch (error) {
    // If it's not a JSON, proceed with streaming response handling
  }

  const dataLines = chunk.split("\n");
  let incompleteJSON = "";

  for (const line of dataLines) {
    if (line.trim() === "") {
      continue;
    }

    if (line.startsWith("data:")) {
      const dataStr = line.slice(5).trim();
      if (dataStr === "[DONE]") {
        showCustomNotice("Generation completed!", 5000);
        plugin.abortController = null;
        plugin.isGenerationCompleted = true;
        return;
      }

      try {
        const jsonStr = incompleteJSON + dataStr;
        incompleteJSON = "";
        const data = JSON.parse(jsonStr);

        if (data.choices && data.choices[0].delta.content) {
          let content = data.choices[0].delta.content;
          const startPos = editor.getCursor();
          editor.replaceSelection(content);

          const lines = content.split("\n");
          let endPos = {
            line: startPos.line + lines.length - 1,
            ch:
              lines.length === 1
                ? startPos.ch + lines[lines.length - 1].length
                : lines[lines.length - 1].length,
          };

          editor.setCursor(endPos);
        }
      } catch (error) {
        if (
          error instanceof SyntaxError &&
          error.message.includes("Unexpected end of JSON input")
        ) {
          incompleteJSON += dataStr;
        } else if (
          // @ts-ignore
          error.message.includes("Unterminated string in JSON at position")
        ) {
        }
      }
    } else {
      if (plugin.addMessage) {
        const aiMessage = new ChatMessage("ai", line.trim());
        plugin.addMessage(aiMessage);
      }
    }
  }
}
