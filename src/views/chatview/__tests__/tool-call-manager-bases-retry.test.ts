import { ToolCallManager } from "../ToolCallManager";
import type { ToolCallRequest } from "../../../types/toolCalls";

const flush = async (): Promise<void> =>
  await new Promise((resolve) => setImmediate(resolve));

const waitForTerminal = async (toolCall: { state: string }): Promise<void> => {
  for (let i = 0; i < 40; i++) {
    if (toolCall.state === "completed" || toolCall.state === "failed") {
      return;
    }
    await flush();
  }
};

const createManager = (): ToolCallManager => {
  const chatView = {
    plugin: { settings: {} },
  };
  return new ToolCallManager({} as any, chatView as any);
};

const createRequest = (id: string, args: Record<string, unknown>): ToolCallRequest => ({
  id,
  type: "function",
  function: {
    name: "write_file",
    arguments: JSON.stringify(args),
  },
});

describe("ToolCallManager BASE_YAML_INVALID handling under PI orchestration", () => {
  it("keeps BASE_YAML_INVALID errors unchanged across repeated attempts", async () => {
    const manager = createManager();
    manager.registerTool(
      {
        name: "write_file",
        description: "Write",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      async () => {
        const error = new Error("Invalid YAML");
        (error as any).code = "BASE_YAML_INVALID";
        throw error;
      }
    );

    const first = manager.createToolCall(
      createRequest("call-base-1", { path: "Views/Projects.base", content: "a" }),
      "msg-base"
    );
    await waitForTerminal(first);

    const second = manager.createToolCall(
      createRequest("call-base-2", { path: "Views/Projects.base", content: "b" }),
      "msg-base"
    );
    await waitForTerminal(second);

    expect(first.state).toBe("failed");
    expect(second.state).toBe("failed");
    expect(first.result?.error?.code).toBe("BASE_YAML_INVALID");
    expect(second.result?.error?.code).toBe("BASE_YAML_INVALID");
    expect(first.result?.error?.message).toBe("Invalid YAML");
    expect(second.result?.error?.message).toBe("Invalid YAML");
    expect(first.result?.error?.message).not.toContain("attempt");
    expect(second.result?.error?.message).not.toContain("attempt");
  });

  it("allows a subsequent success after a BASE_YAML_INVALID failure on the same path", async () => {
    const manager = createManager();
    const executor = jest
      .fn()
      .mockImplementationOnce(async () => {
        const error = new Error("Invalid YAML");
        (error as any).code = "BASE_YAML_INVALID";
        throw error;
      })
      .mockImplementationOnce(async () => ({ ok: true }));

    manager.registerTool(
      {
        name: "write_file",
        description: "Write",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      executor
    );

    const failed = manager.createToolCall(
      createRequest("call-base-failed", { path: "Views/Projects.base", content: "bad" }),
      "msg-base"
    );
    await waitForTerminal(failed);

    const succeeded = manager.createToolCall(
      createRequest("call-base-success", { path: "Views/Projects.base", content: "good" }),
      "msg-base"
    );
    await waitForTerminal(succeeded);

    expect(failed.state).toBe("failed");
    expect(failed.result?.error?.code).toBe("BASE_YAML_INVALID");
    expect(succeeded.state).toBe("completed");
    expect(succeeded.result?.success).toBe(true);
    expect(executor).toHaveBeenCalledTimes(2);
  });
});
