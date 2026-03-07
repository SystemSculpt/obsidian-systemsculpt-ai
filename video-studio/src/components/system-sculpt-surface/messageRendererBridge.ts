import { MessageRenderer } from "@plugin-ui/MessageRenderer";
import { setExpanded, setStreaming } from "@plugin-ui/InlineCollapsibleBlock";
import { appendMessageToGroupedContainer } from "@plugin-ui/MessageGrouping";
import type { ChatMessageSpec, StructuredLineSpec, ToolCallBlockSpec } from "../../lib/storyboard";
import { resolveTextReveal, resolveTextRevealLines } from "../../lib/textReveal";

type VideoToolCallState = "executing" | "completed" | "failed";
type ResolvedFrameText = {
  text: string;
  isComplete: boolean;
};
type VideoPluginMessage = {
  role: ChatMessageSpec["role"];
  content: string | null;
  message_id: string;
  messageParts: Array<{
    id: string;
    type: "reasoning" | "content" | "tool_call";
    timestamp: number;
    data: unknown;
  }>;
  streaming: false;
};
type VideoMessageRenderState = {
  pluginMessage: VideoPluginMessage;
  hasReasoning: boolean;
  reasoningIsRevealing: boolean;
};

const stringifyStructuredLine = (line: StructuredLineSpec): string => {
  return [line.prefix, line.label, line.detail].filter(Boolean).join(" ").trim();
};

const slugifyToolName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tool_call";

const mapStatusToneToToolCallState = (
  block: ToolCallBlockSpec
): VideoToolCallState => {
  if (block.statusTone === "success") {
    return "completed";
  }
  if (block.statusTone === "error") {
    return "failed";
  }
  return "executing";
};

const buildMessageMarkdown = (
  message: ChatMessageSpec,
  frame: number,
  fps: number
): ResolvedFrameText => {
  if (typeof message.markdown === "string") {
    const resolvedMarkdown = resolveTextReveal(message.markdown, frame, fps, message.reveal);
    return {
      text: resolvedMarkdown.text,
      isComplete: resolvedMarkdown.isComplete,
    };
  }

  const sections: string[] = [];
  let isComplete = true;

  if ((message.paragraphs?.length ?? 0) > 0) {
    const paragraphs = resolveTextRevealLines(
      message.paragraphs ?? [],
      frame,
      fps,
      message.reveal
    );
    isComplete &&= paragraphs.every((paragraph) => paragraph.isComplete);
    const paragraphText = paragraphs.map((paragraph) => paragraph.text).filter(Boolean);
    if (paragraphText.length > 0) {
      sections.push(paragraphText.join("\n\n"));
    }
  }

  if ((message.bullets?.length ?? 0) > 0) {
    const bullets = resolveTextRevealLines(
      message.bullets ?? [],
      frame,
      fps,
      message.reveal
    );
    isComplete &&= bullets.every((bullet) => bullet.isComplete);
    const bulletText = bullets
      .map((bullet) => bullet.text)
      .filter(Boolean)
      .map((bullet) => `- ${bullet}`);
    if (bulletText.length > 0) {
      sections.push(bulletText.join("\n"));
    }
  }

  return {
    text: sections.join("\n\n"),
    isComplete,
  };
};

const buildReasoningMarkdown = (
  lines: readonly string[],
  frame: number,
  fps: number,
  reveal: ChatMessageSpec["reveal"]
): ResolvedFrameText => {
  const resolvedLines = resolveTextRevealLines(lines, frame, fps, reveal);
  return {
    text: resolvedLines
      .map((line) => line.text)
      .filter(Boolean)
      .join("\n\n"),
    isComplete: resolvedLines.every((line) => line.isComplete),
  };
};

const buildToolArguments = (block: ToolCallBlockSpec): Record<string, unknown> => {
  if (block.arguments) {
    return block.arguments;
  }

  return Object.fromEntries(
    (block.lines ?? []).map((line, index) => [
      line.id || `arg_${index + 1}`,
      stringifyStructuredLine(line),
    ])
  );
};

