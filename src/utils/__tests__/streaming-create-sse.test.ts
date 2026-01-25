/**
 * @jest-environment node
 */

import { createSSEStreamFromChatCompletionJSON } from "../streaming";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("createSSEStreamFromChatCompletionJSON", () => {
  test("emits tool_calls from SystemSculpt JSON responses even when text is empty", async () => {
    const responseData = {
      id: "systemsculpt-test",
      model: "systemsculpt/ai-agent",
      text: "",
      tool_calls: [
        {
          id: "functions.mcp-filesystem_read:0",
          type: "function",
          function: {
            name: "mcp-filesystem_read",
            arguments: "{\"paths\":[\"E2E/alpha.md\"]}",
          },
        },
        {
          id: "functions.mcp-filesystem_read:1",
          type: "function",
          function: {
            name: "mcp-filesystem_read",
            arguments: "{\"paths\":[\"E2E/beta.md\"]}",
          },
        },
      ],
    };

    const stream = createSSEStreamFromChatCompletionJSON(responseData, {
      chunkSize: 2048,
      chunkDelayMs: 0,
    });

    const sse = await readAll(stream);
    const payloads = sse
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice("data: ".length)));

    const toolChunk = payloads.find((p) => Array.isArray(p?.choices?.[0]?.delta?.tool_calls));
    expect(toolChunk).toBeTruthy();

    const toolCalls = toolChunk.choices[0].delta.tool_calls;
    expect(toolCalls).toHaveLength(2);

    expect(toolCalls[0]).toMatchObject({
      id: "functions.mcp-filesystem_read:0",
      type: "function",
      index: 0,
      function: { name: "mcp-filesystem_read" },
    });
    expect(toolCalls[1]).toMatchObject({
      id: "functions.mcp-filesystem_read:1",
      type: "function",
      index: 1,
      function: { name: "mcp-filesystem_read" },
    });
  });

  test("emits function_call when present in OpenAI-style JSON responses", async () => {
    const responseData = {
      id: "minimax-test",
      model: "MiniMax-M2.1",
      choices: [
        {
          message: {
            content: "",
            function_call: {
              name: "mcp-filesystem_write",
              arguments: "{\"path\":\"Docs/Note.md\",\"content\":\"Updated\"}",
            },
          },
        },
      ],
    };

    const stream = createSSEStreamFromChatCompletionJSON(responseData, {
      chunkSize: 2048,
      chunkDelayMs: 0,
    });

    const sse = await readAll(stream);
    const payloads = sse
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice("data: ".length)));

    const functionChunk = payloads.find((p) => p?.choices?.[0]?.delta?.function_call);
    expect(functionChunk).toBeTruthy();
    expect(functionChunk.choices[0].delta.function_call).toMatchObject({
      name: "mcp-filesystem_write",
      arguments: "{\"path\":\"Docs/Note.md\",\"content\":\"Updated\"}",
    });
  });
});
