/**
 * @jest-environment jsdom
 */
import { PluginLogger } from "../PluginLogger";
import { LogLevel } from "../errorHandling";
import { THIN_AGENT_LIFECYCLE_CODES } from "../../views/chatview/thin/ThinAgentLifecycle";

describe("PluginLogger", () => {
  let logger: PluginLogger;
  let mockPlugin: any;
  let mockStorage: any;
  let consoleSpy: { [key: string]: jest.SpyInstance };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockStorage = {
      appendToFile: jest.fn().mockResolvedValue(undefined),
      getPath: jest.fn((dir, file) => `${dir}/${file}`),
    };

    mockPlugin = {
      settings: {
        debugMode: false,
        logLevel: LogLevel.WARNING,
      },
      storage: mockStorage,
      app: {
        vault: {
          adapter: {
            stat: jest.fn().mockResolvedValue({ size: 100 }),
            write: jest.fn().mockResolvedValue(undefined),
          },
        },
      },
      getErrorCollector: jest.fn(() => null),
    };

    consoleSpy = {
      log: jest.spyOn(console, "log").mockImplementation(),
      info: jest.spyOn(console, "info").mockImplementation(),
      warn: jest.spyOn(console, "warn").mockImplementation(),
      error: jest.spyOn(console, "error").mockImplementation(),
      debug: jest.spyOn(console, "debug").mockImplementation(),
    };

    logger = new PluginLogger(mockPlugin);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.values(consoleSpy).forEach((spy) => spy.mockRestore());
  });

  describe("constructor", () => {
    it("creates logger instance", () => {
      expect(logger).toBeInstanceOf(PluginLogger);
    });

    it("accepts custom log file name", () => {
      const customLogger = new PluginLogger(mockPlugin, { logFileName: "custom.log" });
      expect(customLogger).toBeInstanceOf(PluginLogger);
    });
  });

  describe("logging methods", () => {
    it("routes info messages to Obsidian-safe debug output", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Test info message");

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        expect.stringContaining("Test info message")
      );
    });

    it("warn logs message at warn level", () => {
      logger.warn("Test warning");

      expect(consoleSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining("Test warning")
      );
    });

    it("error logs message at error level", () => {
      const error = new Error("Test error");

      logger.error("Error occurred", error);

      expect(consoleSpy.error).toHaveBeenCalledWith(
        expect.stringContaining("Error occurred"),
        error
      );
    });

    it("debug logs message at debug level", () => {
      mockPlugin.settings.debugMode = true;

      logger.debug("Debug info");

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        expect.stringContaining("Debug info")
      );
    });

    it("includes context in log", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Message with context", { source: "TestSource" });

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        expect.stringContaining("Message with context"),
        expect.objectContaining({ source: "TestSource" })
      );
    });
  });

  describe("log level filtering", () => {
    it("logs all levels when debugMode is true", () => {
      mockPlugin.settings.debugMode = true;

      logger.debug("Debug message");
      logger.info("Info message");
      logger.warn("Warn message");
      logger.error("Error message");

      expect(consoleSpy.debug).toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it("respects log level setting", () => {
      mockPlugin.settings.logLevel = LogLevel.ERROR;

      logger.debug("Should not log");
      logger.info("Should not log");
      logger.warn("Should not log");
      logger.error("Should log");

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it("always logs InitializationTracer warnings and errors", () => {
      mockPlugin.settings.logLevel = LogLevel.ERROR;

      logger.warn("Tracer warning", { source: "InitializationTracer" });

      expect(consoleSpy.warn).toHaveBeenCalled();
    });

    it("persists sanitized lifecycle info while ordinary info remains filtered", async () => {
      logger.info("ordinary info");
      logger.lifecycle({
        sequence: 7,
        timestamp: 123,
        code: "local_tool_started",
        phase: "tool_execution",
        runId: "run-safe",
        toolName: "read",
        toolCallId: "call-safe",
        incidentId: "incident_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        prompt: "private prompt",
        content: "private content",
        path: "Private.md",
        license: "private license",
        ticket: "private ticket",
        provider: "private provider",
        credential: "private credential",
      });

      expect(logger.getRecentEntries()).toEqual([
        expect.objectContaining({
          level: "info",
          message: "thin-agent:lifecycle",
          context: {
            source: "ThinAgentLifecycle",
            metadata: {
              sequence: 7,
              timestamp: 123,
              code: "local_tool_started",
              phase: "tool_execution",
              runId: "run-safe",
              toolName: "read",
              toolCallId: "call-safe",
              incidentId: "incident_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          },
        }),
      ]);
      await logger.flushNow();
      const persisted = mockStorage.appendToFile.mock.calls[0][2]
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line));
      expect(persisted).toHaveLength(1);
      expect(JSON.stringify(persisted)).not.toMatch(
        /prompt|content|path|query|input|output|license|ticket|provider|credential|reason/i,
      );
      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });

    it.each([
      "start",
      "session",
      "response",
      "approval",
      "tool_execution",
      "mutation_journal",
      "persistence",
      "render",
      "unknown",
    ])("accepts the neutral lifecycle phase %s", (phase) => {
      logger.lifecycle({ code: "run_started", phase });

      expect(logger.getRecentEntries()).toEqual([
        expect.objectContaining({
          message: "thin-agent:lifecycle",
          context: {
            source: "ThinAgentLifecycle",
            metadata: { code: "run_started", phase },
          },
        }),
      ]);
    });

    it("accepts every code in the strict lifecycle contract", () => {
      for (const code of THIN_AGENT_LIFECYCLE_CODES) {
        logger.lifecycle({ code, phase: "unknown" });
      }

      expect(logger.getRecentEntries().map((entry) => entry.context?.metadata?.code))
        .toEqual(THIN_AGENT_LIFECYCLE_CODES);
    });

    it.each([
      "bootstrap",
      "connection",
      "stream",
      "protocol",
    ])("rejects the retired lifecycle phase %s", (phase) => {
      logger.lifecycle({ code: "run_started", phase });

      expect(logger.getRecentEntries()).toEqual([]);
    });

    it.each([
      "provider_rate_limited",
      "provider_cost_unavailable",
      "provider_temporarily_unavailable",
      "runtime_failed",
      "harness_failed",
      "syntactically_valid_but_unknown",
    ])("rejects the private lifecycle code %s", (code) => {
      logger.lifecycle({ code, phase: "response" });

      expect(logger.getRecentEntries()).toEqual([]);
    });
  });

  describe("getRecentEntries", () => {
    it("returns empty array initially", () => {
      const entries = logger.getRecentEntries();

      expect(entries).toEqual([]);
    });

    it("returns logged entries", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("First message");
      logger.warn("Second message");

      const entries = logger.getRecentEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0].message).toBe("First message");
      expect(entries[1].message).toBe("Second message");
    });

    it("returns copy of entries array", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Message");

      const entries1 = logger.getRecentEntries();
      const entries2 = logger.getRecentEntries();

      expect(entries1).not.toBe(entries2);
    });
  });

  describe("getSupportDiagnostics", () => {
    it("reprojects only strict lifecycle and failure scalars for copied support data", () => {
      const hostileCanaries = [
        "private prompt text",
        "/Users/michael/Vault/Private.md",
        "QA-CANARY-7421",
        "OpenRouter",
        "Cloudflare",
        "agent connection",
        "WebSocket",
        "harness",
        "connection ticket",
        "transport protocol",
        "AI SDK",
        "Think runtime",
        "Pi runtime",
        "private model",
      ];
      logger.error(
        hostileCanaries.join(" | "),
        Object.assign(new Error(hostileCanaries[0]), {
          stack: hostileCanaries.join("\n"),
        }),
        {
          source: "ArbitraryConsoleSource",
          metadata: {
            prompt: hostileCanaries[0],
            path: hostileCanaries[1],
            canary: hostileCanaries[2],
          },
        },
      );
      logger.lifecycle({
        sequence: 7,
        timestamp: 123,
        code: "run_started",
        phase: "response",
        runId: "run-safe",
        toolName: "read",
        toolCallId: "call-safe",
        prompt: hostileCanaries[0],
        path: hostileCanaries[1],
        canary: hostileCanaries[2],
      });
      logger.error(
        "ChatView agent bridge failed",
        {
          code: "response_save_failed",
          status: 503,
          retryable: true,
          incidentId: "incident_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          prompt: hostileCanaries[0],
          path: hostileCanaries[1],
          canary: hostileCanaries[2],
          provider: hostileCanaries[3],
        },
        { source: "AgentChatView", method: "completedRunSettlement" },
      );

      const support = logger.getSupportDiagnostics();

      expect(support).toEqual([
        {
          timestamp: expect.any(String),
          severity: "info",
          code: "run_started",
          phase: "response",
          sequence: 7,
        },
        {
          timestamp: expect.any(String),
          severity: "error",
          code: "response_save_failed",
          phase: "persistence",
          status: 503,
          retryable: true,
          incident_id: "incident_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ]);
      const copied = JSON.stringify(support);
      for (const canary of hostileCanaries) {
        expect(copied).not.toContain(canary);
      }
      expect(copied).not.toMatch(
        /\b(?:model|provider|harness|transport|protocol|Cloudflare|Think|Pi|OpenRouter|WebSocket)\b|agent connection|connection ticket|AI SDK/iu,
      );
    });

    it("bounds results and rejects poisoned buffered metadata", () => {
      logger.lifecycle({ code: "run_started", phase: "response" });
      logger.lifecycle({ code: "phase_working", phase: "response" });
      logger.lifecycle({ code: "run_finished_completed", phase: "response" });

      expect(logger.getSupportDiagnostics(1)).toEqual([
        expect.objectContaining({ code: "run_finished_completed" }),
      ]);
      expect(logger.getSupportDiagnostics(0)).toEqual([]);

      const buffered = logger.getRecentEntries() as any[];
      buffered[1].context.metadata = {
        code: "provider_runtime_failed",
        phase: "transport",
        prompt: "QA-CANARY-7421",
      };
      const projected = logger.getSupportDiagnostics();
      expect(projected.map((entry) => entry.code)).toEqual([
        "run_started",
        "run_finished_completed",
      ]);
      expect(JSON.stringify(projected)).not.toContain("QA-CANARY-7421");
    });
  });

  describe("setLogFileName", () => {
    it("updates log file name", () => {
      logger.setLogFileName("new-log.log");

      // File name should be updated (verified by flush behavior)
      expect(() => logger.setLogFileName("another.log")).not.toThrow();
    });

    it("ignores empty string", () => {
      logger.setLogFileName("test.log");
      logger.setLogFileName("");

      // Should not throw or change behavior
      expect(() => logger.setLogFileName("")).not.toThrow();
    });
  });

  describe("flush behavior", () => {
    it("flushes entries after interval", async () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Message to flush");

      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(mockStorage.appendToFile).toHaveBeenCalled();
    });

    it("flushNow forces immediate flush", async () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Immediate flush");

      await logger.flushNow();

      expect(mockStorage.appendToFile).toHaveBeenCalled();
    });

    it("does not flush when no entries pending", async () => {
      await logger.flushNow();

      expect(mockStorage.appendToFile).not.toHaveBeenCalled();
    });

    it("handles missing storage gracefully", async () => {
      mockPlugin.storage = null;
      mockPlugin.settings.debugMode = true;

      logger.info("Message without storage");

      // Advance timers to allow flush scheduling to work
      jest.advanceTimersByTime(3000);

      // Should not throw - but we can't fully test flushNow without storage
      // as it waits for storage to become available
      expect(() => logger.info("Another message")).not.toThrow();
    });
  });

  describe("error serialization", () => {
    it("serializes Error objects", () => {
      const error = new Error("Test error");
      error.stack = "Error: Test error\n  at test.ts:1:1";

      logger.error("Error occurred", error);

      const entries = logger.getRecentEntries();
      expect(entries[0].error).toEqual(expect.objectContaining({
        name: "Error",
        message: "Test error",
        stack: expect.stringContaining("Test error"),
      }));
    });

    it("serializes non-Error objects", () => {
      logger.error("Error occurred", { custom: "error" });

      const entries = logger.getRecentEntries();
      expect(entries[0].error).toEqual({ custom: "error" });
    });

    it("serializes primitive errors", () => {
      logger.error("Error occurred", "String error");

      const entries = logger.getRecentEntries();
      expect(entries[0].error).toEqual({ message: "String error" });
    });

    it("persists one bounded thin-agent failure without raw error or collector fanout", async () => {
      const mockCollector = { captureLog: jest.fn() };
      mockPlugin.getErrorCollector = jest.fn(() => mockCollector);
      const hostileCanaries = [
        "PROMPT_CANARY_01",
        "CONTENT_CANARY_02",
        "PATH_CANARY_03",
        "PROVIDER_CANARY_04",
        "TICKET_CANARY_05",
        "CREDENTIAL_CANARY_06",
        "NESTED_RESPONSE_CANARY_07",
        "STACK_CANARY_08",
      ];
      const raw = Object.assign(
        new Error(hostileCanaries.slice(0, 4).join(":")),
        {
          code: "response_save_failed",
          status: 503,
          retryable: true,
          incidentId: "incident_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          prompt: hostileCanaries[0],
          content: hostileCanaries[1],
          path: hostileCanaries[2],
          provider: hostileCanaries[3],
          ticket: hostileCanaries[4],
          credential: hostileCanaries[5],
          response: { nested: { body: hostileCanaries[6] } },
        },
      );
      raw.stack = `Error: ${hostileCanaries[7]}\n at /vault/Private.md:1:1`;
      const context = {
        source: "AgentChatView",
        method: "agentBridge",
        metadata: {
          chatId: hostileCanaries[2],
          prompt: hostileCanaries[0],
          credential: hostileCanaries[5],
        },
      };

      logger.error("ChatView agent bridge failed", raw, context);
      logger.error("ChatView agent bridge failed", raw, context);

      expect(logger.getRecentEntries()).toEqual([{
        timestamp: expect.any(String),
        level: "error",
        message: "thin-agent:failure",
        context: {
          source: "ThinAgentClient",
          metadata: {
            code: "response_save_failed",
            phase: "response",
            status: 503,
            retryable: true,
            incidentId: "incident_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
        },
        error: undefined,
      }]);
      expect(consoleSpy.error).not.toHaveBeenCalled();
      expect(mockCollector.captureLog).not.toHaveBeenCalled();

      await logger.flushNow();
      const persisted = mockStorage.appendToFile.mock.calls[0][2];
      const persistedEntries = persisted.trim().split("\n").map(JSON.parse);
      expect(persistedEntries).toHaveLength(1);
      expect(persistedEntries[0]).toEqual({
        timestamp: expect.any(String),
        level: "error",
        message: "thin-agent:failure",
        context: {
          source: "ThinAgentClient",
          metadata: {
            code: "response_save_failed",
            phase: "response",
            status: 503,
            retryable: true,
            incidentId: "incident_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
        },
      });
      const surfaces = [
        persisted,
        JSON.stringify(logger.getRecentEntries()),
        JSON.stringify(mockCollector.captureLog.mock.calls),
        JSON.stringify(Object.values(consoleSpy).flatMap((spy) => spy.mock.calls)),
      ].join("\n");
      for (const canary of hostileCanaries) {
        expect(surfaces).not.toContain(canary);
      }
    });

    it("bounds a hostile plain-object failure across every diagnostic surface", async () => {
      const mockCollector = { captureLog: jest.fn() };
      mockPlugin.getErrorCollector = jest.fn(() => mockCollector);
      const hostileCanaries = [
        "PLAIN_PROMPT_CANARY_11",
        "PLAIN_CONTENT_CANARY_12",
        "PLAIN_PATH_CANARY_13",
        "PLAIN_PROVIDER_CANARY_14",
        "PLAIN_TICKET_CANARY_15",
        "PLAIN_CREDENTIAL_CANARY_16",
        "PLAIN_NESTED_RESPONSE_CANARY_17",
        "PLAIN_STACK_CANARY_18",
      ];
      const hostile = {
        code: "provider_rate_limited",
        requestId: "request-with-private-correlation",
        message: hostileCanaries[3],
        prompt: hostileCanaries[0],
        content: hostileCanaries[1],
        path: hostileCanaries[2],
        provider: hostileCanaries[3],
        ticket: hostileCanaries[4],
        credential: hostileCanaries[5],
        response: { data: { nested: hostileCanaries[6] } },
        stack: hostileCanaries[7],
      };
      logger.error(
        "ChatView agent bridge failed",
        hostile,
        {
          source: "AgentChatView",
          method: "onTerminalConnectionError",
          metadata: { prompt: hostileCanaries[0], path: hostileCanaries[2] },
        },
      );
      logger.error(
        "ChatView agent bridge failed",
        hostile,
        { source: "AgentChatView", method: "onTerminalConnectionError" },
      );

      expect(logger.getRecentEntries()).toEqual([expect.objectContaining({
        message: "thin-agent:failure",
        context: {
          source: "ThinAgentClient",
          metadata: {
            code: "client_failure",
            phase: "session",
          },
        },
        error: undefined,
      })]);
      expect(mockCollector.captureLog).not.toHaveBeenCalled();
      expect(Object.values(consoleSpy).flatMap((spy) => spy.mock.calls)).toEqual([]);

      await logger.flushNow();
      const persisted = mockStorage.appendToFile.mock.calls[0][2];
      const persistedEntries = persisted.trim().split("\n").map(JSON.parse);
      expect(persistedEntries).toEqual([{
        timestamp: expect.any(String),
        level: "error",
        message: "thin-agent:failure",
        context: {
          source: "ThinAgentClient",
          metadata: {
            code: "client_failure",
            phase: "session",
          },
        },
      }]);
      const surfaces = [
        persisted,
        JSON.stringify(logger.getRecentEntries()),
        JSON.stringify(mockCollector.captureLog.mock.calls),
        JSON.stringify(Object.values(consoleSpy).flatMap((spy) => spy.mock.calls)),
      ].join("\n");
      for (const canary of hostileCanaries) {
        expect(surfaces).not.toContain(canary);
      }
      expect(surfaces).not.toContain("request-with-private-correlation");
    });

    it.each([
      "agent_turn_failed",
      "approval_failed",
      "context_prepare_failed",
      "context_too_large",
      "context_window_exhausted",
      "history_sync_failed",
      "insufficient_credits",
      "invalid_response_data",
      "invalid_turn_context",
      "local_tool_result_failed",
      "message_save_failed",
      "response_display_failed",
      "response_failed",
      "response_finished_with_pending_vault_action",
      "response_in_progress",
      "response_interrupted",
      "response_resume_failed",
      "response_save_failed",
      "response_start_failed",
      "response_start_rate_limited",
      "response_state_update_failed",
      "selected_context_unavailable",
      "service_accounting_unavailable",
      "service_cost_unavailable",
      "service_outcome_unknown",
      "service_rate_limited",
      "service_temporarily_unavailable",
      "session_expired",
      "session_history_load_failed",
      "session_interrupted",
      "tool_call_id_conflict",
      "tool_mutation_journal_unavailable",
      "tool_mutation_outcome_unknown",
      "tool_result_display_failed",
      "web_search_unavailable",
    ])("preserves the neutral thin-agent failure code %s", (code) => {
      logger.error(
        "ChatView agent bridge failed",
        { code },
        { source: "AgentChatView", method: "agentBridge" },
      );

      expect(logger.getRecentEntries()).toEqual([
        expect.objectContaining({
          message: "thin-agent:failure",
          context: {
            source: "ThinAgentClient",
            metadata: {
              code,
              phase: "response",
            },
          },
          error: undefined,
        }),
      ]);
    });

    it.each([
      "provider_rate_limited",
      "provider_cost_unavailable",
      "provider_temporarily_unavailable",
      "runtime_failed",
      "harness_failed",
      "credential_leaked",
      "license_key_invalid",
      "ticket_invalid",
      "prompt_leaked",
      "content_leaked",
      "path_leaked",
      "agent_bootstrap_failed",
      "agent_connection_closed",
      "agent_stream_error",
      "agent_protocol_error",
      "made_up_failure",
    ])("rejects the private or retired thin-agent failure code %s", (code) => {
      logger.error(
        "ChatView agent bridge failed",
        { code },
        { source: "AgentChatView", method: "agentBridge" },
      );

      const serialized = JSON.stringify(logger.getRecentEntries());
      expect(logger.getRecentEntries()).toEqual([
        expect.objectContaining({
          context: {
            source: "ThinAgentClient",
            metadata: {
              code: "client_failure",
              phase: "response",
            },
          },
        }),
      ]);
      expect(serialized).not.toContain(code);
    });

    it.each([
      ["onTerminalConnectionError", "session"],
      ["loadChatHydration", "start"],
      ["agentBridge", "response"],
      ["reportAgentError", "response"],
      ["completedRunSettlement", "persistence"],
      ["agentSnapshotRender", "render"],
      ["unrecognizedMethod", "unknown"],
    ])("maps AgentChatView method %s to neutral phase %s", (method, phase) => {
      logger.error(
        "ChatView agent bridge failed",
        { code: "response_start_failed" },
        { source: "AgentChatView", method },
      );

      expect(logger.getRecentEntries()).toEqual([
        expect.objectContaining({
          context: {
            source: "ThinAgentClient",
            metadata: {
              code: "response_start_failed",
              phase,
            },
          },
        }),
      ]);
    });
  });

  describe("context sanitization", () => {
    it("preserves valid context fields", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Message", {
        source: "TestSource",
        method: "testMethod",
        command: "testCommand",
        metadata: { key: "value" },
      });

      const entries = logger.getRecentEntries();
      expect(entries[0].context).toEqual({
        source: "TestSource",
        method: "testMethod",
        command: "testCommand",
        metadata: { key: "value" },
      });
    });

    it("handles unserializable metadata", () => {
      mockPlugin.settings.debugMode = true;

      const circular: any = {};
      circular.self = circular;

      logger.info("Message", { metadata: circular });

      const entries = logger.getRecentEntries();
      expect(entries[0].context?.metadata).toEqual({ note: "metadata_unserializable" });
    });
  });

  describe("error collector forwarding", () => {
    it("forwards logs to error collector when available", () => {
      const mockCollector = {
        captureLog: jest.fn(),
      };
      mockPlugin.getErrorCollector = jest.fn(() => mockCollector);

      logger.error("Test error", new Error("Test"));

      expect(mockCollector.captureLog).toHaveBeenCalledWith(
        "error",
        expect.any(String),
        "Test error",
        expect.any(String)
      );
    });

    it("handles missing error collector", () => {
      mockPlugin.getErrorCollector = jest.fn(() => null);

      expect(() => logger.error("Test")).not.toThrow();
    });
  });

  // #214/#158: once the plugin is unloading the logger must stop buffering and
  // stop its self-rescheduling flush timer, so diagnostics never keep writing
  // to disk after the plugin is disabled.
  describe("inert once the plugin is unloading (#214, #158)", () => {
    it("drains pending entries exactly once before the unload guard and then stays inert", async () => {
      mockPlugin.settings.debugMode = true;
      let unloading = false;
      mockPlugin.isPluginUnloading = jest.fn(() => unloading);
      logger.info("accepted before unload");

      const first = logger.flushBeforeUnload();
      const second = logger.flushBeforeUnload();
      expect(second).toBe(first);
      await first;

      expect(mockStorage.appendToFile).toHaveBeenCalledTimes(1);
      expect(mockStorage.appendToFile.mock.calls[0][2].trim().split("\n")).toHaveLength(1);

      logger.info("rejected while drain is quiesced");
      unloading = true;
      logger.dispose();
      logger.info("rejected after guard");
      jest.advanceTimersByTime(3000);
      await Promise.resolve();

      expect(mockStorage.appendToFile).toHaveBeenCalledTimes(1);
      expect(logger.getRecentEntries().map((entry) => entry.message)).toEqual([
        "accepted before unload",
      ]);
    });

    it("drops new entries while the plugin is unloading", async () => {
      mockPlugin.settings.debugMode = true;
      mockPlugin.isPluginUnloading = jest.fn(() => true);

      logger.info("after disable");

      expect(logger.getRecentEntries()).toHaveLength(0);

      jest.advanceTimersByTime(3000);
      await Promise.resolve();

      expect(mockStorage.appendToFile).not.toHaveBeenCalled();
    });

    it("dispose() cancels the pending flush timer so nothing writes after disable", async () => {
      mockPlugin.settings.debugMode = true;

      logger.info("buffered before disable"); // schedules a flush timer
      logger.dispose();

      jest.advanceTimersByTime(3000);
      await Promise.resolve();

      expect(mockStorage.appendToFile).not.toHaveBeenCalled();
    });

    it("a flush scheduled while active does not write once the timer fires after disable", async () => {
      mockPlugin.settings.debugMode = true;
      let unloading = false;
      mockPlugin.isPluginUnloading = jest.fn(() => unloading);

      logger.info("buffered while active"); // schedules a flush timer
      unloading = true;                      // plugin disabled before the timer fires

      jest.advanceTimersByTime(3000);
      await Promise.resolve();

      expect(mockStorage.appendToFile).not.toHaveBeenCalled();
    });

    it("enforceSizeLimit performs no direct adapter write when unload flips mid-flush", async () => {
      mockPlugin.settings.debugMode = true;
      let unloading = false;
      mockPlugin.isPluginUnloading = jest.fn(() => unloading);
      // The append step is where unload begins; enforceSizeLimit runs next and
      // must not perform its direct (keystone-bypassing) adapter stat/write.
      mockStorage.appendToFile.mockImplementation(async () => {
        unloading = true;
      });

      logger.info("entry");
      await logger.flushNow();

      expect(mockStorage.appendToFile).toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.stat).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();
    });
  });
});
