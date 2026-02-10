import { AgentSessionClient } from "../AgentSessionClient";

type RequestRecord = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: any;
  stream?: boolean;
};

describe("AgentSessionClient", () => {
  function createClient(records: RequestRecord[], options?: { sessionStatus?: number }) {
    const sessionStatus = options?.sessionStatus ?? 200;
    const request = jest.fn(async (input: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: any;
      stream?: boolean;
    }) => {
      records.push({
        url: input.url,
        method: input.method,
        headers: input.headers,
        body: input.body,
        stream: input.stream,
      });

      if (input.url.endsWith("/api/v1/agent/sessions")) {
        if (sessionStatus !== 200) {
          return {
            status: sessionStatus,
            ok: false,
            text: async () => `v2 unavailable: ${sessionStatus}`,
            headers: new Headers({ "content-type": "text/plain" }),
          } as unknown as Response;
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({ sessionId: "sess_abc123", expiresAt: "2026-02-09T06:00:00.000Z" }),
          headers: new Headers({ "content-type": "application/json" }),
        } as unknown as Response;
      }

      return {
        status: 200,
        ok: true,
        text: async () => "data: [DONE]\n\n",
        headers: new Headers({ "content-type": "text/event-stream" }),
      } as unknown as Response;
    });

    const client = new AgentSessionClient({
      baseUrl: "https://api.systemsculpt.com/api/v1",
      licenseKey: "license_abc",
      request,
    });

    return { client, request };
  }

  it("creates a session and starts a turn on first request", async () => {
    const records: RequestRecord[] = [];
    const { client } = createClient(records);

    await client.startOrContinueTurn({
      chatId: "chat_1",
      modelId: "systemsculpt/ai-agent",
      pluginVersion: "4.8.1",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hello" },
      ],
      tools: [],
    });

    expect(records).toHaveLength(2);
    expect(records[0].url).toBe("https://api.systemsculpt.com/api/v1/agent/sessions");
    expect(records[1].url).toBe("https://api.systemsculpt.com/api/v1/agent/sessions/sess_abc123/turns");
    expect(records[0].headers?.["x-plugin-version"]).toBe("4.8.1");
    expect(records[1].headers?.["x-plugin-version"]).toBe("4.8.1");
    expect(records[1].body).toMatchObject({
      modelId: "systemsculpt/ai-agent",
      context: {
        systemPrompt: "You are a helpful assistant.",
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: expect.any(Number),
          },
        ],
      },
      stream: true,
    });
  });

  it("normalizes mixed tool definitions into PI-native tools while keeping stable MCP names", async () => {
    const records: RequestRecord[] = [];
    const { client } = createClient(records);

    await client.startOrContinueTurn({
      chatId: "chat_1",
      modelId: "systemsculpt/ai-agent",
      pluginVersion: "4.8.1",
      messages: [{ role: "user", content: "read this file" }],
      tools: [
        {
          type: "function",
          function: {
            name: "functions.mcp-filesystem_read:1_provider",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        },
        {
          name: "mcp-filesystem_write",
          description: "Write a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      ],
    });

    expect(records[1].body?.context?.tools).toEqual([
      {
        name: "mcp-filesystem_read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
      {
        name: "mcp-filesystem_write",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    ]);
  });

  it("converts image_url data URLs into PI image blocks for user messages", async () => {
    const records: RequestRecord[] = [];
    const { client } = createClient(records);

    await client.startOrContinueTurn({
      chatId: "chat_vision",
      modelId: "openrouter/moonshotai/kimi-k2.5",
      pluginVersion: "4.8.1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what do you see in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh" } },
          ],
        },
      ],
      tools: [],
    });

    expect(records[1].body).toMatchObject({
      context: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what do you see in this image?" },
              { type: "image", mimeType: "image/png", data: "ZmFrZS1pbWFnZS1kYXRh" },
            ],
            timestamp: expect.any(Number),
          },
        ],
      },
    });
  });

  it("always starts PI turns directly without local tool-results continuation choreography", async () => {
    const records: RequestRecord[] = [];
    const { client } = createClient(records);

    await client.startOrContinueTurn({
      chatId: "chat_1",
      modelId: "systemsculpt/ai-agent",
      pluginVersion: "4.8.1",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await client.startOrContinueTurn({
      chatId: "chat_1",
      modelId: "systemsculpt/ai-agent",
      pluginVersion: "4.8.1",
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", name: "read", content: "{\"ok\":true}" },
      ],
      tools: [],
    });

    expect(records).toHaveLength(3);
    expect(records[0].url).toBe("https://api.systemsculpt.com/api/v1/agent/sessions");
    expect(records[1].url).toBe("https://api.systemsculpt.com/api/v1/agent/sessions/sess_abc123/turns");
    expect(records[2].url).toBe("https://api.systemsculpt.com/api/v1/agent/sessions/sess_abc123/turns");
    expect(records[2].headers?.["x-plugin-version"]).toBe("4.8.1");
  });

  it("throws when the agent sessions endpoint is unavailable and never calls legacy completions", async () => {
    const records: RequestRecord[] = [];
    const { client } = createClient(records, { sessionStatus: 405 });

    await expect(
      client.startOrContinueTurn({
        chatId: "chat_legacy",
        modelId: "systemsculpt/ai-agent",
        pluginVersion: "4.8.1",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      })
    ).rejects.toThrow("Failed to create agent session: 405");

    expect(records).toHaveLength(1);
    expect(records[0].url).toBe("https://api.systemsculpt.com/api/v1/agent/sessions");
    const legacyCalls = records.filter((record) => record.url.endsWith("/api/v1/chat/completions"));
    expect(legacyCalls).toHaveLength(0);
  });
});
