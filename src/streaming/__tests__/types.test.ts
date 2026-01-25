/**
 * @jest-environment node
 */
import type {
  StreamToolCall,
  StreamEvent,
  StreamPipelineOptions,
  StreamPipelineResult,
} from "../types";

describe("StreamToolCall type", () => {
  it("can create a basic stream tool call", () => {
    const call: StreamToolCall = {
      id: "call_123",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"location": "NYC"}',
      },
    };

    expect(call.id).toBe("call_123");
    expect(call.function.name).toBe("get_weather");
  });

  it("can have optional index", () => {
    const call: StreamToolCall = {
      id: "call_456",
      type: "function",
      function: {
        name: "search",
        arguments: "{}",
      },
      index: 0,
    };

    expect(call.index).toBe(0);
  });

  it("index is optional", () => {
    const call: StreamToolCall = {
      id: "call_789",
      type: "function",
      function: {
        name: "test",
        arguments: "{}",
      },
    };

    expect(call.index).toBeUndefined();
  });
});

describe("StreamEvent type", () => {
  describe("content event", () => {
    it("can create content event", () => {
      const event: StreamEvent = {
        type: "content",
        text: "Hello world",
      };

      expect(event.type).toBe("content");
      if (event.type === "content") {
        expect(event.text).toBe("Hello world");
      }
    });
  });

  describe("reasoning event", () => {
    it("can create reasoning event", () => {
      const event: StreamEvent = {
        type: "reasoning",
        text: "Let me think about this...",
      };

      expect(event.type).toBe("reasoning");
      if (event.type === "reasoning") {
        expect(event.text).toBe("Let me think about this...");
      }
    });
  });

  describe("tool-call event", () => {
    it("can create delta phase tool-call event", () => {
      const event: StreamEvent = {
        type: "tool-call",
        phase: "delta",
        call: {
          id: "call_1",
          type: "function",
          function: { name: "test", arguments: '{"partial":' },
        },
      };

      expect(event.type).toBe("tool-call");
      if (event.type === "tool-call") {
        expect(event.phase).toBe("delta");
        expect(event.call.function.name).toBe("test");
      }
    });

    it("can create final phase tool-call event", () => {
      const event: StreamEvent = {
        type: "tool-call",
        phase: "final",
        call: {
          id: "call_1",
          type: "function",
          function: { name: "test", arguments: '{"complete": true}' },
        },
      };

      if (event.type === "tool-call") {
        expect(event.phase).toBe("final");
      }
    });
  });

  describe("meta event", () => {
    it("can create web-search-enabled meta event", () => {
      const event: StreamEvent = {
        type: "meta",
        key: "web-search-enabled",
        value: true,
      };

      expect(event.type).toBe("meta");
      if (event.type === "meta") {
        expect(event.key).toBe("web-search-enabled");
        expect(event.value).toBe(true);
      }
    });

    it("can create inline-footnote meta event", () => {
      const event: StreamEvent = {
        type: "meta",
        key: "inline-footnote",
        value: { ref: 1, text: "Source" },
      };

      if (event.type === "meta") {
        expect(event.key).toBe("inline-footnote");
        expect(event.value.ref).toBe(1);
      }
    });
  });

  describe("footnote event", () => {
    it("can create footnote event", () => {
      const event: StreamEvent = {
        type: "footnote",
        text: "[1] Reference source",
      };

      expect(event.type).toBe("footnote");
      if (event.type === "footnote") {
        expect(event.text).toBe("[1] Reference source");
      }
    });
  });

  describe("annotations event", () => {
    it("can create annotations event", () => {
      const event: StreamEvent = {
        type: "annotations",
        annotations: [
          { type: "file_citation", start_index: 0, end_index: 10, file_citation: { file_id: "f1", quote: "Quote" } },
        ],
      };

      expect(event.type).toBe("annotations");
      if (event.type === "annotations") {
        expect(event.annotations.length).toBe(1);
      }
    });

    it("can have empty annotations array", () => {
      const event: StreamEvent = {
        type: "annotations",
        annotations: [],
      };

      if (event.type === "annotations") {
        expect(event.annotations.length).toBe(0);
      }
    });
  });
});

describe("StreamPipelineOptions type", () => {
  it("can create with required model", () => {
    const options: StreamPipelineOptions = {
      model: "gpt-4",
    };

    expect(options.model).toBe("gpt-4");
    expect(options.isCustomProvider).toBeUndefined();
  });

  it("can create with optional isCustomProvider", () => {
    const options: StreamPipelineOptions = {
      model: "local-model",
      isCustomProvider: true,
    };

    expect(options.isCustomProvider).toBe(true);
  });

  it("can set isCustomProvider to false", () => {
    const options: StreamPipelineOptions = {
      model: "gpt-3.5-turbo",
      isCustomProvider: false,
    };

    expect(options.isCustomProvider).toBe(false);
  });
});

describe("StreamPipelineResult type", () => {
  it("can create result with events", () => {
    const result: StreamPipelineResult = {
      events: [
        { type: "content", text: "Hello" },
        { type: "content", text: " World" },
      ],
      done: false,
    };

    expect(result.events.length).toBe(2);
    expect(result.done).toBe(false);
  });

  it("can create completed result", () => {
    const result: StreamPipelineResult = {
      events: [{ type: "content", text: "Complete message" }],
      done: true,
    };

    expect(result.done).toBe(true);
  });

  it("can create result with empty events", () => {
    const result: StreamPipelineResult = {
      events: [],
      done: true,
    };

    expect(result.events.length).toBe(0);
  });

  it("can create result with mixed event types", () => {
    const result: StreamPipelineResult = {
      events: [
        { type: "reasoning", text: "Thinking..." },
        { type: "content", text: "Answer" },
        { type: "footnote", text: "[1] Source" },
      ],
      done: true,
    };

    expect(result.events.length).toBe(3);
    expect(result.events[0].type).toBe("reasoning");
    expect(result.events[1].type).toBe("content");
    expect(result.events[2].type).toBe("footnote");
  });
});