const adaptToolCallBlock = (
  block: ToolCallBlockSpec,
  messageId: string,
  timestamp: number
) => {
  const state = mapStatusToneToToolCallState(block);
  return {
    id: block.id,
    messageId,
    request: {
      id: block.id,
      type: "function" as const,
      function: {
        name: block.toolName ?? slugifyToolName(block.title),
        arguments: JSON.stringify(buildToolArguments(block)),
      },
    },
    state,
    timestamp,
    executionStartedAt: timestamp,
    executionCompletedAt: state === "executing" ? undefined : timestamp + 1,
    result:
      block.result ??
      (state === "completed"
        ? {
            success: true,
          }
        : state === "failed"
          ? {
              success: false,
              error: {
                code: "storyboard_tool_call_failed",
                message: block.status,
              },
            }
          : undefined),
    serverId: block.serverId,
  };
};

const toPluginChatMessage = (
  message: ChatMessageSpec,
  frame: number,
  fps: number
): VideoMessageRenderState => {
  const messageParts: Array<{
    id: string;
    type: "reasoning" | "content" | "tool_call";
    timestamp: number;
    data: unknown;
  }> = [];

  let timestamp = 0;
  const markdown = buildMessageMarkdown(message, frame, fps);
  let hasReasoning = false;
  let reasoningIsRevealing = false;
  if (markdown.text.trim().length > 0) {
    messageParts.push({
      id: `${message.id}-content`,
      type: "content",
      timestamp: timestamp++,
      data: markdown.text,
    });
  }

  for (const block of message.inlineBlocks ?? []) {
    if (block.kind === "reasoning") {
      hasReasoning = true;
      const reasoningReveal = block.reveal ?? message.reveal;
      const reasoning = buildReasoningMarkdown(
        block.textLines,
        frame,
        fps,
        reasoningReveal
      );
      reasoningIsRevealing ||= !reasoning.isComplete;
      if (reasoning.text.trim().length > 0) {
        messageParts.push({
          id: block.id,
          type: "reasoning",
          timestamp: timestamp++,
          data: reasoning.text,
        });
      }
      continue;
    }

    messageParts.push({
      id: block.id,
      type: "tool_call",
      timestamp: timestamp++,
      data: adaptToolCallBlock(block, message.id, timestamp),
    });
  }

  return {
    pluginMessage: {
      role: message.role,
      content: markdown.text.trim().length > 0 ? markdown.text : null,
      message_id: message.id,
      messageParts,
      // Remotion reveals content frame-by-frame ahead of time. Keeping the live
      // plugin renderer in streaming mode makes it schedule throttled async
      // updates, which causes blank or flickering text when each video frame is
      // mounted from scratch.
      streaming: false,
    },
    hasReasoning,
    reasoningIsRevealing,
  };
};

export const createHostMessageRenderer = (app: any) => new MessageRenderer(app);

export const renderThreadMessage = (
  renderer: MessageRenderer,
  container: HTMLElement,
  message: ChatMessageSpec,
  frame: number,
  fps: number
) => {
  const messageEl = document.createElement("div");
  messageEl.className = `systemsculpt-message systemsculpt-${message.role}-message`;
  messageEl.dataset.messageId = message.id;
  messageEl.dataset.role = message.role;
  const contentEl = messageEl.createDiv({ cls: "systemsculpt-message-content" });
  const { pluginMessage, hasReasoning, reasoningIsRevealing } = toPluginChatMessage(
    message,
    frame,
    fps
  );

  renderer.renderMessageParts(
    messageEl,
    pluginMessage,
    false
  );

  if (hasReasoning) {
    const reasoningBlock = messageEl.querySelector(
      '.systemsculpt-inline-collapsible[data-aggregate-section="reasoning"]'
    ) as HTMLElement | null;
    if (reasoningBlock) {
      setExpanded(reasoningBlock, true);
      setStreaming(reasoningBlock, reasoningIsRevealing);
    }
  }

  if (message.citations?.length) {
    renderer.renderCitations(
      contentEl,
      message.citations.map((citation) => ({
        url: citation.url,
        title: citation.title,
        content: citation.snippet,
      }))
    );
  }

  appendMessageToGroupedContainer(container, messageEl, message.role, {
    breakGroup: message.role === "system",
  });
};
