import { executeLocalPiStream } from "../LocalPiStreamExecutor";
import { streamPiLocalAgentTurn } from "../pi-native/PiLocalAgentExecutor";

jest.mock("../pi-native/PiLocalAgentExecutor", () => ({
  streamPiLocalAgentTurn: jest.fn(),
}));

async function collectEvents(generator: AsyncGenerator<any, void, unknown>) {
  const events: any[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("LocalPiStreamExecutor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes through Pi stream events without adding a transport footnote", async () => {
    const streamed = [
      { type: "content", text: "Hello" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ];
    const debug = {
      onRequest: jest.fn(),
      onStreamEvent: jest.fn(),
    };

    (streamPiLocalAgentTurn as jest.Mock).mockImplementation(async function* () {
      for (const event of streamed) {
        yield event;
      }
    });

    const events = await collectEvents(
      executeLocalPiStream({
        plugin: {} as any,
        prepared: {
          actualModelId: "openai/gpt-4o",
          preparedMessages: [{ role: "user", content: "Hello", message_id: "msg_1" } as any],
          resolvedModel: {
            provider: "local-pi-openai",
            sourceProviderId: "openai",
          } as any,
        } as any,
        debug,
      })
    );

    expect(events).toEqual(streamed);
    expect(events.some((event) => event.type === "meta" && event.key === "inline-footnote")).toBe(false);
    expect(debug.onRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local-pi:openai",
        endpoint: "local-pi-rpc",
        transport: "pi-rpc",
      })
    );
    expect(debug.onStreamEvent).toHaveBeenCalledTimes(streamed.length);
  });
});
