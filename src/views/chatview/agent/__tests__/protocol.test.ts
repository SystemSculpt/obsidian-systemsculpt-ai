import {
  AgentProtocolError,
  parseAgentCommand,
  parseAgentServerEvent,
} from "../Protocol";

const CONVERSATION_ID = `conversation_${"a".repeat(32)}`;

function event(kind: string, fields: Record<string, unknown>) {
  return {
    type: "systemsculpt.agent.event.v1",
    version: 1,
    kind,
    conversation_id: CONVERSATION_ID,
    ...fields,
  };
}

function sessionSnapshot(messages: readonly unknown[]) {
  return event("session_snapshot", {
    messages,
    run_state: { version: 1, cursor: 0, state: "idle" },
  });
}

function userFileMessage(mediaType: string, url: string) {
  return {
    id: "user_image",
    role: "user",
    parts: [{ type: "file", mediaType, url, filename: "image.bin" }],
  };
}

describe("thin-agent protocol parsing", () => {
  it.each(["image/png", "image/jpeg", "image/webp"])(
    "accepts a matching authoritative %s data image URL",
    (mediaType) => {
      const url = `data:${mediaType};base64,AQID`;

      const parsed = parseAgentServerEvent(
        sessionSnapshot([userFileMessage(mediaType, url)]),
        CONVERSATION_ID,
      );

      expect(parsed).toMatchObject({
        kind: "session_snapshot",
        messages: [{
          id: "user_image",
          role: "user",
          parts: [{ type: "file", mediaType, url }],
        }],
      });
    },
  );

  it.each([
    ["text/plain", "data:text/plain;base64,SGVsbG8="],
    ["text/markdown", "data:text/markdown;base64,IyBFeHRyYWN0ZWQ="],
  ])("accepts a bounded authoritative %s UTF-8 data URL", (mediaType, url) => {
    const parsed = parseAgentServerEvent(
      sessionSnapshot([userFileMessage(mediaType, url)]),
      CONVERSATION_ID,
    );

    expect(parsed).toMatchObject({
      kind: "session_snapshot",
      messages: [{
        id: "user_image",
        parts: [{ type: "file", mediaType, url }],
      }],
    });
  });

  it.each([
    ["remote URL", "image/png", "https://example.com/image.png"],
    ["blob URL", "image/png", "blob:https://example.com/image"],
    ["file URL", "image/png", "file:///tmp/image.png"],
    ["SVG data URL", "image/svg+xml", "data:image/svg+xml;base64,PHN2Zz4="],
    ["malformed base64", "image/png", "data:image/png;base64,not_base64"],
    ["empty image", "image/png", "data:image/png;base64,"],
    ["MIME mismatch", "image/png", "data:image/jpeg;base64,AQID"],
  ])("rejects an authoritative user file with a %s", (_case, mediaType, url) => {
    expect(() => parseAgentServerEvent(
      sessionSnapshot([userFileMessage(mediaType, url)]),
      CONVERSATION_ID,
    )).toThrow(expect.objectContaining({
      name: "AgentProtocolError",
      code: "invalid_server_event",
    } satisfies Partial<AgentProtocolError>));
  });

  it("bounds primitive JSON nodes in one authoritative message part", () => {
    const payload = Array.from(
      { length: 49 },
      () => Array.from({ length: 2_048 }, () => null),
    );

    expect(() => parseAgentServerEvent(sessionSnapshot([{
      id: "assistant_too_complex",
      role: "assistant",
      parts: [{ type: "data", payload }],
    }]), CONVERSATION_ID)).toThrow(expect.objectContaining({
      name: "AgentProtocolError",
      code: "invalid_server_event",
    } satisfies Partial<AgentProtocolError>));
  });

  it("keeps assistant source URLs as additive authoritative parts", () => {
    const source = {
      type: "source-url",
      url: "https://example.com/research",
      title: "Primary research",
    };

    const parsed = parseAgentServerEvent(sessionSnapshot([{
      id: "assistant_sources",
      role: "assistant",
      parts: [source],
    }]), CONVERSATION_ID);

    expect(parsed).toMatchObject({
      kind: "session_snapshot",
      messages: [{
        id: "assistant_sources",
        role: "assistant",
        parts: [source],
      }],
    });
  });

  it("rejects malformed snapshot messages before reading run state", () => {
    let runStateRead = false;
    const snapshot = {
      ...event("session_snapshot", {
        messages: [userFileMessage(
          "image/png",
          "https://example.com/not-authoritative.png",
        )],
      }),
      get run_state() {
        runStateRead = true;
        return { version: 1, cursor: 0, state: "idle" };
      },
    };

    expect(() => parseAgentServerEvent(snapshot, CONVERSATION_ID))
      .toThrow(AgentProtocolError);
    expect(runStateRead).toBe(false);
  });

  it("preserves JSON keys without allowing prototype mutation", () => {
    const output = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"safe"}',
    ) as Record<string, unknown>;
    const parsed = parseAgentCommand({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "client_tool_result",
      request_id: "tool_result_request",
      tool_call_id: "tool_call",
      tool_name: "write_note",
      state: "output-available",
      output,
    });
    const parsedOutput = "output" in parsed
      ? parsed.output as Record<string, unknown>
      : null;

    expect(parsedOutput).not.toBeNull();
    expect(Object.getPrototypeOf(parsedOutput)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(parsedOutput, "__proto__"))
      .toBe(true);
    expect((parsedOutput as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("requires one identity for a submitted request and user message", () => {
    const command = {
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "submit",
      request_id: "user_submit",
      user_message: {
        id: "different_user",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
    };

    expect(() => parseAgentCommand(command)).toThrow(expect.objectContaining({
      name: "AgentProtocolError",
      code: "invalid_command",
    } satisfies Partial<AgentProtocolError>));
  });

  it("requires one identity for a queued submit", () => {
    const snapshot = event("queue_snapshot", {
      queue: {
        version: 1,
        cursor: 1,
        items: [{
          kind: "submit",
          request_id: "user_queued",
          user_message: {
            id: "different_user",
            role: "user",
            parts: [{ type: "text", text: "Queued" }],
          },
        }],
      },
    });

    expect(() => parseAgentServerEvent(snapshot, CONVERSATION_ID))
      .toThrow(expect.objectContaining({
        name: "AgentProtocolError",
        code: "invalid_server_event",
      } satisfies Partial<AgentProtocolError>));
  });

  it("rejects unsafe authoritative files in queued submits", () => {
    const snapshot = event("queue_snapshot", {
      queue: {
        version: 1,
        cursor: 1,
        items: [{
          kind: "submit",
          request_id: "user_queued_image",
          user_message: {
            id: "user_queued_image",
            role: "user",
            parts: [{
              type: "file",
              mediaType: "image/png",
              url: "blob:https://example.com/untrusted",
            }],
          },
        }],
      },
    });

    expect(() => parseAgentServerEvent(snapshot, CONVERSATION_ID))
      .toThrow(expect.objectContaining({
        name: "AgentProtocolError",
        code: "invalid_server_event",
      } satisfies Partial<AgentProtocolError>));
  });

  it("restores a bounded UTF-8 text file from a queue snapshot", () => {
    const textFile = {
      type: "file",
      mediaType: "text/markdown",
      url: "data:text/markdown;base64,IyBFeHRyYWN0ZWQ=",
      filename: "document.extracted.md",
    };
    const parsed = parseAgentServerEvent(event("queue_snapshot", {
      queue: {
        version: 1,
        cursor: 1,
        items: [{
          kind: "submit",
          request_id: "user_queued_document",
          user_message: {
            id: "user_queued_document",
            role: "user",
            parts: [textFile],
          },
        }],
      },
    }), CONVERSATION_ID);

    expect(parsed).toMatchObject({
      kind: "queue_snapshot",
      queue: { items: [{ user_message: { parts: [textFile] } }] },
    });
  });

  it("keeps submitted UTF-8 text files supported on the client command path", () => {
    const parsed = parseAgentCommand({
      type: "systemsculpt.agent.command.v1",
      version: 1,
      kind: "submit",
      request_id: "user_document",
      user_message: {
        id: "user_document",
        role: "user",
        parts: [{
          type: "file",
          mediaType: "text/plain",
          url: "data:text/plain;base64,SGVsbG8=",
          filename: "notes.txt",
        }],
      },
    });

    expect(parsed).toMatchObject({
      kind: "submit",
      request_id: "user_document",
      user_message: { id: "user_document" },
    });
  });
});
