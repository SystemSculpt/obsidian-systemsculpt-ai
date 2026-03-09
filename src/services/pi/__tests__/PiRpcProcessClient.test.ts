import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

jest.mock("../PiProcessRuntime", () => ({
  resolvePiCommandCwd: jest.fn(() => "/vault"),
  startPiProcess: jest.fn(),
}));

jest.mock("../PiSystemSculptProvider", () => ({
  ensureSystemSculptPiProviderExtension: jest.fn(async () => "/tmp/systemsculpt-provider.mjs"),
  buildSystemSculptPiProviderEnv: jest.fn(() => ({
    SYSTEMSCULPT_PI_PROVIDER_LICENSE: "license_test",
  })),
}));

import { startPiProcess } from "../PiProcessRuntime";
import { PiRpcProcessClient } from "../PiRpcProcessClient";

type FakeChildProcess = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: {
    write: jest.Mock<boolean, [string]>;
  };
  kill: jest.Mock<boolean, [NodeJS.Signals?]>;
};

function createFakeChild(
  handlers: Record<string, (payload: any, child: FakeChildProcess) => void>
): FakeChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    write: jest.fn((line: string) => {
      const payload = JSON.parse(String(line).trim());
      const handler = handlers[String(payload.type || "")];
      if (handler) {
        handler(payload, child);
      }
      return true;
    }),
  };
  child.kill = jest.fn((signal?: NodeJS.Signals) => {
    setImmediate(() => {
      child.emit("close", 0, signal || null);
    });
    return true;
  });
  return child;
}

function writeJsonLine(stream: PassThrough, payload: unknown): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

describe("PiRpcProcessClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("syncs the requested model and thinking level after startup", async () => {
    const child = createFakeChild({
      get_state: (payload, proc) => {
        writeJsonLine(proc.stdout, {
          id: payload.id,
          type: "response",
          command: "get_state",
          success: true,
          data: {
            sessionId: "sess_1",
            sessionFile: "/vault/.pi/sessions/session.jsonl",
            thinkingLevel: "low",
            model: {
              provider: "anthropic",
              id: "claude-sonnet-4-20250514",
            },
          },
        });
      },
      set_model: (payload, proc) => {
        writeJsonLine(proc.stdout, {
          id: payload.id,
          type: "response",
          command: "set_model",
          success: true,
          data: {
            provider: payload.provider,
            id: payload.modelId,
          },
        });
      },
      set_thinking_level: (payload, proc) => {
        writeJsonLine(proc.stdout, {
          id: payload.id,
          type: "response",
          command: "set_thinking_level",
          success: true,
        });
      },
    });

    (startPiProcess as jest.Mock).mockResolvedValue({
      child,
      runtime: {
        command: "pi",
        argsPrefix: [],
        source: "global-cli",
        label: "pi",
      },
    });

    const client = new PiRpcProcessClient({
      plugin: {} as any,
      sessionFile: "/vault/.pi/sessions/session.jsonl",
      modelId: "openai/gpt-5.3-codex-spark",
      thinkingLevel: "high",
    });

    await client.start();

    expect(startPiProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["--extension", "/tmp/systemsculpt-provider.mjs"]),
        env: expect.objectContaining({
          SYSTEMSCULPT_PI_PROVIDER_LICENSE: "license_test",
        }),
      })
    );

    const commands = child.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
    expect(commands.map((entry) => entry.type)).toEqual([
      "get_state",
      "set_model",
      "set_thinking_level",
    ]);
    expect(commands[1]).toEqual(
      expect.objectContaining({
        type: "set_model",
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
      })
    );
    expect(commands[2]).toEqual(
      expect.objectContaining({
        type: "set_thinking_level",
        level: "high",
      })
    );

    await client.stop();
  });

  it("passes a configured system prompt through to Pi RPC startup", async () => {
    const child = createFakeChild({
      get_state: (payload, proc) => {
        writeJsonLine(proc.stdout, {
          id: payload.id,
          type: "response",
          command: "get_state",
          success: true,
          data: {
            sessionId: "sess_prompt",
            sessionFile: "/vault/.pi/sessions/session.jsonl",
            thinkingLevel: "medium",
            model: {
              provider: "openai",
              id: "gpt-5.3-codex-spark",
            },
          },
        });
      },
    });

    (startPiProcess as jest.Mock).mockResolvedValue({
      child,
      runtime: {
        command: "pi",
        argsPrefix: [],
        source: "global-cli",
        label: "pi",
      },
    });

    const client = new PiRpcProcessClient({
      plugin: {} as any,
      systemPrompt: "You are SystemSculpt AI.",
      modelId: "openai/gpt-5.3-codex-spark",
    });

    await client.start();

    expect(startPiProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["--system-prompt", "You are SystemSculpt AI."]),
      })
    );

    await client.stop();
  });

  it("emits agent events and auto-cancels unsupported extension dialogs", async () => {
    const child = createFakeChild({
      get_state: (payload, proc) => {
        writeJsonLine(proc.stdout, {
          id: payload.id,
          type: "response",
          command: "get_state",
          success: true,
          data: {
            sessionId: "sess_2",
            thinkingLevel: "medium",
            model: {
              provider: "openai",
              id: "gpt-5.3-codex-spark",
            },
          },
        });
      },
      prompt: (payload, proc) => {
        writeJsonLine(proc.stdout, {
          id: payload.id,
          type: "response",
          command: "prompt",
          success: true,
        });
        writeJsonLine(proc.stdout, {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Hello",
          },
        });
        writeJsonLine(proc.stdout, {
          type: "extension_ui_request",
          id: "ui-1",
          method: "confirm",
          title: "Dangerous action",
        });
      },
    });

    (startPiProcess as jest.Mock).mockResolvedValue({
      child,
      runtime: {
        command: "pi",
        argsPrefix: [],
        source: "global-cli",
        label: "pi",
      },
    });

    const client = new PiRpcProcessClient({
      plugin: {} as any,
      modelId: "openai/gpt-5.3-codex-spark",
    });
    const events: any[] = [];
    await client.start();
    client.onEvent((event) => {
      events.push(event);
    });

    await client.prompt("Hello");

    expect(events).toEqual([
      expect.objectContaining({
        type: "message_update",
      }),
      expect.objectContaining({
        type: "extension_ui_request",
        method: "confirm",
      }),
    ]);

    const commands = child.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "extension_ui_response",
        id: "ui-1",
        cancelled: true,
      })
    );

    await client.stop();
  });
});
