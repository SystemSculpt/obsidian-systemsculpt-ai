import { AgentSessionClient } from "../AgentSessionClient";

type RequestRecord = {
  url: string;
  method: string;
  body?: any;
};

describe("AgentSessionClient", () => {
  function createClient(records: RequestRecord[], options?: { sessionStatus?: number }) {
    const sessionStatus = options?.sessionStatus ?? 200;
    const request = jest.fn(async (input: { url: string; method: string; body?: any }) => {
      records.push({
        url: input.url,
        method: input.method,
        body: input.body,
      });

      if (input.url.endsWith("/api/v2/agent/sessions")) {
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
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(records).toHaveLength(2);
    expect(records[0].url).toBe("https://api.systemsculpt.com/api/v2/agent/sessions");
    expect(records[1].url).toBe("https://api.systemsculpt.com/api/v2/agent/sessions/sess_abc123/turns");
    expect(records[1].body).toMatchObject({
      modelId: "systemsculpt/ai-agent",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: true,
    });
  });

  it("submits pending tool results and continues the turn", async () => {
    const records: RequestRecord[] = [];
    const { client } = createClient(records);

    await client.startOrContinueTurn({
      chatId: "chat_1",
      modelId: "systemsculpt/ai-agent",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    client.markWaitingForTools("chat_1", ["call_1"]);

    await client.startOrContinueTurn({
      chatId: "chat_1",
      modelId: "systemsculpt/ai-agent",
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", name: "read", content: "{\"ok\":true}" },
      ],
      tools: [],
    });

    const urls = records.map((record) => record.url);
    expect(urls).toContain("https://api.systemsculpt.com/api/v2/agent/sessions/sess_abc123/tool-results");
    expect(urls).toContain("https://api.systemsculpt.com/api/v2/agent/sessions/sess_abc123/continue");

    const submit = records.find((record) => record.url.endsWith("/tool-results"));
    expect(submit?.body).toEqual({
      results: [{ toolCallId: "call_1", ok: true, output: { ok: true }, toolName: "read" }],
    });
  });

  it("throws when the v2 sessions endpoint is unavailable and never calls legacy completions", async () => {
    const records: RequestRecord[] = [];
    const { client } = createClient(records, { sessionStatus: 405 });

    await expect(
      client.startOrContinueTurn({
        chatId: "chat_legacy",
        modelId: "systemsculpt/ai-agent",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      })
    ).rejects.toThrow("Failed to create agent session: 405");

    expect(records).toHaveLength(1);
    expect(records[0].url).toBe("https://api.systemsculpt.com/api/v2/agent/sessions");
    const legacyCalls = records.filter((record) => record.url.endsWith("/api/v1/chat/completions"));
    expect(legacyCalls).toHaveLength(0);
  });
});
