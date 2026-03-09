const mockClientInstances: MockPiRpcProcessClient[] = [];
let configureNextClient: ((client: MockPiRpcProcessClient) => void) | null = null;

class MockPiRpcProcessClient {
  public readonly options: any;
  public readonly prompt = jest.fn(async (message: string, images?: any[]) => {
    await this.promptImpl(message, images);
  });
  public readonly abort = jest.fn(async () => {});
  public readonly stop = jest.fn(async () => {});
  public readonly start = jest.fn(async () => {});
  public readonly getState = jest.fn(async () => ({
    sessionId: "sess_pi_local",
    sessionFile: "/vault/.pi/sessions/session.jsonl",
    thinkingLevel: "medium",
    model: {
      provider: "openai",
      id: "gpt-5-mini",
    },
  }));

  private readonly listeners = new Set<(event: any) => void>();
  private promptImpl: (message: string, images?: any[]) => Promise<void> = async () => {};

  constructor(options: any) {
    this.options = options;
    mockClientInstances.push(this);
    configureNextClient?.(this);
    configureNextClient = null;
  }

  public onEvent(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(event: any): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public setPromptImplementation(impl: (message: string, images?: any[]) => Promise<void>): void {
    this.promptImpl = impl;
  }
}

jest.mock("../../pi/PiRpcProcessClient", () => ({
  PiRpcProcessClient: jest.fn((options: any) => new MockPiRpcProcessClient(options)),
}));

import {
  runPiLocalTextGeneration,
  streamPiLocalAgentTurn,
} from "../PiLocalAgentExecutor";

function createPlugin() {
  return {
    app: {
      vault: {
        adapter: {
          getBasePath: jest.fn(() => "/vault"),
        },
      },
    },
  } as any;
}

function latestClient(): MockPiRpcProcessClient {
  const client = mockClientInstances[mockClientInstances.length - 1];
  if (!client) {
    throw new Error("Expected a Pi RPC client instance to be created.");
  }
  return client;
}

async function collectEvents(generator: AsyncGenerator<any, void, unknown>) {
  const events: any[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("PiLocalAgentExecutor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientInstances.splice(0, mockClientInstances.length);
    configureNextClient = null;
  });

  it("streams assistant text from Pi RPC and finalizes the session metadata", async () => {
    const onSessionReady = jest.fn();
    configureNextClient = (client) => {
      client.setPromptImplementation(async (message, images) => {
        expect(message).toBe("Continue the draft.");
        expect(images).toBeUndefined();

        client.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Hello",
          },
        });
        client.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello world" },
              { type: "thinking", thinking: "Reasoned." },
            ],
            stopReason: "stop",
          },
        });
        client.emit({
          type: "agent_end",
          messages: [],
        });
      });
    };

    const drain = collectEvents(
      streamPiLocalAgentTurn({
        plugin: createPlugin(),
        modelId: "openai/gpt-5-mini",
        onSessionReady,
        messages: [
          { role: "user", content: "Continue the draft.", message_id: "user_2" } as any,
        ],
      })
    );

    await expect(drain).resolves.toEqual([
      { type: "content", text: "Hello" },
      { type: "content", text: " world" },
      { type: "reasoning", text: "Reasoned." },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
    expect(onSessionReady).toHaveBeenCalledWith({
      sessionFile: "/vault/.pi/sessions/session.jsonl",
      sessionId: "sess_pi_local",
    });
    expect(latestClient().start).toHaveBeenCalledTimes(1);
    expect(latestClient().stop).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing Pi session file when provided", async () => {
    configureNextClient = (client) => {
      client.setPromptImplementation(async () => {
        client.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Resumed reply" }],
            stopReason: "stop",
          },
        });
        client.emit({ type: "agent_end", messages: [] });
      });
    };

    const drain = collectEvents(
      streamPiLocalAgentTurn({
        plugin: createPlugin(),
        modelId: "openai/gpt-5-mini",
        sessionFile: "/vault/.pi/sessions/existing.jsonl",
        messages: [{ role: "user", content: "Resume this chat.", message_id: "resume_1" } as any],
      })
    );

    const client = latestClient();
    expect(client.options.sessionFile).toBe("/vault/.pi/sessions/existing.jsonl");

    await expect(drain).resolves.toEqual([
      { type: "content", text: "Resumed reply" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("sends only the latest user turn while keeping the Pi system prompt configured on the session", async () => {
    configureNextClient = (client) => {
      client.setPromptImplementation(async (message) => {
        expect(message).toBe("Latest question");
        client.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Latest answer" }],
            stopReason: "stop",
          },
        });
        client.emit({ type: "agent_end", messages: [] });
      });
    };

    const drain = collectEvents(
      streamPiLocalAgentTurn({
        plugin: createPlugin(),
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are SystemSculpt AI.",
        sessionFile: "/vault/.pi/sessions/existing.jsonl",
        messages: [
          { role: "system", content: "You are SystemSculpt AI.", message_id: "sys_1" } as any,
          { role: "user", content: "First question", message_id: "user_1" } as any,
          { role: "assistant", content: "First answer", message_id: "assistant_1" } as any,
          { role: "user", content: "Latest question", message_id: "user_2" } as any,
        ],
      })
    );

    const client = latestClient();
    expect(client.options.sessionFile).toBe("/vault/.pi/sessions/existing.jsonl");
    expect(client.options.systemPrompt).toBe("You are SystemSculpt AI.");

    await expect(drain).resolves.toEqual([
      { type: "content", text: "Latest answer" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("aborts the underlying Pi RPC turn when the caller aborts", async () => {
    const abortController = new AbortController();
    let releasePrompt: (() => void) | null = null;
    configureNextClient = (client) => {
      client.setPromptImplementation(
        () =>
          new Promise<void>((resolve) => {
            releasePrompt = resolve;
          })
      );
    };

    const drain = collectEvents(
      streamPiLocalAgentTurn({
        plugin: createPlugin(),
        modelId: "openai/gpt-5-mini",
        signal: abortController.signal,
        messages: [{ role: "user", content: "Abort me", message_id: "abort_1" } as any],
      })
    );

    const client = latestClient();

    for (let attempt = 0; attempt < 10 && !releasePrompt; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(releasePrompt).not.toBeNull();

    abortController.abort();
    releasePrompt?.();
    client.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
      },
    });
    client.emit({ type: "agent_end", messages: [] });

    await drain;
    expect(client.abort).toHaveBeenCalledTimes(1);
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("throws Pi's final assistant error message instead of yielding an empty completion", async () => {
    configureNextClient = (client) => {
      client.setPromptImplementation(async () => {
        client.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "401 Unauthorized",
          },
        });
      });
    };

    const drain = collectEvents(
      streamPiLocalAgentTurn({
        plugin: createPlugin(),
        modelId: "openai/gpt-5-mini",
        messages: [{ role: "user", content: "Hello", message_id: "user_err" } as any],
      })
    );

    await expect(drain).rejects.toThrow("401 Unauthorized");
  });

  it("returns trimmed text for direct local Pi text generation", async () => {
    configureNextClient = (client) => {
      client.setPromptImplementation(async (message) => {
        expect(message).toBe("Summarize this.");
        client.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "  local result  ",
          },
        });
        client.emit({ type: "agent_end", messages: [] });
      });
    };

    const generation = runPiLocalTextGeneration({
      plugin: createPlugin(),
      modelId: "openai/gpt-5-mini",
      prompt: "Summarize this.",
      systemPrompt: "Keep it short.",
    });

    await expect(generation).resolves.toEqual({
      text: "local result",
      modelId: "openai/gpt-5-mini",
    });
    expect(latestClient().options.systemPrompt).toBe("Keep it short.");
  });
});
