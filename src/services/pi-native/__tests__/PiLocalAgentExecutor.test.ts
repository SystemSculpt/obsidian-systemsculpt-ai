const mockSessionInstances: MockPiSession[] = [];
let configureNextSession: ((session: MockPiSession) => void) | null = null;

class MockPiSession {
  public readonly options: any;
  public readonly prompt = jest.fn(async (message: string, promptOptions?: any) => {
    await this.promptImpl(message, promptOptions);
  });
  public readonly abort = jest.fn(async () => {});
  public readonly dispose = jest.fn(() => {});
  public readonly sessionManager = {
    getSessionName: jest.fn(() => undefined),
  };
  public readonly sessionFile = "/vault/.pi/sessions/session.jsonl";
  public readonly sessionId = "sess_pi_local";

  private readonly listeners = new Set<(event: any) => void>();
  private promptImpl: (message: string, promptOptions?: any) => Promise<void> = async () => {};

  constructor(options: any) {
    this.options = options;
    mockSessionInstances.push(this);
    configureNextSession?.(this);
    configureNextSession = null;
  }

  public subscribe(listener: (event: any) => void): () => void {
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

  public setPromptImplementation(impl: (message: string, promptOptions?: any) => Promise<void>): void {
    this.promptImpl = impl;
  }
}

jest.mock("../../pi/PiSdkRuntime", () => ({
  installPiDesktopFetchShim: jest.fn(() => () => {}),
  openPiAgentSession: jest.fn(async (options: any) => new MockPiSession(options)),
}));

import { openPiAgentSession } from "../../pi/PiSdkRuntime";
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

function latestSession(): MockPiSession {
  const session = mockSessionInstances[mockSessionInstances.length - 1];
  if (!session) {
    throw new Error("Expected a Pi SDK session instance to be created.");
  }
  return session;
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
    mockSessionInstances.splice(0, mockSessionInstances.length);
    configureNextSession = null;
  });

  it("streams assistant text from the Pi SDK session and finalizes the session metadata", async () => {
    const onSessionReady = jest.fn();
    configureNextSession = (session) => {
      session.setPromptImplementation(async (message, promptOptions) => {
        expect(message).toBe("Continue the draft.");
        expect(promptOptions).toEqual({
          expandPromptTemplates: false,
          images: undefined,
        });

        session.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Hello",
          },
        });
        session.emit({
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
        session.emit({
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
    expect(openPiAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5-mini",
      })
    );
    expect(latestSession().dispose).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing Pi session file when provided", async () => {
    configureNextSession = (session) => {
      session.setPromptImplementation(async () => {
        session.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Resumed reply" }],
            stopReason: "stop",
          },
        });
        session.emit({ type: "agent_end", messages: [] });
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

    expect(openPiAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "/vault/.pi/sessions/existing.jsonl",
      })
    );

    await expect(drain).resolves.toEqual([
      { type: "content", text: "Resumed reply" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("sends only the latest user turn while keeping the Pi system prompt configured on the session", async () => {
    configureNextSession = (session) => {
      session.setPromptImplementation(async (message) => {
        expect(message).toBe("Latest question");
        session.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Latest answer" }],
            stopReason: "stop",
          },
        });
        session.emit({ type: "agent_end", messages: [] });
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

    expect(openPiAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "/vault/.pi/sessions/existing.jsonl",
        systemPrompt: "You are SystemSculpt AI.",
      })
    );

    await expect(drain).resolves.toEqual([
      { type: "content", text: "Latest answer" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
  });

  it("aborts the underlying Pi session when the caller aborts", async () => {
    const abortController = new AbortController();
    let releasePrompt: (() => void) | null = null;
    configureNextSession = (session) => {
      session.setPromptImplementation(
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

    for (let attempt = 0; attempt < 10 && mockSessionInstances.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const session = latestSession();

    for (let attempt = 0; attempt < 10 && !releasePrompt; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(releasePrompt).not.toBeNull();

    abortController.abort();
    releasePrompt?.();
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
      },
    });
    session.emit({ type: "agent_end", messages: [] });

    await drain;
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("throws Pi's final assistant error message instead of yielding an empty completion", async () => {
    configureNextSession = (session) => {
      session.setPromptImplementation(async () => {
        session.emit({
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
    configureNextSession = (session) => {
      session.setPromptImplementation(async (message) => {
        expect(message).toBe("Summarize this.");
        session.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "  local result  ",
          },
        });
        session.emit({ type: "agent_end", messages: [] });
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
    expect(openPiAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "Keep it short.",
      })
    );
  });
});
