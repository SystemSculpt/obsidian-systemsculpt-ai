/**
 * @jest-environment jsdom
 */
import { ChatMarkdownSerializer } from "../ChatMarkdownSerializer";
import {
  hasChatIdentityFrontmatter,
  hasChatIdentityMetadata,
} from "../ChatFrontmatterIdentity";
import { ChatMessage, MessagePart, ToolCall } from "../../../../types";
import { parseYaml } from "obsidian";

// Mock obsidian's parseYaml
jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  parseYaml: jest.fn((content: string) => {
    // Simple YAML parser for tests
    const result: Record<string, any> = {};
    const lines = content.split("\n");
    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        if ((value.startsWith("[") && !value.startsWith("[[")) || value.startsWith("{")) {
          // JSON-backed arrays and objects emitted by the focused test helper.
          result[key] = JSON.parse(value.replace(/'/g, '"'));
        } else if (value === "null" || value === "") {
          result[key] = null;
        } else if (value === "true" || value === "false") {
          result[key] = value === "true";
        } else if (!isNaN(Number(value))) {
          result[key] = Number(value);
        } else {
          result[key] = value.replace(/^["']|["']$/g, "");
        }
      }
    }
    return result;
  }),
}));

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("expected a value");
  return value;
}

describe("ChatMarkdownSerializer", () => {
  it.each(['auto', 'ask', 'full-access', 'future'])('parses persisted %s mode conservatively', mode => {
    const markdown = `---\nid: mode-test\ntitle: Modes\ncreated: 2026-10-23T00:00:00.000Z\nlastModified: 2026-10-23T00:00:00.000Z\napprovalMode: ${mode}\n---\n\n`;
    expect(ChatMarkdownSerializer.parseMarkdown(markdown)?.metadata.approvalMode).toBe(mode === 'future' ? 'ask' : mode);
  });
  describe("serializeMessages", () => {
    it("serializes simple user message", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello!", message_id: "user-1" },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain('role="user"');
      expect(result).toContain('message-id="user-1"');
      expect(result).toContain("Hello!");
      expect(result).toContain("<!-- SYSTEMSCULPT-MESSAGE-START");
      expect(result).toContain("<!-- SYSTEMSCULPT-MESSAGE-END -->");
    });

    it("serializes assistant message", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "Hi there!", message_id: "asst-1" },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain('role="assistant"');
      expect(result).toContain("Hi there!");
    });

    it("rejects standalone tool role messages", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use tool", message_id: "user-1" },
        { role: "tool", content: "Tool result", message_id: "tool-1" } as ChatMessage,
        { role: "assistant", content: "Done", message_id: "asst-1" },
      ];

      expect(() => ChatMarkdownSerializer.serializeMessages(messages))
        .toThrow("Managed chat persistence does not support tool messages.");
    });

    it("serializes message with messageParts content", () => {
      const parts: MessagePart[] = [
        { id: "p1", type: "content", data: "Part one", timestamp: 1 },
        { id: "p2", type: "content", data: " Part two", timestamp: 2 },
      ];
      const messages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("Part one");
      expect(result).toContain("Part two");
    });

    it("serializes message with reasoning part", () => {
      const parts: MessagePart[] = [
        { id: "r1", type: "reasoning", data: "Let me think...", timestamp: 1 },
        { id: "c1", type: "content", data: "Here is my answer", timestamp: 2 },
      ];
      const messages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("<!-- REASONING");
      expect(result).toContain("Let me think...");
      expect(result).toContain("-->");
      expect(result).toContain('has-reasoning="true"');
    });

    it("serializes message with tool_call part", () => {
      const toolCallData: ToolCall = {
        id: "call-1",
        messageId: "asst-1",
        request: { id: "call-1", type: "function", function: { name: "search", arguments: '{"query":"test"}' } },
        state: "completed",
        timestamp: 1,
      };
      const parts: MessagePart[] = [
        { id: "tc1", type: "tool_call", data: toolCallData, timestamp: 1 },
      ];
      const messages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("<!-- TOOL-CALLS");
      // Tool calls are stored as compact JSON on one line.
      expect(result).toContain(
        '<!-- TOOL-CALLS\n[{"id":"call-1","messageId":"asst-1","request":{"id":"call-1","type":"function","function":{"name":"search","arguments":"{\\"query\\":\\"test\\"}"}},"state":"completed","timestamp":1}]\n-->',
      );
      expect(result).toContain('has-tool-calls="true"');
      expect(ChatMarkdownSerializer.parseMarkdown(
        `---\nid: compact\ncreated: 2024-01-01T00:00:00.000Z\nlastModified: 2024-01-01T00:00:00.000Z\ntitle: Compact\n---\n\n${result}`,
      )?.messages[0]?.tool_calls).toEqual([toolCallData]);
    });

    it.each([
      ["/Users/alex/Vault/Notes", "/Users/alex/Vault", "/Users/alex", "/Users/alex/Vault/Notes/Plan.md"],
      ["C:\\Users\\alex\\Vault\\Notes", "C:\\Users\\alex\\Vault", "C:\\Users\\alex", "C:\\Users\\alex\\Vault\\Notes\\Plan.md"],
    ])("stores native paths portably without changing live tool data (%s)", (cwd, root, home, target) => {
      const tool: any = {
        id: "native-edit", state: "completed",
        native: { agent: "claude", workingDirectory: cwd, vaultRoot: root, vaultRootAlias: root, homeDirectory: home,
          permissionSuggestions: [{ directories: [home] }] },
        request: { id: "native-edit", type: "function", function: { name: "Edit", arguments: JSON.stringify({ file_path: target, old_string: "before", new_string: "after" }) } },
        result: { success: true, data: "Edited" },
      };
      const before = JSON.stringify(tool);
      const message: ChatMessage = { role: "assistant", message_id: "native-message", content: "",
        messageParts: [{ id: "edit", type: "tool_call", data: tool, timestamp: 1 }] };
      const serialized = ChatMarkdownSerializer.serializeMessages([message]);
      expect(serialized).not.toContain("homeDirectory");
      expect(serialized).not.toContain("vaultRootAlias");
      expect(serialized).not.toContain("permissionSuggestions");
      expect(serialized).not.toContain("alex");
      const restored = ChatMarkdownSerializer.readBack([message])?.[0].tool_calls?.[0];
      expect(restored?.native).toEqual({ agent: "claude", workingDirectory: "Notes", vaultRoot: "." });
      expect(JSON.parse(restored!.request.function.arguments)).toEqual({ file_path: "Plan.md", old_string: "before", new_string: "after" });
      expect(JSON.stringify(tool)).toBe(before);
      const reloaded = ChatMarkdownSerializer.parseMarkdown(`---\nid: portable\n---\n\n${serialized}`);
      expect(ChatMarkdownSerializer.serializeMessages(reloaded?.messages ?? [])).toBe(serialized);
    });

    it("stores native tool text without the vault's absolute path or the home folder", () => {
      const root = "/Users/alex/Demo Vaults/Vale Studio";
      const created = `${root}/Reviews/2026-10-24 Weekly review.md`;
      const write: any = {
        id: "native-write", messageId: "native-message", timestamp: 1, state: "completed", executedOn: "server",
        native: { agent: "claude", workingDirectory: root, vaultRoot: root, vaultRootAlias: "/Volumes/Data/Vale Studio", homeDirectory: "/Users/alex",
          description: `Claude wants to create ${created}` },
        request: { id: "native-write", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: created, content: "# Weekly review" }) } },
        result: { success: true, data: { data: `File created successfully at: ${created} (file state is current in your context)`,
          summary: `File created successfully at: ${created} (file state is current in your context)` } },
      };
      const bash: any = {
        ...write, id: "native-bash",
        request: { id: "native-bash", type: "function", function: { name: "Bash", arguments: JSON.stringify({
          command: `ls "${root}/Daily" && cat /Volumes/Data/Vale Studio/Daily/2026-10-24.md`, description: "List daily notes" }) } },
        result: { success: false, data: { data: [{ type: "text", text: `${root}/Daily/2026-10-24.md\n/Users/alex/.claude/settings.json` }] },
          error: { code: "NATIVE_TOOL_FAILED", message: `cat: ${root}/Daily/missing.md: No such file` } },
      };
      const live = JSON.stringify([write, bash]);
      const message: ChatMessage = { role: "assistant", message_id: "native-message", content: "",
        messageParts: [write, bash].map((data, index) => ({ id: data.id, type: "tool_call" as const, data, timestamp: index + 1 })) };
      const serialized = ChatMarkdownSerializer.serializeMessages([message]);
      expect(serialized).not.toContain("alex");
      expect(serialized).not.toContain("/Volumes");
      expect(JSON.stringify([write, bash])).toBe(live);

      const [savedWrite, savedBash] = ChatMarkdownSerializer.readBack([message])![0].tool_calls!;
      expect(savedWrite.native).toEqual({ agent: "claude", workingDirectory: ".", vaultRoot: ".",
        description: "Claude wants to create ./Reviews/2026-10-24 Weekly review.md" });
      expect(JSON.parse(savedWrite.request.function.arguments).file_path).toBe("Reviews/2026-10-24 Weekly review.md");
      expect(savedWrite.result?.data).toEqual({
        data: "File created successfully at: ./Reviews/2026-10-24 Weekly review.md (file state is current in your context)",
        summary: "File created successfully at: ./Reviews/2026-10-24 Weekly review.md (file state is current in your context)",
      });
      expect(JSON.parse(savedBash.request.function.arguments)).toEqual({ command: 'ls "./Daily" && cat ./Daily/2026-10-24.md', description: "List daily notes" });
      expect(savedBash.result).toEqual({ success: false,
        data: { data: [{ type: "text", text: "./Daily/2026-10-24.md\n~/.claude/settings.json" }] },
        error: { code: "NATIVE_TOOL_FAILED", message: "cat: ./Daily/missing.md: No such file" } });

      const reloaded = ChatMarkdownSerializer.parseMarkdown(`---\nid: portable-text\n---\n\n${serialized}`);
      expect(ChatMarkdownSerializer.serializeMessages(reloaded?.messages ?? [])).toBe(serialized);
    });

    it.each([
      ["C:\\Users\\alex\\Vault\\Notes", "C:\\Users\\alex\\Vault", "C:\\Users\\alex",
        "C:\\Users\\alex\\Vault\\Notes\\Plan.md C:\\Users\\alex\\Vault\\Other.md C:\\Users\\alex\\Vault", ".\\Plan.md ..\\Other.md .."],
      ["/vault/Notes", "/vault", undefined, "/vault/Notes/Plan.md /vault/Other.md /vault-copy/Plan.md /vault", "./Plan.md ../Other.md /vault-copy/Plan.md .."],
      ["/elsewhere", "/vault", "/home/alex", "/vault/Plan.md /elsewhere/Plan.md /home/alex/Plan.md", "/vault/Plan.md /elsewhere/Plan.md ~/Plan.md"],
    ])("spells Codex output paths from the saved working directory %s", (cwd, root, home, output, saved) => {
      const tool: any = {
        id: "codex-command", state: "completed",
        native: { agent: "codex", workingDirectory: cwd, vaultRoot: root, ...(home ? { homeDirectory: home } : {}) },
        request: { id: "codex-command", type: "function", function: { name: "commandExecution", arguments: JSON.stringify({ command: "ls" }) } },
        result: { success: true, data: { data: output, summary: output } },
      };
      const restored = ChatMarkdownSerializer.readBack([{
        role: "assistant", message_id: "codex", content: "",
        messageParts: [{ id: "codex", type: "tool_call", data: tool, timestamp: 1 }],
      }])?.[0].tool_calls?.[0];
      expect(restored?.result?.data).toEqual({ data: saved, summary: saved });
    });

    it("keeps Codex rename destinations portable with their source paths", () => {
      const tool: any = {
        id: "rename", state: "completed",
        native: { agent: "codex", workingDirectory: "/vault/Notes", vaultRoot: "/vault" },
        request: { id: "rename", type: "function", function: { name: "fileChange", arguments: JSON.stringify({
          changes: [{ path: "/vault/Notes/Old.md", kind: { type: "update", move_path: "/vault/Notes/New.md" } }],
        }) } },
      };
      const restored = ChatMarkdownSerializer.readBack([{
        role: "assistant", message_id: "rename", content: "",
        messageParts: [{ id: "rename", type: "tool_call", data: tool, timestamp: 1 }],
      }])?.[0].tool_calls?.[0];
      expect(JSON.parse(restored!.request.function.arguments).changes[0]).toEqual({
        path: "Old.md", kind: { type: "update", move_path: "New.md" },
      });
    });

    it("still reads pretty-printed tool calls written by earlier versions", () => {
      const toolCall = { id: "call-1", name: "search", arguments: { query: "test" } };
      const content = [
        "---",
        "id: legacy-tools",
        "created: 2024-01-01T00:00:00.000Z",
        "lastModified: 2024-01-01T00:00:00.000Z",
        "title: Legacy",
        "---",
        "",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-1" has-tool-calls="true" -->',
        "",
        "<!-- TOOL-CALLS",
        JSON.stringify([toolCall], null, 2),
        "-->",
        "",
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
      ].join("\n");
      expect(ChatMarkdownSerializer.parseMarkdown(content)?.messages[0]?.tool_calls)
        .toEqual([toolCall]);
    });

    it("serializes array content with text and images", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
          ],
          message_id: "user-1",
        },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("What is this?");
      expect(result).toContain("Attached image 1");
      expect(result).toContain("SYSTEMSCULPT-CONTENT-PARTS base64");
      expect(result).not.toContain("data:image/png;base64,abc123");
    });

    it("round-trips local attachment identity metadata without exposing it to message text", () => {
      const message: ChatMessage = {
        role: "user",
        message_id: "user-attachments",
        content: [
          { type: "text", text: "Compare" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
          { type: "text", text: "--- BEGIN ATTACHED FILE: source.pdf (application/pdf) ---\nExtracted\n--- END ATTACHED FILE: source.pdf ---" },
        ],
        attachmentMetadata: [
          { id: "image-hash", name: "diagram.png", mimeType: "image/png", byteLength: 3, kind: "image", contentPartIndex: 1 },
          { id: "document-hash", name: "source.pdf", mimeType: "application/pdf", byteLength: 4096, kind: "document", contentPartIndex: 2 },
        ],
      };
      const serialized = ChatMarkdownSerializer.serializeMessages([message]);
      const markdown = [
        "---",
        "id: attachment-chat",
        "created: 2026-01-01T00:00:00.000Z",
        "lastModified: 2026-01-01T00:00:00.000Z",
        "title: Attachments",
        "---",
        "",
        serialized,
      ].join("\n");

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].content).toEqual(message.content);
      expect(parsed?.messages[0].attachmentMetadata).toEqual(message.attachmentMetadata);
      expect(String(parsed?.messages[0].content)).not.toContain("attachment-metadata");
    });

    it("stores ref-backed attachments without embedding multipart payloads in the chat note", () => {
      const message: ChatMessage = {
        role: "user",
        message_id: "user-ref-backed",
        content: [
          { type: "text", text: "Compare" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
        ],
        attachmentMetadata: [{
          id: "image-hash",
          name: "diagram.png",
          mimeType: "image/png",
          byteLength: 3,
          kind: "image",
          contentPartIndex: 1,
          contentRef: {
            schema: "systemsculpt-chat-attachment-v1",
            payload: "image-bytes",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            byteLength: 3,
          },
        }],
      };

      const serialized = ChatMarkdownSerializer.serializeMessages([message]);
      expect(serialized).toContain("Compare");
      expect(serialized).toContain("attachment-metadata=");
      expect(serialized).not.toContain("SYSTEMSCULPT-CONTENT-PARTS");
      expect(serialized).not.toContain("data:image/png;base64");
    });

    it("keeps attachment-only ref-backed messages parseable", () => {
      const message: ChatMessage = {
        role: "user",
        message_id: "user-ref-only",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }],
        attachmentMetadata: [{
          id: "image-hash",
          name: "diagram.png",
          mimeType: "image/png",
          byteLength: 3,
          kind: "image",
          contentPartIndex: 0,
          contentRef: {
            schema: "systemsculpt-chat-attachment-v1",
            payload: "image-bytes",
            sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            byteLength: 3,
          },
        }],
      };
      const markdown = [
        "---",
        "id: attachment-only",
        "created: 2026-01-01T00:00:00.000Z",
        "lastModified: 2026-01-01T00:00:00.000Z",
        "title: Attachment only",
        "---",
        "",
        ChatMarkdownSerializer.serializeMessages([message]),
      ].join("\n");

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages).toEqual([{
        role: "user",
        message_id: "user-ref-only",
        content: "",
        attachmentMetadata: message.attachmentMetadata,
      }]);
    });

    it("adds streaming attribute when message is streaming", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "Streaming...", message_id: "asst-1", streaming: true },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain('streaming="true"');
    });

    it("round-trips the cancelled terminal outcome as an additive attribute", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Stream a long response", message_id: "user-1" },
        {
          role: "assistant",
          content: "PARTIAL-STREAM-START\n1\n2\n3",
          message_id: "asst-cancelled-1",
          terminalOutcome: "cancelled",
        },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(messages);
      expect(serialized).toContain('terminal-outcome="cancelled"');

      const content = `---\nid: chat-cancel-roundtrip\n---\n\n${serialized}`;
      const parsed = ChatMarkdownSerializer.parseMarkdown(content);
      expect(parsed).not.toBeNull();
      expect(parsed?.messages[0]?.terminalOutcome).toBeUndefined();
      expect(parsed?.messages[1]?.terminalOutcome).toBe("cancelled");
      expect(String(parsed?.messages[1]?.content)).toContain("PARTIAL-STREAM-START");
    });

    it.each(['local_claude_failed', 'local_codex_failed', 'local_claude_usage_limit', 'local_codex_usage_limit'])(
      'round-trips %s with native error text outside the answer', terminalFailureCode => {
        for (const content of ['', 'Partial answer', '<!-- SYSTEMSCULPT-MESSAGE-END -->']) {
          const receipt = { terminalOutcome: 'failed' as const, terminalFailureCode,
            terminalFailureMessage: 'Not signed in: "résumé"\n<!-- SYSTEMSCULPT-MESSAGE-END -->', terminalRetryable: !terminalFailureCode.endsWith('usage_limit') };
          const messages: ChatMessage[] = [{ role: 'assistant', message_id: 'native-failed', content, ...receipt }];
          const markdown = ChatMarkdownSerializer.serializeMessages(messages);
          expect(markdown).toContain('terminal-failure-message="');
          expect(markdown).not.toContain(receipt.terminalFailureMessage);
          expect(markdown).not.toMatch(/terminal-(?:report|incident|server-run)-id/);
          expect(ChatMarkdownSerializer.parseMarkdown(`---\nid: native-failure\n---\n\n${markdown}`)?.messages[0])
            .toMatchObject({ content, ...receipt });
        }
      },
    );

    it.each(['missing', 'invalid base64', 'invalid JSON', 'non-string', 'duplicate'])(
      'ignores %s native error metadata without losing transcript content', corruption => {
        const markdown = ChatMarkdownSerializer.serializeMessages([{ role: 'assistant', message_id: 'native-failed', content: 'Partial answer',
          terminalOutcome: 'failed', terminalFailureCode: 'local_claude_failed', terminalFailureMessage: 'Native error', terminalRetryable: true }]);
        const changed = markdown.replace(/terminal-failure-message="[^"]*"/, attribute => {
          if (corruption === 'missing') return '';
          if (corruption === 'duplicate') return `${attribute} ${attribute}`;
          const payload = corruption === 'invalid base64' ? '!' : corruption === 'invalid JSON' ? btoa('bad json') : btoa('{}');
          return `terminal-failure-message="${payload}"`;
        });
        const restored = ChatMarkdownSerializer.parseMarkdown(`---\nid: native-failure\n---\n\n${changed}`)?.messages[0];
        expect(restored?.content).toBe('Partial answer');
        expect(restored).not.toHaveProperty('terminalOutcome');
        expect(restored).not.toHaveProperty('terminalFailureMessage');
      },
    );

    it.each([true, false])(
      "round-trips a complete failed terminal receipt when retryable is %s",
      (terminalRetryable) => {
        const serialized = ChatMarkdownSerializer.serializeMessages([{
          role: "assistant",
          content: "The response failed after producing this content.",
          message_id: `asst-failed-${String(terminalRetryable)}`,
          terminalOutcome: "failed",
          terminalIncidentId: `incident_${"a".repeat(32)}`,
          terminalFailureCode: "agent_turn_failed",
          terminalRetryable,
          terminalServerRunId: `run_${"b".repeat(32)}`,
          responseDurationMs: 35_695,
        }]);

        expect(serialized).toContain('terminal-outcome="failed"');
        expect(serialized).toContain(`terminal-incident-id="incident_${"a".repeat(32)}"`);
        expect(serialized).toContain('terminal-failure-code="agent_turn_failed"');
        expect(serialized).toContain(`terminal-retryable="${String(terminalRetryable)}"`);
        expect(serialized).toContain(`terminal-server-run-id="run_${"b".repeat(32)}"`);
        expect(serialized).toContain('response-duration-ms="35695"');

        const restored = ChatMarkdownSerializer.parseMarkdown(
          `---\nid: chat-failed-roundtrip\n---\n\n${serialized}`,
        )?.messages[0];
        expect(restored).toMatchObject({
          terminalOutcome: "failed",
          terminalIncidentId: `incident_${"a".repeat(32)}`,
          terminalFailureCode: "agent_turn_failed",
          terminalRetryable,
          terminalServerRunId: `run_${"b".repeat(32)}`,
          responseDurationMs: 35_695,
        });
        expect(String(restored?.content).trim())
          .toBe("The response failed after producing this content.");
      },
    );

    it("round-trips a content-free plugin-local failed receipt", () => {
      const reportId = `report_${"c".repeat(32)}`;
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant",
        content: "",
        message_id: `failure-${reportId}`,
        terminalOutcome: "failed",
        terminalReportId: reportId,
        terminalFailureCode: "response_start_failed",
        terminalRetryable: true,
      }]);

      expect(serialized).toContain(`terminal-report-id="${reportId}"`);
      expect(serialized).not.toContain("terminal-incident-id");
      expect(serialized).not.toContain("terminal-server-run-id");
      expect(ChatMarkdownSerializer.parseMarkdown(
        `---\nid: chat-local-failure\n---\n\n${serialized}`,
      )?.messages[0]).toMatchObject({
        content: "",
        terminalOutcome: "failed",
        terminalReportId: reportId,
        terminalFailureCode: "response_start_failed",
        terminalRetryable: true,
      });
    });

    it.each([
      [
        "incident ID",
        `terminal-incident-id="incident_${"a".repeat(32)}"`,
        'terminal-incident-id="incident_invalid"',
      ],
      [
        "all-zero incident ID",
        `terminal-incident-id="incident_${"a".repeat(32)}"`,
        `terminal-incident-id="incident_${"0".repeat(32)}"`,
      ],
      [
        "failure code",
        'terminal-failure-code="agent_turn_failed"',
        'terminal-failure-code="Agent Turn Failed"',
      ],
      [
        "retryable value",
        'terminal-retryable="true"',
        'terminal-retryable="yes"',
      ],
      [
        "server run ID",
        `terminal-server-run-id="run_${"b".repeat(32)}"`,
        'terminal-server-run-id="run_invalid"',
      ],
      [
        "all-zero server run ID",
        `terminal-server-run-id="run_${"b".repeat(32)}"`,
        `terminal-server-run-id="run_${"0".repeat(32)}"`,
      ],
    ])("ignores a failed receipt with an invalid %s", (_label, valid, invalid) => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant",
        content: "Valid message content",
        message_id: "asst-invalid-failed-receipt",
        terminalOutcome: "failed",
        terminalIncidentId: `incident_${"a".repeat(32)}`,
        terminalFailureCode: "agent_turn_failed",
        terminalRetryable: true,
        terminalServerRunId: `run_${"b".repeat(32)}`,
        responseDurationMs: 1_234,
      }]).replace(valid, invalid);

      const restored = ChatMarkdownSerializer.parseMarkdown(
        `---\nid: chat-invalid-failed-receipt\n---\n\n${serialized}`,
      )?.messages[0];
      expect(restored).toMatchObject({
        responseDurationMs: 1_234,
      });
      expect(String(restored?.content).trim()).toBe("Valid message content");
      expect(restored).not.toHaveProperty("terminalOutcome");
      expect(restored).not.toHaveProperty("terminalIncidentId");
      expect(restored).not.toHaveProperty("terminalFailureCode");
      expect(restored).not.toHaveProperty("terminalRetryable");
      expect(restored).not.toHaveProperty("terminalServerRunId");
    });

    it.each([
      'terminal-outcome="failed"',
      `terminal-incident-id="incident_${"a".repeat(32)}"`,
      'terminal-failure-code="agent_turn_failed"',
      'terminal-retryable="false"',
      `terminal-server-run-id="run_${"b".repeat(32)}"`,
    ])("does not restore an incomplete failed receipt missing %s", (missingAttribute) => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant",
        content: "Valid message content",
        message_id: "asst-incomplete-failed-receipt",
        terminalOutcome: "failed",
        terminalIncidentId: `incident_${"a".repeat(32)}`,
        terminalFailureCode: "agent_turn_failed",
        terminalRetryable: false,
        terminalServerRunId: `run_${"b".repeat(32)}`,
      }]).replace(` ${missingAttribute}`, "");

      const restored = ChatMarkdownSerializer.parseMarkdown(
        `---\nid: chat-incomplete-failed-receipt\n---\n\n${serialized}`,
      )?.messages[0];
      expect(String(restored?.content).trim()).toBe("Valid message content");
      expect(restored).not.toHaveProperty("terminalOutcome");
      expect(restored).not.toHaveProperty("terminalIncidentId");
      expect(restored).not.toHaveProperty("terminalFailureCode");
      expect(restored).not.toHaveProperty("terminalRetryable");
      expect(restored).not.toHaveProperty("terminalServerRunId");
    });

    it("does not serialize incomplete or invalid failed receipt metadata", () => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant",
        content: "Still durable",
        message_id: "asst-invalid-failed-writer",
        terminalOutcome: "failed",
        terminalIncidentId: "incident_invalid",
        terminalFailureCode: "agent_turn_failed",
        terminalRetryable: true,
        terminalServerRunId: `run_${"b".repeat(32)}`,
        responseDurationMs: 500,
      }]);

      expect(serialized).not.toContain("terminal-");
      expect(serialized).toContain("Still durable");
      expect(serialized).toContain('response-duration-ms="500"');
    });

    it.each([
      [
        "incident ID",
        `incident_${"0".repeat(32)}`,
        `run_${"b".repeat(32)}`,
      ],
      [
        "server run ID",
        `incident_${"a".repeat(32)}`,
        `run_${"0".repeat(32)}`,
      ],
    ])("does not serialize an all-zero %s", (_label, terminalIncidentId, terminalServerRunId) => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant",
        content: "Still durable",
        message_id: "asst-zero-failed-writer",
        terminalOutcome: "failed",
        terminalIncidentId,
        terminalFailureCode: "agent_turn_failed",
        terminalRetryable: true,
        terminalServerRunId,
      }]);

      expect(serialized).not.toContain("terminal-");
      expect(serialized).toContain("Still durable");
    });

    it("round-trips a bounded assistant response duration as additive metadata", () => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant",
        content: "Finished",
        message_id: "asst-duration",
        responseDurationMs: 2_702_000,
      }]);

      expect(serialized).toContain('response-duration-ms="2702000"');
      expect(ChatMarkdownSerializer.parseMarkdown(
        `---\nid: chat-duration\n---\n\n${serialized}`,
      )?.messages[0]).toMatchObject({ responseDurationMs: 2_702_000 });
    });

    it("ignores invalid response durations without rejecting message content", () => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant",
        content: "Still valid",
        message_id: "asst-invalid-duration",
        responseDurationMs: Number.MAX_SAFE_INTEGER,
      }]);
      const injected = serialized.replace(
        'message-id="asst-invalid-duration"',
        'message-id="asst-invalid-duration" response-duration-ms="9007199254740991"',
      );

      expect(serialized).not.toContain("response-duration-ms=");
      expect(ChatMarkdownSerializer.parseMarkdown(
        `---\nid: chat-invalid-duration\n---\n\n${injected}`,
      )?.messages[0]).toMatchObject({ content: expect.stringContaining("Still valid") });
      expect(ChatMarkdownSerializer.parseMarkdown(
        `---\nid: chat-invalid-duration\n---\n\n${injected}`,
      )?.messages[0].responseDurationMs).toBeUndefined();
    });

    it("never restores an unknown terminal outcome value", () => {
      const content = [
        "---",
        "id: chat-cancel-unknown",
        "---",
        "",
        `<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-odd" terminal-outcome="exploded" terminal-incident-id="incident_${"a".repeat(32)}" terminal-failure-code="agent_turn_failed" terminal-retryable="true" terminal-server-run-id="run_${"b".repeat(32)}" -->`,
        "Odd outcome body",
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
      ].join("\n");

      const parsed = ChatMarkdownSerializer.parseMarkdown(content);
      expect(parsed).not.toBeNull();
      expect(parsed?.messages[0]?.terminalOutcome).toBeUndefined();
      expect(parsed?.messages[0]?.terminalIncidentId).toBeUndefined();
      expect(parsed?.messages[0]?.terminalFailureCode).toBeUndefined();
      expect(parsed?.messages[0]?.terminalRetryable).toBeUndefined();
      expect(parsed?.messages[0]?.terminalServerRunId).toBeUndefined();
    });

    it("joins multiple messages with double newlines", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "First", message_id: "user-1" },
        { role: "assistant", content: "Second", message_id: "asst-1" },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("<!-- SYSTEMSCULPT-MESSAGE-END -->\n\n<!-- SYSTEMSCULPT-MESSAGE-START");
    });
  });

  describe("parseMarkdown", () => {
    const createMarkdown = (metadata: Record<string, any>, body: string): string => {
      const yamlLines = Object.entries(metadata)
        .map(([key, value]) => {
          if (value !== null && typeof value === "object") {
            return `${key}: ${JSON.stringify(value)}`;
          }
          return `${key}: ${value}`;
        })
        .join("\n");
      return `---\n${yamlLines}\n---\n\n${body}`;
    };
    const normalizeMarkdown = (value: string, newline: string, bom: boolean): string => (
      `${bom ? "\uFEFF" : ""}${value.replace(/\n/g, newline)}`
    );

    it("returns null for content without front-matter", () => {
      const content = "Just some text without YAML";

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).toBeNull();
    });

    it("returns null for front-matter without id", () => {
      const content = createMarkdown({ title: "No identity" }, "");

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).toBeNull();
    });

    it("parses basic metadata", () => {
      const content = createMarkdown(
        {
          id: "chat-123",
          title: "Test Chat",
          approvalMode: "full-access",
          created: "2024-01-01T00:00:00Z",
          lastModified: "2024-01-01T12:00:00Z",
        },
        ""
      );

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).not.toBeNull();
      expect(result?.metadata.id).toBe("chat-123");
      expect(result?.metadata.title).toBe("Test Chat");
      expect(result?.metadata.approvalMode).toBe("full-access");
    });

    it("parses metadata independently and rejects content without frontmatter", () => {
      const content = normalizeMarkdown(createMarkdown(
        {
          id: "chat-metadata-only",
          title: "Metadata only",
          created: "2024-01-01T00:00:00Z",
          lastModified: "2024-01-01T12:00:00Z",
        },
        "Body is intentionally ignored by metadata parsing.",
      ), "\r\n", true);

      expect(ChatMarkdownSerializer.parseMetadata(content)).toMatchObject({
        id: "chat-metadata-only",
        title: "Metadata only",
      });
      expect(ChatMarkdownSerializer.parseMetadata("No frontmatter")).toBeNull();
    });

    it("rejects an id-only blank note instead of synthesizing an empty chat", () => {
      expect(ChatMarkdownSerializer.parseMarkdown(createMarkdown({ id: "blank-id-only" }, "")))
        .toBeNull();
    });

    it("strictly restores a server conversation routing pointer from frontmatter", () => {
      const agentConversationId = "conversation_0123456789abcdef0123456789abcdef";
      const content = createMarkdown({
        id: "chat-session",
        title: "Session",
        created: "2026-07-13T00:00:00Z",
        lastModified: "2026-07-13T00:01:00Z",
        agentConversationId,
      }, "");

      expect(ChatMarkdownSerializer.parseMarkdown(content)?.metadata.agentConversationId)
        .toEqual(agentConversationId);
      const malformed = content.replace(agentConversationId, "conversation-invalid");
      expect(ChatMarkdownSerializer.parseMarkdown(malformed)?.metadata.agentConversationId)
        .toBeUndefined();
    });

    it("parses sequential format messages", () => {
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="user-1" -->
Hello, how are you?
<!-- SYSTEMSCULPT-MESSAGE-END -->

<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-1" -->
I'm doing well, thank you!
<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.messages).toHaveLength(2);
      expect(result?.messages[0].role).toBe("user");
      expect(result?.messages[0].message_id).toBe("user-1");
      expect(result?.messages[0].content).toContain("Hello");
      expect(result?.messages[1].role).toBe("assistant");
    });

    it("keeps id-only legacy transcripts when real message frames exist", () => {
      const content = createMarkdown(
        { id: "legacy-id-only" },
        `<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="legacy-user" -->
Legacy question
<!-- SYSTEMSCULPT-MESSAGE-END -->`,
      );

      const restored = ChatMarkdownSerializer.parseMarkdown(content)?.messages[0];

      expect(restored).toMatchObject({
        role: "user",
        message_id: "legacy-user",
      });
      expect(String(restored?.content).trim()).toBe("Legacy question");
    });

    it("parses message with reasoning block", () => {
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-1" has-reasoning="true" -->
<!-- REASONING
Let me think about this carefully.
I should consider all options.
-->
Here is my answer.
<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.messages).toHaveLength(1);
      const msg = result?.messages[0];
      expect(msg?.messageParts).toBeDefined();
      expect(msg?.messageParts?.some(p => p.type === "reasoning")).toBe(true);
    });

    it("parses message with tool calls block", () => {
      const toolCalls = JSON.stringify([
        { id: "call-1", name: "read_file", arguments: { path: "/test.md" } },
      ], null, 2);
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-1" has-tool-calls="true" -->
<!-- TOOL-CALLS
${toolCalls}
-->
Using tools...
<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.messages).toHaveLength(1);
      const msg = result?.messages[0];
      expect(msg?.messageParts?.some(p => p.type === "tool_call")).toBe(true);
      expect(msg?.tool_calls).toHaveLength(1);
      expect(msg?.tool_calls?.[0].id).toBe("call-1");
    });

    it("handles empty message body gracefully", () => {
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="user-1" -->

<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      // Empty messages may or may not be included depending on implementation
      expect(result).not.toBeNull();
    });

    it("parses context_files array", () => {
      const content = createMarkdown(
        {
          id: "chat-123",
          created: "2026-07-28T00:00:00.000Z",
          lastModified: "2026-07-28T00:00:00.000Z",
          context_files: ["file1.md", "path/Extractions/doc.md"],
        },
        ""
      );

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.metadata.context_files).toHaveLength(2);
      expect(result?.metadata.context_files?.[0].path).toBe("file1.md");
      expect(result?.metadata.context_files?.[0].type).toBe("source");
      expect(result?.metadata.context_files?.[1].path).toBe("path/Extractions/doc.md");
      expect(result?.metadata.context_files?.[1].type).toBe("extraction");
    });

    it.each([
      ["LF", "\n", false],
      ["CRLF", "\r\n", false],
      ["BOM plus LF", "\n", true],
      ["BOM plus CRLF", "\r\n", true],
    ])("parses legacy and framed histories identically with %s", (_label, newline, bom) => {
      const normalize = (value: string) => (
        `${bom ? "\uFEFF" : ""}${value.replace(/\n/g, newline)}`
      );
      const legacy = createMarkdown(
        { id: "portable-legacy", title: "Portable Legacy" },
        [
          '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-1" -->',
          "<!-- REASONING",
          "Portable reasoning",
          "-->",
          "<!-- TOOL-CALLS",
          '[{"id":"portable-call","name":"read","arguments":{"paths":["Portable.md"]}}]',
          "-->",
          "Portable answer",
          "<!-- SYSTEMSCULPT-MESSAGE-END -->",
        ].join("\n"),
      );
      const framed = createMarkdown(
        { id: "portable-framed", title: "Portable Framed" },
        ChatMarkdownSerializer.serializeMessages([{
          role: "user",
          content: "Quoted <!-- SYSTEMSCULPT-MESSAGE-END --> marker",
          message_id: "user-framed",
        }]),
      );

      const parsedLegacy = ChatMarkdownSerializer.parseMarkdown(normalize(legacy));
      const parsedFramed = ChatMarkdownSerializer.parseMarkdown(normalize(framed));

      expect(parsedLegacy?.metadata.id).toBe("portable-legacy");
      expect(String(parsedLegacy?.messages[0].content).trim()).toBe("Portable answer");
      expect(parsedLegacy?.messages[0].reasoning).toContain("Portable reasoning");
      expect(parsedLegacy?.messages[0].tool_calls?.[0]).toMatchObject({
        id: "portable-call",
        name: "read",
      });
      expect(parsedFramed?.metadata.id).toBe("portable-framed");
      expect(parsedFramed?.messages).toEqual([
        expect.objectContaining({
          role: "user",
          message_id: "user-framed",
          content: "Quoted <!-- SYSTEMSCULPT-MESSAGE-END --> marker",
        }),
      ]);
    });

    it.each([
      ["LF", "\n", false],
      ["CRLF", "\r\n", false],
      ["BOM plus LF", "\n", true],
      ["BOM plus CRLF", "\r\n", true],
    ])("restores stored multipart content with %s framing", (_label, newline, bom) => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "user",
        message_id: "user-multipart",
        content: [
          { type: "text", text: "Compare these." },
          { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
        ],
      }]);

      const parsed = ChatMarkdownSerializer.parseMarkdown(normalizeMarkdown(
        createMarkdown({ id: "chat-multipart" }, serialized),
        newline,
        bom,
      ));

      expect(parsed?.messages).toEqual([
        expect.objectContaining({
          role: "user",
          message_id: "user-multipart",
          content: [
            { type: "text", text: "Compare these." },
            { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
          ],
        }),
      ]);
    });

    describe("legacy multipart block placement", () => {
      const content = [
        { type: "text" as const, text: "Original answer" },
        { type: "image_url" as const, image_url: { url: "data:image/png;base64,YWJj" } },
      ];
      const encoded = btoa(JSON.stringify(content));
      const multipart = `<!-- SYSTEMSCULPT-CONTENT-PARTS base64\n${encoded}\n-->`;
      const reasoning = "<!-- REASONING\nOriginal reasoning\n-->";
      const tools = '<!-- TOOL-CALLS\n[{"id":"legacy-tool"}]\n-->';
      const frame = (body: string) => [
        '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-1" -->',
        body,
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
      ].join("\n");

      it.each([
        ["LF", "\n", false],
        ["CRLF", "\r\n", false],
        ["BOM plus LF", "\n", true],
        ["BOM plus CRLF", "\r\n", true],
      ])("rejects overlapping or duplicate metadata with %s framing", (_label, newline, bom) => {
        const nested = [
          `Original answer\n<!-- REASONING\nbefore\n${multipart}\nafter\n-->`,
          `Original answer\n<!-- REASONING\nbefore\n${multipart}`,
          `<!-- TOOL-CALLS\n[{"id":"legacy-tool"}]\n${multipart}\n-->`,
          `<!-- SYSTEMSCULPT-PART-CONTENT base64="${encoded}" -->\n${multipart}\n<!-- SYSTEMSCULPT-PART-CONTENT-END -->`,
          `${multipart}\n${reasoning}\n${multipart}`,
          `${multipart}\n<!-- REASONING\nbefore\n${multipart}\nafter\n-->`,
        ];
        const validPrefix = ChatMarkdownSerializer.serializeMessages([
          { role: "user", message_id: "user-1", content: "Keep the whole history" },
        ]);
        for (const body of nested) {
          const markdown = `${validPrefix}\n\n${frame(body)}`;
          expect(ChatMarkdownSerializer.parseMarkdown(normalizeMarkdown(
            createMarkdown({ id: "legacy-placement" }, markdown), newline, bom,
          ))).toBeNull();
        }
      });

      it("preserves legacy metadata quoted as a JSON string rather than a structural block", () => {
        const tool = { id: "quoted-metadata", result: { success: true, data: multipart } };
        const quotedTools = `<!-- TOOL-CALLS\n${JSON.stringify([tool])}\n-->`;
        for (const body of [quotedTools, `${multipart}\n${quotedTools}`]) {
          const parsed = ChatMarkdownSerializer.parseMarkdown(createMarkdown({ id: "legacy-quoted" }, frame(body)));
          expect(parsed?.messages[0].tool_calls).toEqual([tool]);
          if (body !== quotedTools) expect(parsed?.messages[0].content).toEqual(content);
        }
      });

      it.each([
        ["LF", "\n", false],
        ["CRLF", "\r\n", false],
        ["BOM plus LF", "\n", true],
        ["BOM plus CRLF", "\r\n", true],
      ])("preserves top-level metadata and neighboring blocks with %s framing", (_label, newline, bom) => {
        for (const [body, order] of [
          [multipart, undefined],
          [`${multipart}\n${reasoning}\n${tools}\nOriginal answer`, ["content", "reasoning", "tool_call"]],
          [`${reasoning}\n${multipart}\n${tools}\nOriginal answer`, ["reasoning", "content", "tool_call"]],
          [`${reasoning}\n${tools}\nOriginal answer\n${multipart}`, ["reasoning", "tool_call", "content"]],
          [`${reasoning}\n\n\n${tools}\nOriginal answer\n${multipart}`, ["reasoning", "tool_call", "content"]],
        ] as const) {
          const parsed = ChatMarkdownSerializer.parseMarkdown(normalizeMarkdown(
            createMarkdown({ id: "legacy-placement" }, frame(body)), newline, bom,
          ));
          expect(parsed?.messages[0]).toMatchObject({
            role: "assistant", message_id: "assistant-1", content,
          });
          // The stored content stands once, where the note first shows it.
          expect(parsed?.messages[0].messageParts?.map((part) => part.type)).toEqual(order);
          expect(parsed?.messages[0].messageParts?.find((part) => part.type === "content")?.data).toEqual(order && content);
          if (body !== multipart) {
            expect(parsed?.messages[0].reasoning).toBe("Original reasoning");
            expect(parsed?.messages[0].tool_calls).toEqual([{ id: "legacy-tool" }]);
          }
          expect(ChatMarkdownSerializer.readBack(parsed!.messages)?.[0].content).toEqual(content);
        }
      });

      it.each([
        ["LF", "\n", false],
        ["CRLF", "\r\n", false],
        ["BOM plus LF", "\n", true],
        ["BOM plus CRLF", "\r\n", true],
      ])("keeps reasoning and tool calls beside legacy metadata when the chat is saved again with %s framing", (_label, newline, bom) => {
        for (const body of [
          `${reasoning}\n${tools}\nOriginal answer\n${multipart}`,
          `${multipart}\n${reasoning}\n${tools}\nOriginal answer`,
          `${reasoning}\n${multipart}\n${tools}\nOriginal answer`,
        ]) {
          const loaded = ChatMarkdownSerializer.parseMarkdown(normalizeMarkdown(
            createMarkdown({ id: "legacy-rewrite" }, frame(body)), newline, bom,
          ))!;
          const rewritten = ChatMarkdownSerializer.serializeMessages(loaded.messages);
          const reloaded = ChatMarkdownSerializer.parseMarkdown(createMarkdown({ id: "legacy-rewrite" }, rewritten));
          expect(reloaded?.messages).toHaveLength(1);
          expect(reloaded?.messages[0]).toMatchObject({
            role: "assistant",
            message_id: "assistant-1",
            content,
            reasoning: "Original reasoning",
            tool_calls: [{ id: "legacy-tool" }],
          });
          expect(reloaded?.messages[0].messageParts?.map((part) => part.type))
            .toEqual(loaded.messages[0].messageParts?.map((part) => part.type));
          expect(ChatMarkdownSerializer.serializeMessages(reloaded!.messages)).toBe(rewritten);
        }
      });
    });

    it("fails closed when any declared message is missing required attributes", () => {
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="user" -->
Missing message-id
<!-- SYSTEMSCULPT-MESSAGE-END -->

<!-- SYSTEMSCULPT-MESSAGE-START message-id="asst-1" -->
Missing role
<!-- SYSTEMSCULPT-MESSAGE-END -->

<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-2" -->
Valid message
<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).toBeNull();
    });

    it("fails closed instead of returning a valid prefix from a truncated chat", () => {
      const valid = ChatMarkdownSerializer.serializeMessages([
        { role: "user", content: "Keep all of this or none of it", message_id: "user-1" },
      ]);
      const content = createMarkdown(
        { id: "chat-truncated" },
        `${valid}\n\n<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-1" -->\nPartial`,
      );

      expect(ChatMarkdownSerializer.parseMarkdown(content)).toBeNull();
    });

    it("fails closed when the body contains non-chat text but no message frames", () => {
      const content = createMarkdown(
        {
          id: "chat-stray-body",
          created: "2026-07-28T00:00:00.000Z",
          lastModified: "2026-07-28T00:00:00.000Z",
        },
        "Plain markdown body that is not a saved chat transcript.",
      );

      expect(ChatMarkdownSerializer.parseMarkdown(content)).toBeNull();
    });

    it("fails closed instead of dropping an invalid framed payload", () => {
      const valid = ChatMarkdownSerializer.serializeMessages([
        { role: "user", content: "Question", message_id: "user-1" },
      ]);
      const invalid = [
        '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-1" payload-format="base64-json-v1" -->',
        "not-valid-base64-json",
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
      ].join("\n");
      const content = createMarkdown({ id: "chat-corrupt" }, `${valid}\n\n${invalid}`);

      expect(ChatMarkdownSerializer.parseMarkdown(content)).toBeNull();
    });

    it.each([
      ["LF", "\n", false],
      ["CRLF", "\r\n", false],
      ["BOM plus LF", "\n", true],
      ["BOM plus CRLF", "\r\n", true],
    ])("fails closed on corrupt stored multipart content with %s framing", (_label, newline, bom) => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "user",
        message_id: "user-multipart",
        content: [
          { type: "text", text: "Compare these." },
          { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
        ],
      }]).replace(
        /(<!-- SYSTEMSCULPT-CONTENT-PARTS base64\n)([A-Za-z0-9+/=]+)(\n-->)/,
        "$1W10=$3",
      );

      expect(ChatMarkdownSerializer.parseMarkdown(normalizeMarkdown(
        createMarkdown({ id: "chat-corrupt-multipart" }, serialized),
        newline,
        bom,
      ))).toBeNull();
    });

    it.each([
      ["LF", "\n", false],
      ["CRLF", "\r\n", false],
      ["BOM plus LF", "\n", true],
      ["BOM plus CRLF", "\r\n", true],
    ])("fails closed on corrupt sequential attachment metadata with %s framing", (_label, newline, bom) => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "user",
        message_id: "user-sequential-attachments",
        content: [
          { type: "text", text: "Compare" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
        ],
        attachmentMetadata: [{
          id: "image-hash",
          name: "diagram.png",
          mimeType: "image/png",
          byteLength: 3,
          kind: "image",
          contentPartIndex: 1,
        }],
      }]).replace(
        /attachment-metadata="([A-Za-z0-9+/=]+)"/,
        'attachment-metadata="bm90LWpzb24="',
      );

      expect(ChatMarkdownSerializer.parseMarkdown(normalizeMarkdown(
        createMarkdown({ id: "chat-corrupt-sequential-attachments" }, serialized),
        newline,
        bom,
      ))).toBeNull();
    });

    it.each([
      ["LF", "\n", false],
      ["CRLF", "\r\n", false],
      ["BOM plus LF", "\n", true],
      ["BOM plus CRLF", "\r\n", true],
    ])("fails closed on corrupt framed attachment metadata with %s framing", (_label, newline, bom) => {
      // Explicit legacy bytes: new writers no longer frame message content.
      const payload = btoa(JSON.stringify({ version: 1, kind: "content", content: [
        { type: "text", text: "Quoted <!-- SYSTEMSCULPT-MESSAGE-END --> marker" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
      ] }));
      const serialized = `<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="user-framed-attachments" payload-format="base64-json-v1" attachment-metadata="W10=" -->\n${payload}\n<!-- SYSTEMSCULPT-MESSAGE-END -->`;

      expect(serialized).toContain(`payload-format="base64-json-v1"`);
      expect(ChatMarkdownSerializer.parseMarkdown(normalizeMarkdown(
        createMarkdown({ id: "chat-corrupt-framed-attachments" }, serialized),
        newline,
        bom,
      ))).toBeNull();
    });

    it.each([
      [
        "unsupported role",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="system" message-id="system-1" -->\nNope\n<!-- SYSTEMSCULPT-MESSAGE-END -->',
      ],
      [
        "empty message id",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="" -->\nNope\n<!-- SYSTEMSCULPT-MESSAGE-END -->',
      ],
      [
        "empty tool-call payload",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-1" -->\n<!-- TOOL-CALLS\n\n-->\n<!-- SYSTEMSCULPT-MESSAGE-END -->',
      ],
      [
        "non-array tool-call payload",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-1" -->\n<!-- TOOL-CALLS\n{}\n-->\n<!-- SYSTEMSCULPT-MESSAGE-END -->',
      ],
      [
        "invalid tool-call JSON",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-1" -->\n<!-- TOOL-CALLS\n{not-json\n-->\n<!-- SYSTEMSCULPT-MESSAGE-END -->',
      ],
      [
        "nested message frame",
        [
          '<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="user-1" -->',
          '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-1" -->',
          "Nested",
          "<!-- SYSTEMSCULPT-MESSAGE-END -->",
          "<!-- SYSTEMSCULPT-MESSAGE-END -->",
        ].join("\n"),
      ],
    ])("fails closed on a %s", (_label, body) => {
      expect(ChatMarkdownSerializer.parseMarkdown(createMarkdown({ id: "chat-malformed" }, body)))
        .toBeNull();
    });

    it("preserves a declared empty legacy message instead of silently dropping it", () => {
      const content = createMarkdown(
        { id: "chat-empty" },
        [
          '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-empty" -->',
          "",
          "<!-- SYSTEMSCULPT-MESSAGE-END -->",
        ].join("\n"),
      );

      expect(ChatMarkdownSerializer.parseMarkdown(content)?.messages).toEqual([
        expect.objectContaining({
          role: "assistant",
          message_id: "assistant-empty",
          content: "",
        }),
      ]);
    });
  });

  describe("chat identity frontmatter", () => {
    it("recognizes the shared id and timestamp identity contract", () => {
      const content = "\uFEFF---\r\nid: chat-123\r\nlastModified: 2026-07-28T00:00:00.000Z\r\n---\r\n";

      expect(hasChatIdentityFrontmatter(content)).toBe(true);
      expect(hasChatIdentityMetadata({
        id: "chat-123",
        created: "2026-07-28T00:00:00.000Z",
      })).toBe(true);
    });

    it("rejects frontmatter without a chat history timestamp", () => {
      expect(hasChatIdentityFrontmatter("---\nid: stray-note\n---\n")).toBe(false);
      expect(hasChatIdentityMetadata({ id: "stray-note" })).toBe(false);
      expect(hasChatIdentityMetadata(null)).toBe(false);
      expect(hasChatIdentityMetadata([])).toBe(false);
    });

    it("fails closed when YAML parsing throws or returns a non-object", () => {
      (parseYaml as jest.Mock).mockImplementationOnce(() => {
        throw new Error("malformed YAML");
      });
      expect(hasChatIdentityFrontmatter("---\nid: malformed\ncreated: [\n---\n")).toBe(false);

      (parseYaml as jest.Mock).mockReturnValueOnce([]);
      expect(hasChatIdentityFrontmatter("---\nid: array\ncreated: today\n---\n")).toBe(false);
    });
  });

  describe("round-trip serialization", () => {
    it.each(["-->", "--!>"])(
      "round-trips %s in user, assistant, reasoning, and nested tool output without framing",
      (sentinel) => {
        const messages: ChatMessage[] = [
          { role: "user", content: `User quoted ${sentinel}`, message_id: "user-sentinel" },
          { role: "assistant", content: `Assistant quoted ${sentinel}`, message_id: "assistant-sentinel" },
          {
            role: "assistant",
            content: "",
            message_id: "reasoning-sentinel",
            messageParts: [
              { id: "reasoning", type: "reasoning", data: `Reasoning quoted ${sentinel}\n${sentinel} at a line start`, timestamp: 1 },
              { id: "content", type: "content", data: "Done", timestamp: 2 },
            ],
          },
          {
            role: "assistant",
            content: "",
            message_id: "tool-sentinel",
            messageParts: [{
              id: "tool",
              type: "tool_call",
              timestamp: 1,
              data: {
                id: "call-sentinel",
                state: "completed",
                result: {
                  success: true,
                  data: { nested: [{ summary: `Tool quoted ${sentinel}` }] },
                },
              } as any,
            }],
          },
        ];

        const serialized = ChatMarkdownSerializer.serializeMessages(messages);
        const markdown = `---\nid: sentinel-chat\n---\n\n${serialized}`;
        const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

        expect(serialized).not.toContain("payload-format=");
        expect(serialized.match(/<!-- SYSTEMSCULPT-MESSAGE-END -->/g)).toHaveLength(4);
        // Plain answers stay readable and searchable in the note.
        expect(serialized).toContain(`\nUser quoted ${sentinel}\n`);
        expect(serialized).toContain(`\nAssistant quoted ${sentinel}\n`);
        // Neither hidden comment can be closed early by the quoted text.
        for (const block of serialized.match(/<!-- (?:REASONING|TOOL-CALLS)\n[\s\S]*?\n-->/g) ?? []) {
          expect(block.slice(4, -3)).not.toMatch(/--!?>/u);
        }
        expect(serialized).toContain('reasoning-escape="v1"');
        expect(serialized).toContain(`Tool quoted ${sentinel.replace(">", "\\u003e")}`);

        expect(parsed?.messages).toHaveLength(4);
        expect(parsed?.messages[0].content).toBe(`User quoted ${sentinel}`);
        expect(parsed?.messages[1].content).toBe(`Assistant quoted ${sentinel}`);
        expect(parsed?.messages[2].reasoning)
          .toBe(`Reasoning quoted ${sentinel}\n${sentinel} at a line start`);
        const restoredTool = parsed?.messages[3].messageParts?.find((part) => part.type === "tool_call");
        expect((restoredTool?.data as any)?.result?.data?.nested?.[0]?.summary)
          .toBe(`Tool quoted ${sentinel}`);
      },
    );

    it("keeps a mermaid answer and HTML-comment tool output readable instead of framing them", () => {
      const mermaid = "```mermaid\ngraph TD\n  A-->B\n  B --> C\n```";
      const noteWithComment = "# Note\n<!-- hidden: keep -->\nBody > quote";
      const messages: ChatMessage[] = [{
        role: "assistant",
        content: "",
        message_id: "assistant-mermaid",
        messageParts: [
          {
            id: "tool",
            type: "tool_call",
            timestamp: 1,
            data: {
              id: "call-read",
              state: "completed",
              result: { success: true, data: { content: noteWithComment } },
            } as any,
          },
          { id: "content", type: "content", data: mermaid, timestamp: 2 },
        ],
      }];

      const serialized = ChatMarkdownSerializer.serializeMessages(messages);
      const parsed = ChatMarkdownSerializer.parseMarkdown(`---\nid: mermaid\n---\n\n${serialized}`);

      expect(serialized).not.toContain("payload-format=");
      expect(serialized).not.toContain("reasoning-escape=");
      expect(serialized).toContain(mermaid);
      expect(parsed?.messages[0].content).toBe(mermaid);
      const tool = parsed?.messages[0].messageParts?.find((part) => part.type === "tool_call");
      expect((tool?.data as any)?.result?.data?.content).toBe(noteWithComment);
    });

    it("round-trips generated histories exactly without making marker-containing replies opaque", () => {
      // Deterministic xorshift so a failure reproduces from this seed.
      let seed = 0x363;
      const random = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 0x1_0000_0000;
      };
      const atoms = [
        "-", "--", "-->", "--!>", ">", "!", "\\", "\\>", "--\\>", "--\\\\!>", "<!--", " ", "\n",
        "\r\n", "a", "é", "🗿", "\"", "`", "A-->B", "\n-->", "\n--\\>",
      ];
      const markerAtoms = [
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
        "<!-- REASONING\n",
        "<!-- TOOL-CALLS",
        "\n<!-- SYSTEMSCULPT-CONTENT-PARTS base64\nAAAA\n-->",
      ];
      const pick = (values: readonly string[]) => values[Math.floor(random() * values.length)];
      const text = () => {
        let value = "x";
        const length = 1 + Math.floor(random() * 12);
        for (let index = 0; index < length; index += 1) {
          value += random() < 0.04 ? pick(markerAtoms) : pick(atoms);
        }
        // Stored content chunks are trimmed at their boundaries, so keep a
        // non-whitespace sentinel on both ends of every generated value.
        return `${value}y`;
      };
      const markers = ["<!-- SYSTEMSCULPT-", "<!-- REASONING", "<!-- TOOL-CALLS"];
      let escapedMessages = 0;
      let readableMessages = 0;
      const hasMarker = (...values: string[]) =>
        values.some((value) => value.includes("\r") || markers.some((marker) => value.includes(marker)));

      for (let iteration = 0; iteration < 300; iteration += 1) {
        const reasoning = text();
        const content = text();
        const toolOutput = text();
        const userText = text();
        const messages: ChatMessage[] = [
          { role: "user", content: userText, message_id: `user-${iteration}` },
          {
            role: "assistant",
            content: "",
            message_id: `assistant-${iteration}`,
            messageParts: [
              { id: "reasoning", type: "reasoning", data: reasoning, timestamp: 1 },
              {
                id: "tool",
                type: "tool_call",
                timestamp: 2,
                data: { id: `call-${iteration}`, state: "completed", result: { success: true, data: toolOutput } } as any,
              },
              { id: "content", type: "content", data: content, timestamp: 3 },
            ],
          },
        ];

        const serialized = ChatMarkdownSerializer.serializeMessages(messages);
        const parsed = ChatMarkdownSerializer.parseMarkdown(`---\nid: generated-${iteration}\n---\n\n${serialized}`);
        const [userStart, assistantStart] = required(serialized.match(/<!-- SYSTEMSCULPT-MESSAGE-START [^\n]*-->/g));

        for (const start of [userStart, assistantStart]) {
          expect(start).not.toContain("payload-format=");
          if (start.includes("marker-escape=")) escapedMessages += 1;
          else readableMessages += 1;
        }
        expect(userStart.includes("marker-escape=")).toBe(hasMarker(userText));
        expect(assistantStart.includes("marker-escape="))
          .toBe(hasMarker(reasoning, content));
        expect(parsed?.messages[0].content).toBe(userText);
        expect(parsed?.messages[1].reasoning).toBe(reasoning);
        expect(parsed?.messages[1].content).toBe(content);
        const tool = parsed?.messages[1].messageParts?.find((part) => part.type === "tool_call");
        expect((tool?.data as any)?.result?.data).toBe(toolOutput);
        // Escapes are stable across repeated saves, including quoted escapes.
        const resaved = ChatMarkdownSerializer.serializeMessages(parsed?.messages ?? []);
        expect(resaved).toBe(serialized);
        const reloaded = ChatMarkdownSerializer.parseMarkdown(`---\nid: resaved-${iteration}\n---\n\n${resaved}`);
        expect(ChatMarkdownSerializer.serializeMessages(reloaded?.messages ?? [])).toBe(resaved);
      }
      expect(escapedMessages).toBeGreaterThan(50);
      expect(readableMessages).toBeGreaterThan(200);
    });

    it("escapes reasoning reversibly for every short run of comment-closer characters", () => {
      const alphabet = ["-", "\\", "!", ">", "a"];
      let candidates = [""];
      const failures: string[] = [];
      for (let length = 1; length <= 5; length += 1) {
        candidates = candidates.flatMap((prefix) => alphabet.map((character) => prefix + character));
        for (const candidate of candidates) {
          const reasoning = `x${candidate}y`;
          const serialized = ChatMarkdownSerializer.serializeMessages([{
            role: "assistant",
            content: "",
            message_id: "assistant-escape",
            messageParts: [
              { id: "reasoning", type: "reasoning", data: reasoning, timestamp: 1 },
              { id: "content", type: "content", data: "Answer", timestamp: 2 },
            ],
          }]);
          const stored = serialized.match(/<!-- REASONING\n([\s\S]*?)\n-->/)?.[1] ?? "";
          const parsed = ChatMarkdownSerializer.parseMarkdown(`---\nid: escape\n---\n\n${serialized}`);
          if (
            /--!?>/u.test(stored)
            || serialized.includes("payload-format=")
            || parsed?.messages[0].reasoning !== reasoning
          ) failures.push(reasoning);
        }
      }
      expect(failures).toEqual([]);
    });

    it("still reads messages the previous writer framed because of --> alone", () => {
      const frame = (payload: unknown) => btoa(String.fromCharCode(
        ...new TextEncoder().encode(JSON.stringify(payload)),
      ));
      const legacyToolCall = {
        id: "call-legacy",
        state: "completed",
        result: { success: true, data: "graph A-->B" },
      };
      const markdown = [
        "---",
        "id: legacy-framed",
        "---",
        "",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="user-legacy" payload-format="base64-json-v1" -->',
        frame({ version: 1, kind: "content", content: "Draw A-->B" }),
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
        "",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-legacy" has-tool-calls="true" has-reasoning="true" payload-format="base64-json-v1" -->',
        frame({
          version: 1,
          kind: "parts",
          parts: [
            { type: "reasoning", data: "Think --!> then -->" },
            { type: "tool_call", data: legacyToolCall },
            { type: "content", data: "```mermaid\nA-->B\n```" },
          ],
        }),
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
      ].join("\n");

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].content).toBe("Draw A-->B");
      expect(parsed?.messages[1].reasoning).toBe("Think --!> then -->");
      expect(parsed?.messages[1].content).toBe("```mermaid\nA-->B\n```");
      expect(parsed?.messages[1].tool_calls).toEqual([legacyToolCall]);

      // Saving it again drops the framing: the note becomes readable.
      const rewritten = ChatMarkdownSerializer.serializeMessages(parsed?.messages ?? []);
      expect(rewritten).not.toContain("payload-format=");
      const reloaded = ChatMarkdownSerializer.parseMarkdown(`---\nid: legacy-framed\n---\n\n${rewritten}`);
      expect(reloaded?.messages[0].content).toBe("Draw A-->B");
      expect(reloaded?.messages[1].reasoning).toBe("Think --!> then -->");
      expect(reloaded?.messages[1].content).toBe("```mermaid\nA-->B\n```");
      expect(reloaded?.messages[1].tool_calls).toEqual([legacyToolCall]);
    });

    it("reads unescaped reasoning and raw > in older notes verbatim", () => {
      const markdown = [
        "---",
        "id: legacy-verbatim",
        "---",
        "",
        '<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-verbatim" has-reasoning="true" has-tool-calls="true" -->',
        "<!-- REASONING",
        "Keep --\\> and a > b exactly",
        "-->",
        "<!-- TOOL-CALLS",
        '[{"id":"call-gt","name":"read","arguments":{"query":"a > b"}}]',
        "-->",
        "Answer",
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
      ].join("\n");

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].reasoning).toBe("Keep --\\> and a > b exactly");
      expect(parsed?.messages[0].tool_calls?.[0]).toMatchObject({
        id: "call-gt",
        arguments: { query: "a > b" },
      });
    });

    it.each([
      ["an unknown version", 'reasoning-escape="v2"'],
      ["a repeated declaration", 'reasoning-escape="v1" reasoning-escape="v1"'],
    ])("fails closed on %s of the reasoning escape", (_label, attribute) => {
      const markdown = [
        "---",
        "id: bad-escape",
        "---",
        "",
        `<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="assistant-escape" has-reasoning="true" ${attribute} -->`,
        "<!-- REASONING",
        "Arrow --\\>",
        "-->",
        "Answer",
        "<!-- SYSTEMSCULPT-MESSAGE-END -->",
      ].join("\n");

      expect(ChatMarkdownSerializer.parseMarkdown(markdown)).toBeNull();
    });

    it("keeps quoted markers readable and restores Unicode, entities, and trailing spaces exactly", () => {
      const exactContent = "Unicode 🗿 café\nNUL:\u0000\nReserved: <!-- SYSTEMSCULPT-MESSAGE-END -->\nEntities: &lt;!-- REASONING &amp; &#60;\nTrailing spaces:  ";
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "user",
        content: exactContent,
        message_id: "user-exact-escaped",
      }]);
      expect(serialized).not.toContain("payload-format=");
      expect(serialized).toContain('marker-escape="v1"');
      expect(serialized).toContain("Unicode 🗿 café");
      expect(serialized).toContain("&lt;!-- SYSTEMSCULPT-MESSAGE-END -->");
      expect(ChatMarkdownSerializer.parseMarkdown(
        `---\nid: exact-escaped\n---\n\n${serialized}`,
      )?.messages[0].content).toBe(exactContent);
    });

    it("leaves the assistant reply readable when a tool reads the chat's own Markdown", () => {
      const quotedChat = ChatMarkdownSerializer.serializeMessages([
        { role: "user", content: "Read every note", message_id: "user-1" },
      ]);
      const tool = { id: "read-chat", state: "completed", result: { success: true, data: quotedChat } } as any;
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant", message_id: "assistant-1", content: "",
        messageParts: [
          { id: "tool", type: "tool_call", data: tool, timestamp: 1 },
          { id: "reply", type: "content", data: "## Vault review\n\nYour notes are ready.", timestamp: 2 },
        ],
      }]);
      expect(serialized).not.toContain("payload-format=");
      expect(serialized).toContain("## Vault review\n\nYour notes are ready.");
      expect(serialized.match(/<!-- SYSTEMSCULPT-MESSAGE-START /g)).toHaveLength(1);
      const restored = ChatMarkdownSerializer.parseMarkdown(`---\nid: self-read\n---\n\n${serialized}`);
      expect(restored?.messages[0].tool_calls).toEqual([tool]);
      expect(restored?.messages[0].content).toBe("## Vault review\n\nYour notes are ready.");
    });

    it.each(["Quoted <!-- SYSTEMSCULPT-MESSAGE-END -->\r", " \n"])("preserves exact text %j beside a self-read tool and empty reasoning", (text) => {
      const tool = { id: "read", result: { data: "<!-- SYSTEMSCULPT-MESSAGE-END -->" } } as any;
      const restored = ChatMarkdownSerializer.readBack([{
        role: "assistant", message_id: "exact-parts", content: "",
        messageParts: [
          { id: "t", type: "tool_call", data: tool, timestamp: 1 },
          { id: "r", type: "reasoning", data: "", timestamp: 2 },
          { id: "c", type: "content", data: text, timestamp: 3 },
        ],
      }]);
      expect(restored?.[0].content).toBe(text);
      expect(restored?.[0].messageParts?.map(part => part.type)).toEqual(["tool_call", "reasoning", "content"]);
    });

    it("rewrites legacy ordered attachment parts without losing the attachment or hiding prose", () => {
      const data = [{ type: "text", text: "Quoted <!-- SYSTEMSCULPT-MESSAGE-END -->" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }];
      const payload = btoa(JSON.stringify({ version: 1, kind: "parts", parts: [{ type: "content", data }] }));
      const legacy = `---\nid: ordered-attachment\n---\n\n<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="a" payload-format="base64-json-v1" -->\n${payload}\n<!-- SYSTEMSCULPT-MESSAGE-END -->`;
      const loaded = ChatMarkdownSerializer.parseMarkdown(legacy)!;
      const rewritten = ChatMarkdownSerializer.serializeMessages(loaded.messages);
      expect(rewritten).not.toContain('payload-format=');
      expect(rewritten).toContain('Quoted &lt;!-- SYSTEMSCULPT-MESSAGE-END -->');
      expect(ChatMarkdownSerializer.readBack(loaded.messages)?.[0].messageParts?.[0].data).toEqual(data);
      expect(loaded.messages[0].content).toEqual(data);
      expect(ChatMarkdownSerializer.readBack(loaded.messages)?.[0].content).toEqual(data);
    });

    it("keeps attachment parts in the content of an ordered message beside its text", () => {
      const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,YWJj" } };
      const restored = ChatMarkdownSerializer.readBack([{
        role: "assistant", message_id: "ordered-attachment-text", content: "",
        messageParts: [
          { id: "r", type: "reasoning", data: "Look first", timestamp: 1 },
          { id: "a", type: "content", data: "Here it is:", timestamp: 2 },
          { id: "b", type: "content", data: [image], timestamp: 3 },
        ],
      }]);
      expect(restored?.[0].content).toEqual([{ type: "text", text: "Here it is:" }, image]);
      expect(restored?.[0].reasoning).toBe("Look first");
    });

    it("rejects an unterminated tool block instead of silently losing the tool call", () => {
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "assistant", message_id: "bad-tool", content: "",
        messageParts: [{ id: "t", type: "tool_call", data: { id: "read", result: { data: "<!-- SYSTEMSCULPT-MESSAGE-END -->" } } as any, timestamp: 1 }],
      }]);
      expect(ChatMarkdownSerializer.parseMarkdown(`---\nid: corrupt-tool\n---\n\n${serialized.replace(/\n-->\n/u, "\n")}`)).toBeNull();
    });

    it("escapes a reserved marker split across adjacent content parts", () => {
      const text = "<!-- SYSTEMSCULPT-MESSAGE-END -->";
      const restored = ChatMarkdownSerializer.readBack([{
        role: "assistant", message_id: "split", content: "",
        messageParts: [
          { id: "a", type: "content", data: "<!-- SYSTEM", timestamp: 1 },
          { id: "b", type: "content", data: "SCULPT-MESSAGE-END -->", timestamp: 2 },
        ],
      }]);
      expect(restored?.[0].content).toBe(text);
    });

    it.each(['marker-escape="v2"', 'marker-escape="v1" marker-escape="v1"'])(
      "fails closed on an unsupported marker escape: %s", (attribute) => {
        const markdown = `---\nid: corrupt-escape\n---\n\n<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="u1" ${attribute} -->\nQuoted &lt;!-- REASONING\n<!-- SYSTEMSCULPT-MESSAGE-END -->`;
        expect(ChatMarkdownSerializer.parseMarkdown(markdown)).toBeNull();
      },
    );

    it("round-trips data images without creating a DOM image element", () => {
      const createElement = jest.spyOn(document, "createElement");
      try {
        const message: ChatMessage = {
          role: "user",
          message_id: "user-no-dom-image",
          content: [
            { type: "text", text: "Inspect this image." },
            { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
          ],
        };
        const serialized = ChatMarkdownSerializer.serializeMessages([message]);
        const parsed = ChatMarkdownSerializer.parseMarkdown(
          `---\nid: no-dom-image\n---\n\n${serialized}`,
        );

        expect(parsed?.messages[0].content).toEqual(message.content);
        expect(createElement).not.toHaveBeenCalled();
      } finally {
        createElement.mockRestore();
      }
    });

    it("round-trips old unencoded chat history without changing its meaning", () => {
      const legacy = `---
id: old-history
---

<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="old-user" -->
Legacy question
<!-- SYSTEMSCULPT-MESSAGE-END -->

<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="old-assistant" has-reasoning="true" has-tool-calls="true" -->
<!-- REASONING
Legacy reasoning
-->
<!-- TOOL-CALLS
[{"id":"old-call","name":"read","arguments":{"paths":["Old.md"]}}]
-->
Legacy answer
<!-- SYSTEMSCULPT-MESSAGE-END -->`;

      const loaded = ChatMarkdownSerializer.parseMarkdown(legacy);
      const rewritten = ChatMarkdownSerializer.serializeMessages(loaded?.messages ?? []);
      const reloaded = ChatMarkdownSerializer.parseMarkdown(`---\nid: old-history\n---\n\n${rewritten}`);

      expect(rewritten).not.toContain("payload-format=");
      expect(reloaded?.messages).toHaveLength(2);
      expect(String(reloaded?.messages[0].content).trim()).toBe("Legacy question");
      expect(String(reloaded?.messages[1].content).trim()).toBe("Legacy answer");
      expect(reloaded?.messages[1].reasoning).toContain("Legacy reasoning");
      expect(reloaded?.messages[1].tool_calls?.[0].id).toBe("old-call");
    });

    it("preserves message content through serialize and parse", () => {
      const originalMessages: ChatMessage[] = [
        { role: "user", content: "Hello!", message_id: "user-1" },
        { role: "assistant", content: "Hi there!", message_id: "asst-1" },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages).toHaveLength(2);
      expect(parsed?.messages[0].content).toContain("Hello!");
      expect(parsed?.messages[1].content).toContain("Hi there!");
    });

    it("preserves ordered mixed message content, including image bytes, through reload", () => {
      const content = [
        { type: "text" as const, text: "Compare these." },
        { type: "image_url" as const, image_url: { url: "data:image/webp;base64,YWJj" } },
        {
          type: "text" as const,
          text: "--- BEGIN ATTACHED FILE: notes.md (text/markdown) ---\n# Notes\n--- END ATTACHED FILE: notes.md ---",
        },
      ];
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "user",
        content,
        message_id: "user-mixed",
      }]);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].content).toEqual(content);
      expect(parsed?.messages[0].messageParts).toBeUndefined();
    });

    it("preserves reasoning through serialize and parse", () => {
      const parts: MessagePart[] = [
        { id: "r1", type: "reasoning", data: "Deep thought here", timestamp: 1 },
        { id: "c1", type: "content", data: "Final answer", timestamp: 2 },
      ];
      const originalMessages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].reasoning).toContain("Deep thought here");
    });

    it("preserves tool calls through serialize and parse", () => {
      const toolCallData: ToolCall = {
        id: "call-1",
        messageId: "asst-1",
        request: { id: "call-1", type: "function", function: { name: "search", arguments: '{"query":"test"}' } },
        state: "completed",
        timestamp: 1,
      };
      const parts: MessagePart[] = [
        { id: "tc1", type: "tool_call", data: toolCallData, timestamp: 1 },
      ];
      const originalMessages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].tool_calls).toHaveLength(1);
      expect(parsed?.messages[0].tool_calls?.[0].id).toBe("call-1");
    });

    it("preserves web_search tool metadata for reload rendering", () => {
      const webSearchToolCall: ToolCall = {
        id: "call-web-1",
        messageId: "asst-1",
        request: {
          id: "call-web-1",
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: "systemsculpt pricing" }),
          },
        },
        state: "completed",
        timestamp: 1,
        executedOn: "server" as const,
        result: {
          success: true,
          data: {
            query: "systemsculpt pricing",
            results: [{ title: "SystemSculpt", url: "https://systemsculpt.com" }],
          },
        },
      };

      const originalMessages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          message_id: "asst-1",
          messageParts: [
            {
              id: "tool_call_part-call-web-1",
              type: "tool_call",
              data: webSearchToolCall,
              timestamp: 1,
            },
          ],
        },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);
      const restoredToolCall = parsed?.messages[0].tool_calls?.[0] as any;
      expect(restoredToolCall?.request?.function?.name).toBe("web_search");
      expect(restoredToolCall?.executedOn).toBe("server");
      expect(JSON.parse(restoredToolCall?.request?.function?.arguments ?? "{}")).toEqual({
        query: "systemsculpt pricing",
      });
      expect(restoredToolCall?.result?.data?.query).toBe("systemsculpt pricing");
    });

    it("reloads legacy web search history into a valid managed follow-up request", () => {
      const legacyWebSearchToolCall = {
        id: "call-web-legacy",
        messageId: "assistant-search",
        request: {
          id: "call-web-legacy",
          type: "function" as const,
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: "release notes" }),
          },
        },
        state: "completed" as const,
        timestamp: 1,
        result: {
          success: true,
          data: { tool: "web_search", result_count: 1 },
        },
      };
      const savedMessages: ChatMessage[] = [
        { role: "user", content: "Search release notes", message_id: "user-search" },
        {
          role: "assistant",
          content: "Search-backed answer",
          message_id: "assistant-search",
          messageParts: [
            {
              id: "tool_call_part-call-web-legacy",
              type: "tool_call",
              data: legacyWebSearchToolCall,
              timestamp: 1,
            },
            {
              id: "content-search-answer",
              type: "content",
              data: "Search-backed answer",
              timestamp: 2,
            },
          ],
        },
        { role: "user", content: "Follow up", message_id: "user-follow-up" },
      ];
      const markdown = `---
id: legacy-web-search
---

${ChatMarkdownSerializer.serializeMessages(savedMessages)}`;

      const reloaded = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(reloaded?.messages[1].tool_calls?.[0]).not.toHaveProperty("executedOn");
      expect(reloaded?.messages.map((message) => message.role))
        .toEqual(["user", "assistant", "user"]);
      expect(reloaded?.messages[1].content).toBe("Search-backed answer");
    });

    it("reloads the oldest flat web search shape without dereferencing a missing request", () => {
      const savedMessages: ChatMessage[] = [
        { role: "user", content: "Search", message_id: "user-search" },
        {
          role: "assistant",
          content: "Legacy search answer",
          message_id: "assistant-search",
          messageParts: [
            {
              id: "tool_call_part-flat-web",
              type: "tool_call",
              data: {
                id: "flat-web",
                name: "web_search",
                arguments: { query: "legacy" },
              } as any,
              timestamp: 1,
            },
            {
              id: "content-flat-web",
              type: "content",
              data: "Legacy search answer",
              timestamp: 2,
            },
          ],
        },
        { role: "user", content: "Continue", message_id: "user-follow-up" },
      ];
      const markdown = `---
id: flat-web-search
---

${ChatMarkdownSerializer.serializeMessages(savedMessages)}`;

      const reloaded = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(reloaded?.messages.map((message) => message.role))
        .toEqual(["user", "assistant", "user"]);
      expect(reloaded?.messages[1].content).toBe("Legacy search answer");
    });
  });
});
