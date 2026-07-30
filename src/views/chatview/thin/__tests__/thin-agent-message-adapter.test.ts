import {
  createTextAttachmentPart,
  parseAttachedTextContent,
} from "../../attachments/ChatAttachmentContent";
import type { ChatMessage } from "../../../../types";
import {
  toThinAgentUserMessage,
} from "../ThinAgentMessageAdapter";
import type { UIMessage } from "ai";
import { ChatMarkdownSerializer } from "../../storage/ChatMarkdownSerializer";
import {
  durableAssistant,
  durableServerHistory,
  projectThinAgentChat,
} from "../ThinAgentProjection";

describe("thin agent PDF message history", () => {
  it("maps plain text, text files, and images while rejecting empty or malformed input", () => {
    expect(() => toThinAgentUserMessage({
      role: "assistant",
      message_id: "assistant-invalid",
      content: "No",
    })).toThrow("Only a newly admitted user message can start a response.");

    expect(() => toThinAgentUserMessage({
      role: "user",
      message_id: "user-empty",
      content: "",
    })).toThrow("A message needs text or an attachment.");

    const attachedText = createTextAttachmentPart(
      "notes.txt",
      "text/plain",
      new TextEncoder().encode("Attached notes"),
    );
    const multipart: ChatMessage = {
      role: "user",
      message_id: "user-multipart",
      content: [
        { type: "text", text: "Prompt" },
        attachedText,
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AA==" },
        },
      ],
      attachmentMetadata: [{
        id: "text-attachment",
        name: "notes.txt",
        mimeType: "text/plain",
        byteLength: 14,
        kind: "text",
        contentPartIndex: 1,
      }, {
        id: "image-attachment",
        name: "image.png",
        mimeType: "image/png",
        byteLength: 1,
        kind: "image",
        contentPartIndex: 2,
      }],
    };

    expect(toThinAgentUserMessage(multipart).parts).toEqual([
      { type: "text", text: "Prompt" },
      expect.objectContaining({
        type: "file",
        filename: "notes.txt",
        mediaType: "text/plain",
      }),
      {
        type: "file",
        filename: "image.png",
        mediaType: "image/png",
        url: "data:image/png;base64,AA==",
      },
    ]);

    expect(() => toThinAgentUserMessage({
      role: "user",
      message_id: "user-malformed-image",
      content: [{
        type: "image_url",
        image_url: { url: "not-a-data-url" },
      }],
    })).toThrow("An attached image is malformed.");
  });

  it("sends extracted PDF markdown with the truthful MIME and recovers it after replay", () => {
    const canary = "# PDF canary\n\nRésumé total: 42";
    const message: ChatMessage = {
      role: "user",
      message_id: "user-pdf",
      content: [
        { type: "text", text: "Read the attached report." },
        createTextAttachmentPart(
          "report.pdf",
          "text/markdown",
          new TextEncoder().encode(canary),
        ),
      ],
      attachmentMetadata: [{
        id: `document-${"a".repeat(64)}`,
        name: "report.pdf",
        mimeType: "application/pdf",
        byteLength: 1_024,
        kind: "document",
        contentPartIndex: 1,
      }],
    };

    const native = toThinAgentUserMessage(message);
    const file = native.parts.find((part) => part.type === "file");
    expect(file).toMatchObject({
      type: "file",
      filename: "report.pdf.extracted.md",
      mediaType: "text/markdown",
    });
    expect(file?.type === "file" ? file.url : "").toMatch(/^data:text\/markdown;base64,/);

    const replayedNative = JSON.parse(JSON.stringify(native));
    const [reopened] = durableServerHistory([replayedNative], 100);
    const reopenedPart = Array.isArray(reopened.content) ? reopened.content[1] : null;
    expect(reopenedPart?.type).toBe("text");
    expect(reopenedPart?.type === "text"
      ? parseAttachedTextContent(reopenedPart.text)
      : null).toMatchObject({
        name: "report.pdf",
        mimeType: "text/markdown",
        body: canary,
        unavailable: false,
      });

    const [reconnected] = durableServerHistory([replayedNative], 200);
    expect(reconnected.content).toEqual(reopened.content);
  });

  it("durably aggregates every assistant continuation into one terminal turn", () => {
    const chatMessages: UIMessage[] = [{
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Prepare the plan." }],
    }, {
      id: "assistant-tool",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Checking the vault.", state: "done" },
        {
          type: "tool-read",
          toolCallId: "call-read",
          state: "output-available",
          input: { paths: ["Plan.md"] },
          output: { success: true, data: { content: "Plan" } },
        },
        {
          type: "source-url",
          sourceId: "source-1",
          url: "https://example.com/source",
          title: "Source",
        },
        {
          type: "source-url",
          sourceId: "source-unsafe",
          url: "javascript:alert(1)",
          title: "Unsafe",
        },
      ],
    }, {
      id: "assistant-final",
      role: "assistant",
      parts: [{ type: "text", text: "The plan is ready.", state: "done" }],
    }];
    const snapshot = projectThinAgentChat({
      runId: "run-1",
      turnId: "user-1",
      statusPhase: "working",
      statusLabel: "Working",
      terminalOutcome: { kind: "completed" },
      chat: { messages: chatMessages },
      executingToolIds: new Set(),
    });

    const durable = durableAssistant(snapshot, chatMessages, 100);

    expect(durable).toMatchObject({
      role: "assistant",
      message_id: "assistant-final",
      content: "The plan is ready.\n\n### Sources\n\n- [Source](<https://example.com/source>)",
    });
    expect(durable.annotations).toBeUndefined();
    expect(durable.messageParts?.map((part) => part.type))
      .toEqual(["reasoning", "tool_call", "content", "content"]);
    expect(durable.tool_calls?.map((tool) => tool.id)).toEqual(["call-read"]);
    expect(snapshot.parts.at(-1)).toMatchObject({
      id: "sources:assistant-final",
      kind: "text",
      markdown: expect.stringContaining("[Source](<https://example.com/source>)"),
    });
    expect(JSON.stringify(snapshot)).not.toContain("javascript:");

    const serialized = ChatMarkdownSerializer.serializeMessages([durable]);
    const parsed = (ChatMarkdownSerializer as unknown as {
      parseSequentialFormat(content: string): { success: boolean; messages: ChatMessage[] };
    }).parseSequentialFormat(serialized);
    expect(parsed.success).toBe(true);
    expect(parsed.messages[0].content).toContain("### Sources");
    expect(parsed.messages[0].content).toContain("https://example.com/source");
  });

  it("omits only internal context setup from live and durable assistant history", () => {
    const messages: UIMessage[] = [{
      id: "user-tools",
      role: "user",
      parts: [{ type: "text", text: "Use server tools" }],
    }, {
      id: "assistant-tools",
      role: "assistant",
      parts: [
        {
          type: "tool-set_context",
          toolCallId: "call-set-context",
          state: "output-available",
          input: { content: "context-secret" },
          output: { success: true, data: { prepared: true } },
          providerExecuted: true,
        },
        {
          type: "tool-web_search",
          toolCallId: "call-web-search",
          state: "output-available",
          input: { query: "official sources" },
          output: { success: true, data: { result_count: 2 } },
          providerExecuted: true,
        },
        {
          type: "tool-future_server_tool",
          toolCallId: "call-future-tool",
          state: "output-available",
          input: { value: "keep-me" },
          output: { success: true, data: { kept: true } },
          providerExecuted: true,
        },
        { type: "text", text: "Finished.", state: "done" },
      ],
    }];
    const snapshot = projectThinAgentChat({
      runId: "run-tools",
      turnId: "user-tools",
      statusPhase: "working",
      statusLabel: "Working",
      terminalOutcome: { kind: "completed" },
      chat: { messages },
      executingToolIds: new Set(),
    });

    expect(snapshot.parts.filter((part) => part.kind === "tool")
      .map((part) => part.kind === "tool" ? part.name : ""))
      .toEqual(["web_search", "future_server_tool"]);
    expect(snapshot.messages[0]?.partIds).toEqual([
      "tool:call-web-search",
      "tool:call-future-tool",
      "text:assistant-tools:3",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("set_context");
    expect(JSON.stringify(snapshot)).not.toContain("context-secret");

    const persisted = durableAssistant(snapshot, messages, 100);
    expect(persisted.tool_calls?.map((tool) => tool.request.function.name))
      .toEqual(["web_search", "future_server_tool"]);
    expect(JSON.stringify(persisted)).not.toContain("set_context");
    expect(JSON.stringify(persisted)).not.toContain("context-secret");

    const reloaded = durableServerHistory(messages, 200);
    expect(reloaded[1].tool_calls?.map((tool) => tool.request.function.name))
      .toEqual(["web_search", "future_server_tool"]);
    expect(JSON.stringify(reloaded)).not.toContain("set_context");
    expect(JSON.stringify(reloaded)).not.toContain("context-secret");
  });

  it("uses provider execution as the server-tool authority even when names collide", () => {
    const messages: UIMessage[] = [{
      id: "user-collision",
      role: "user",
      parts: [{ type: "text", text: "Compare server and vault actions" }],
    }, {
      id: "assistant-collision",
      role: "assistant",
      parts: [{
        type: "tool-read",
        toolCallId: "call-server-read",
        state: "output-available",
        input: { paths: ["server-private-input"] },
        output: { success: true, data: { result: "server-private-output" } },
        providerExecuted: true,
      }, {
        type: "tool-write",
        toolCallId: "call-vault-write",
        state: "output-available",
        input: { path: "Plan.md", content: "Local change" },
        output: { success: true, data: { path: "Plan.md" } },
      }, {
        type: "text",
        text: "Finished.",
        state: "done",
      }],
    }];
    const snapshot = projectThinAgentChat({
      runId: "run-collision",
      turnId: "user-collision",
      statusPhase: "working",
      statusLabel: "Working",
      terminalOutcome: { kind: "completed" },
      chat: { messages },
      executingToolIds: new Set(),
    });
    const projectedTools = snapshot.parts.filter((part) => part.kind === "tool");

    expect(projectedTools.map((part) => ({
      name: part.name,
      location: part.location,
    }))).toEqual([
      { name: "read", location: "server" },
      { name: "write", location: "vault" },
    ]);

    const completed = durableAssistant(snapshot, messages, 100);
    expect(completed.tool_calls?.map((tool) => ({
      name: tool.request.function.name,
      executedOn: tool.executedOn,
    }))).toEqual([
      { name: "read", executedOn: "server" },
      { name: "write", executedOn: undefined },
    ]);

    const restored = durableServerHistory(messages, 200);
    expect(restored[1].tool_calls?.map((tool) => ({
      name: tool.request.function.name,
      executedOn: tool.executedOn,
    }))).toEqual([
      { name: "read", executedOn: "server" },
      { name: "write", executedOn: undefined },
    ]);
  });
});
