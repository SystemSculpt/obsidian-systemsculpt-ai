import { App, TFile } from "obsidian";
import { SystemSculptService } from "../SystemSculptService";
import { SystemSculptEnvironment } from "../api/SystemSculptEnvironment";
import { AGENT_PRESET } from "../../constants/prompts";

const licenseService = {
  validateLicense: jest.fn().mockResolvedValue(true),
  updateBaseUrl: jest.fn(),
};
const modelManagementService = {
  getModels: jest.fn().mockResolvedValue([]),
  getModelInfo: jest.fn(async (modelId: string) => ({
    isCustom: false,
    actualModelId: "systemsculpt/ai-agent",
    modelSource: "systemsculpt",
    model: {
      id: "systemsculpt@@systemsculpt/ai-agent",
      provider: "systemsculpt",
      sourceMode: "systemsculpt",
      sourceProviderId: "systemsculpt",
      piExecutionModelId: "systemsculpt/ai-agent",
      piRemoteAvailable: true,
      piLocalAvailable: false,
      piAuthMode: "hosted",
      supported_parameters: ["tools"],
    },
  })),
  preloadModels: jest.fn().mockResolvedValue(undefined),
  updateBaseUrl: jest.fn(),
};
const documentUploadService = {
  uploadDocument: jest.fn().mockResolvedValue({ documentId: "doc", status: "ok" }),
  updateConfig: jest.fn(),
};
const audioUploadService = {
  uploadAudio: jest.fn().mockResolvedValue({ documentId: "audio", status: "ok" }),
  updateConfig: jest.fn(),
};
const contextFileService = {
  prepareMessagesWithContext: jest.fn(async (messages: any[]) => messages),
};
const mcpService = {
  getAvailableTools: jest.fn(),
  executeTool: jest.fn(),
};
const localPiStreamExecutor = {
  executeLocalPiStream: jest.fn(),
};
const remoteProviderStreamExecutor = {
  executeOpenRouterRemoteStream: jest.fn(),
};

jest.mock("../StreamingService", () => ({
  StreamingService: jest.fn().mockImplementation(() => {
    const actual = jest.requireActual("../StreamingService");
    return new actual.StreamingService();
  }),
}));

jest.mock("../LicenseService", () => ({
  LicenseService: jest.fn().mockImplementation(() => licenseService),
}));

jest.mock("../ModelManagementService", () => ({
  ModelManagementService: jest.fn().mockImplementation(() => modelManagementService),
}));

jest.mock("../ContextFileService", () => ({
  ContextFileService: jest.fn().mockImplementation(() => contextFileService),
}));

jest.mock("../DocumentUploadService", () => ({
  DocumentUploadService: jest.fn().mockImplementation(() => documentUploadService),
}));

jest.mock("../AudioUploadService", () => ({
  AudioUploadService: jest.fn().mockImplementation(() => audioUploadService),
}));

jest.mock("../LocalPiStreamExecutor", () => ({
  executeLocalPiStream: jest.fn((...args) => localPiStreamExecutor.executeLocalPiStream(...args)),
}));

jest.mock("../providerRuntime/OpenRouterRemoteStreamExecutor", () => ({
  executeOpenRouterRemoteStream: jest.fn((...args) =>
    remoteProviderStreamExecutor.executeOpenRouterRemoteStream(...args)
  ),
}));

jest.mock("../../mcp/MCPService", () => ({
  MCPService: jest.fn().mockImplementation(() => mcpService),
}));

jest.mock("../../utils/debugLogger", () => ({
  DebugLogger: {
    getInstance: jest.fn().mockReturnValue({
      logAPIRequest: jest.fn(),
    }),
  },
}));

jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../StreamingErrorHandler", () => ({
  StreamingErrorHandler: {
    handleStreamError: jest.fn(),
  },
}));

jest.mock("../api/SystemSculptEnvironment", () => ({
  SystemSculptEnvironment: {
    resolveBaseUrl: jest.fn(() => "https://api.systemsculpt.test/api/v1"),
    buildHeaders: jest.fn((licenseKey?: string) => ({
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-SystemSculpt-Client": "obsidian-plugin",
      ...(licenseKey ? { "x-license-key": licenseKey } : {}),
    })),
  },
}));

jest.mock("../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      isMobile: jest.fn(() => false),
      supportsStreaming: jest.fn(() => false),
      preferredTransport: jest.fn(() => "fetch"),
    })),
  },
}));

const createPlugin = () => {
  const app = new App();
  app.metadataCache.getFirstLinkpathDest = jest.fn(() => null);
  app.vault.getAbstractFileByPath = jest.fn(() => null);

  return {
    app,
    manifest: {
      version: "4.13.0",
    },
    settings: {
      serverUrl: "",
      licenseKey: "license",
      selectedModelId: "",
      embeddingsEnabled: false,
      workflowEngine: { automations: {} },
    },
    modelService: {
      getModels: jest.fn().mockResolvedValue([]),
    },
  } as any;
};

async function collectEvents(generator: AsyncGenerator<any, void, unknown>) {
  const events: any[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("SystemSculptService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemSculptService.clearInstance();
    localPiStreamExecutor.executeLocalPiStream.mockImplementation(async function* () {
      return;
    });
    remoteProviderStreamExecutor.executeOpenRouterRemoteStream.mockImplementation(async function* () {
      return;
    });
    mcpService.getAvailableTools.mockResolvedValue([
      {
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          description: "Read a file from the vault",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
    ]);
    mcpService.executeTool.mockResolvedValue({ content: "hello" });
    delete (global as any).fetch;
  });

  it("initializes with the resolved base url and updates dependent services", () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    expect(service.baseUrl).toBe("https://api.systemsculpt.test/api/v1");

    plugin.settings.serverUrl = "https://new.endpoint";
    service.updateSettings(plugin.settings);

    expect(licenseService.updateBaseUrl).toHaveBeenCalled();
    expect(modelManagementService.updateBaseUrl).toHaveBeenCalled();
    expect(documentUploadService.updateConfig).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1",
      "license",
      "4.13.0"
    );
    expect(audioUploadService.updateConfig).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1",
      "license"
    );
  });

  it("builds hosted SystemSculpt request previews from the prepared chat payload", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const { requestBody, preparedMessages, actualModelId } = await service.buildRequestPreview({
      messages: [{ role: "user", content: "Hello", message_id: "msg_1" } as any],
      model: "systemsculpt@@systemsculpt/ai-agent",
    });

    expect(requestBody).toEqual({
      model: "systemsculpt/ai-agent",
      messages: preparedMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "mcp-filesystem_read",
            description: "Read a file from the vault",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        },
      ],
    });
    expect(actualModelId).toBe("systemsculpt/ai-agent");
    expect(contextFileService.prepareMessagesWithContext).toHaveBeenCalledWith(
      [{ role: "user", content: "Hello", message_id: "msg_1" }],
      new Set(),
      true,
      AGENT_PRESET.systemPrompt
    );
    expect(mcpService.getAvailableTools).toHaveBeenCalledTimes(1);
  });

  it("builds local Pi request previews for Pi-backed desktop models", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    modelManagementService.getModelInfo.mockResolvedValueOnce({
      isCustom: false,
      actualModelId: "openai/gpt-4.1",
      modelSource: "pi_local",
      model: {
        id: "local-pi-openai@@gpt-4.1",
        provider: "openai",
        sourceMode: "pi_local",
        sourceProviderId: "openai",
        piExecutionModelId: "openai/gpt-4.1",
        piLocalAvailable: true,
        supported_parameters: ["tools"],
      },
    });

    const { requestBody, preparedMessages, actualModelId } = await service.buildRequestPreview({
      messages: [{ role: "user", content: "Hello from Pi", message_id: "msg_pi_preview_1" } as any],
      model: "local-pi-openai@@gpt-4.1",
    });

    expect(requestBody).toEqual({
      transport: "pi-sdk",
      model: "openai/gpt-4.1",
      messageCount: 1,
      messages: [{ role: "user", content: "Hello from Pi" }],
      sourceMode: "pi_local",
    });
    expect(preparedMessages).toEqual([
      { role: "user", content: "Hello from Pi", message_id: "msg_pi_preview_1" },
    ]);
    expect(actualModelId).toBe("openai/gpt-4.1");
    expect(mcpService.getAvailableTools).not.toHaveBeenCalled();
  });

  it("builds hosted-style request previews for remote provider models", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    modelManagementService.getModelInfo.mockResolvedValueOnce({
      isCustom: true,
      actualModelId: "openai/gpt-5.4-mini",
      modelSource: "custom_endpoint",
      model: {
        id: "openrouter@@openai/gpt-5.4-mini",
        provider: "openrouter",
        sourceMode: "custom_endpoint",
        sourceProviderId: "openrouter",
        piExecutionModelId: "openai/gpt-5.4-mini",
        piRemoteAvailable: true,
        piLocalAvailable: false,
        supported_parameters: ["tools"],
      },
    });

    const { requestBody, actualModelId } = await service.buildRequestPreview({
      messages: [{ role: "user", content: "Hello remote", message_id: "msg_remote_preview_1" } as any],
      model: "openrouter@@openai/gpt-5.4-mini",
    });

    expect(requestBody).toEqual({
      model: "openai/gpt-5.4-mini",
      messages: [{ role: "user", content: "Hello remote" }],
      stream: true,
    });
    expect(actualModelId).toBe("openai/gpt-5.4-mini");
  });

  it("keeps repeated hosted tool-call ids unique across continuation rounds", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const repeatedSearchId = "functions.mcp-filesystem_search:0";
    const repeatedFindId = "functions.mcp-filesystem_find:1";

    const makeToolCall = (id: string, name: string, args: string) => ({
      id,
      messageId: "assistant",
      request: {
        id,
        type: "function",
        function: {
          name,
          arguments: args,
        },
      },
      state: "completed",
      result: {
        success: true,
        data: { ok: true, id, args },
      },
    });

    const { requestBody } = await service.buildRequestPreview({
      messages: [
        {
          role: "user",
          content: "Show me the chronology reload fixture.",
          message_id: "user-1",
        } as any,
        {
          role: "assistant",
          content: "",
          message_id: "assistant-1",
          tool_calls: [
            makeToolCall(
              repeatedSearchId,
              "mcp-filesystem_search",
              "{\"patterns\":[\"chronology reload fixture\"]}"
            ),
            makeToolCall(
              repeatedFindId,
              "mcp-filesystem_find",
              "{\"patterns\":[\"fixture\"]}"
            ),
          ],
        } as any,
        {
          role: "tool",
          tool_call_id: repeatedSearchId,
          content: "{\"results\":[]}",
          message_id: "tool-1",
        } as any,
        {
          role: "tool",
          tool_call_id: repeatedFindId,
          content: "{\"results\":[\"fixtures\"]}",
          message_id: "tool-2",
        } as any,
        {
          role: "assistant",
          content: "",
          message_id: "assistant-2",
          tool_calls: [
            makeToolCall(
              repeatedSearchId,
              "mcp-filesystem_search",
              "{\"patterns\":[\"00-activity-log chronology\"]}"
            ),
            makeToolCall(
              repeatedFindId,
              "mcp-filesystem_find",
              "{\"patterns\":[\"05-meeting-prep.md\"]}"
            ),
          ],
          reasoning_details: [
            { type: "reasoning.summary", index: 0, id: repeatedSearchId },
          ],
        } as any,
        {
          role: "tool",
          tool_call_id: repeatedSearchId,
          content: "{\"results\":[\"05-meeting-prep.md\"]}",
          message_id: "tool-3",
        } as any,
        {
          role: "tool",
          tool_call_id: repeatedFindId,
          content: "{\"results\":[\"Sales/Prospects/tick-blaze/05-meeting-prep.md\"]}",
          message_id: "tool-4",
        } as any,
      ],
      model: "systemsculpt@@systemsculpt/ai-agent",
    });

    const previewMessages = requestBody.messages as any[];
    const firstAssistant = previewMessages[1];
    const firstSearchTool = previewMessages[2];
    const firstFindTool = previewMessages[3];
    const secondAssistant = previewMessages[4];
    const secondSearchTool = previewMessages[5];
    const secondFindTool = previewMessages[6];

    const firstRoundIds = firstAssistant.tool_calls.map((toolCall: any) => toolCall.id);
    const secondRoundIds = secondAssistant.tool_calls.map((toolCall: any) => toolCall.id);

    expect(firstRoundIds).toHaveLength(2);
    expect(secondRoundIds).toHaveLength(2);
    expect(new Set([...firstRoundIds, ...secondRoundIds]).size).toBe(4);
    expect(firstRoundIds[0]).not.toBe(repeatedSearchId);
    expect(firstRoundIds[1]).not.toBe(repeatedFindId);
    expect(secondRoundIds[0]).not.toBe(firstRoundIds[0]);
    expect(secondRoundIds[1]).not.toBe(firstRoundIds[1]);

    expect(firstSearchTool.tool_call_id).toBe(firstRoundIds[0]);
    expect(firstFindTool.tool_call_id).toBe(firstRoundIds[1]);
    expect(secondSearchTool.tool_call_id).toBe(secondRoundIds[0]);
    expect(secondFindTool.tool_call_id).toBe(secondRoundIds[1]);
    expect(secondAssistant.reasoning_details?.[0]?.id).toBe(secondRoundIds[0]);
  });

  it("executes hosted tool calls through the local MCP service", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const result = await service.executeHostedToolCall({
      toolCall: {
        id: "call_1",
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          arguments: "{\"paths\":[\"foo.md\"]}",
        },
      } as any,
      chatView: { id: "chat-view" },
      timeoutMs: 1200,
    });

    expect(result).toEqual({
      success: true,
      data: { content: "hello" },
    });
    expect(mcpService.executeTool).toHaveBeenCalledWith(
      "mcp-filesystem_read",
      { paths: ["foo.md"] },
      { id: "chat-view" },
      { timeoutMs: 1200 }
    );
  });

  it("returns a structured failure for invalid hosted tool call arguments", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    const result = await service.executeHostedToolCall({
      toolCall: {
        id: "call_bad_args",
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          arguments: "{not json",
        },
      } as any,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_ARGUMENTS");
    expect(mcpService.executeTool).not.toHaveBeenCalled();
  });

  it("streams hosted SystemSculpt chat completions through the API endpoint", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    global.fetch = jest.fn().mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    ) as any;

    const events = await collectEvents(
      service.streamMessage({
        messages: [{ role: "user", content: "Hello", message_id: "msg_1" } as any],
        model: "systemsculpt@@systemsculpt/ai-agent",
      })
    );

    expect(events).toEqual([{ type: "content", text: "Hello" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-license-key": "license",
          Accept: "text/event-stream",
        }),
        body: JSON.stringify({
          model: "systemsculpt/ai-agent",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
          tools: [
            {
              type: "function",
              function: {
                name: "mcp-filesystem_read",
                description: "Read a file from the vault",
                parameters: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                  },
                  required: ["path"],
                },
              },
            },
          ],
        }),
      })
    );
    expect(contextFileService.prepareMessagesWithContext).toHaveBeenCalledWith(
      [{ role: "user", content: "Hello", message_id: "msg_1" }],
      new Set(),
      true,
      AGENT_PRESET.systemPrompt
    );
    expect(mcpService.getAvailableTools).toHaveBeenCalledTimes(1);
  });

  it("routes remote provider models through the remote provider stream executor", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    modelManagementService.getModelInfo.mockResolvedValueOnce({
      isCustom: true,
      actualModelId: "openai/gpt-5.4-mini",
      modelSource: "custom_endpoint",
      model: {
        id: "openrouter@@openai/gpt-5.4-mini",
        provider: "openrouter",
        sourceMode: "custom_endpoint",
        sourceProviderId: "openrouter",
        piExecutionModelId: "openai/gpt-5.4-mini",
        piRemoteAvailable: true,
        piLocalAvailable: false,
        supported_parameters: ["tools"],
      },
    });
    remoteProviderStreamExecutor.executeOpenRouterRemoteStream.mockImplementationOnce(async function* () {
      yield { type: "content", text: "Hello from OpenRouter" };
    });

    const events = await collectEvents(
      service.streamMessage({
        messages: [{ role: "user", content: "Hello remote", message_id: "msg_remote_1" } as any],
        model: "openrouter@@openai/gpt-5.4-mini",
      })
    );

    expect(events).toEqual([{ type: "content", text: "Hello from OpenRouter" }]);
    expect(remoteProviderStreamExecutor.executeOpenRouterRemoteStream).toHaveBeenCalledTimes(1);
    expect(global.fetch).toBeUndefined();
  });

  it("supports hosted text-only requests without tools and forwards reasoning effort", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    global.fetch = jest.fn().mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"Studio"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    ) as any;

    const events = await collectEvents(
      service.streamMessage({
        messages: [{ role: "user", content: "Draft this workflow.", message_id: "msg_studio_1" } as any],
        model: "systemsculpt@@systemsculpt/ai-agent",
        systemPromptOverride: "Studio system prompt",
        allowTools: false,
        reasoningEffort: "high",
      })
    );

    expect(events).toEqual([{ type: "content", text: "Studio" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1/chat/completions",
      expect.objectContaining({
        body: JSON.stringify({
          model: "systemsculpt/ai-agent",
          messages: [{ role: "user", content: "Draft this workflow." }],
          stream: true,
          reasoning_effort: "high",
        }),
      })
    );
    expect(contextFileService.prepareMessagesWithContext).toHaveBeenCalledWith(
      [{ role: "user", content: "Draft this workflow.", message_id: "msg_studio_1" }],
      new Set(),
      true,
      "Studio system prompt"
    );
    expect(mcpService.getAvailableTools).not.toHaveBeenCalled();
  });

  it("serializes response headers for debug.onResponse when streaming hosted chat", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    const debug = {
      onRequest: jest.fn(),
      onResponse: jest.fn(),
      onStreamEnd: jest.fn(),
    };

    (service as any).platformRequestClient.request = jest.fn().mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"Headers"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-systemsculpt-trace": "trace-123",
        },
      })
    );

    const events = await collectEvents(
      service.streamMessage({
        messages: [{ role: "user", content: "Check headers", message_id: "msg_headers_1" } as any],
        model: "systemsculpt@@systemsculpt/ai-agent",
        debug,
      })
    );

    expect(events).toEqual([{ type: "content", text: "Headers" }]);
    expect(debug.onResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        headers: expect.objectContaining({
          "content-type": "text/event-stream",
          "x-systemsculpt-trace": "trace-123",
        }),
      })
    );
  });

  it("routes Pi-local chat turns through the local Pi stream executor", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    const debug = {
      onRequest: jest.fn(),
      onStreamEnd: jest.fn(),
    };
    modelManagementService.getModelInfo.mockResolvedValueOnce({
      isCustom: false,
      actualModelId: "openai/gpt-4.1",
      modelSource: "pi_local",
      model: {
        id: "local-pi-openai@@gpt-4.1",
        provider: "openai",
        sourceMode: "pi_local",
        sourceProviderId: "openai",
        piExecutionModelId: "openai/gpt-4.1",
        piLocalAvailable: true,
        supported_parameters: ["tools"],
      },
    });
    localPiStreamExecutor.executeLocalPiStream.mockImplementation(async function* () {
      yield { type: "content", text: "Pi says hi" };
      yield { type: "meta", key: "stop-reason", value: "stop" };
    });

    const events = await collectEvents(
      service.streamMessage({
        messages: [{ role: "user", content: "Use Pi", message_id: "msg_pi_1" } as any],
        model: "local-pi-openai@@gpt-4.1",
        reasoningEffort: "high",
        sessionFile: "/vault/.pi/sessions/session.jsonl",
        debug,
      })
    );

    expect(events).toEqual([
      { type: "content", text: "Pi says hi" },
      { type: "meta", key: "stop-reason", value: "stop" },
    ]);
    expect(global.fetch).toBeUndefined();
    expect(localPiStreamExecutor.executeLocalPiStream).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin,
        sessionFile: "/vault/.pi/sessions/session.jsonl",
        reasoningEffort: "high",
        prepared: expect.objectContaining({
          actualModelId: "openai/gpt-4.1",
          modelSource: "pi_local",
        }),
      })
    );
    expect(debug.onRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        endpoint: "local-pi-sdk",
        transport: "pi-sdk",
        body: expect.objectContaining({
          model: "openai/gpt-4.1",
          sourceMode: "pi_local",
          session_file: "/vault/.pi/sessions/session.jsonl",
          reasoning_effort: "high",
        }),
      })
    );
    expect(debug.onStreamEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        completed: true,
        aborted: false,
      })
    );
    expect(mcpService.getAvailableTools).not.toHaveBeenCalled();
  });

  it("counts image context files", () => {
    const plugin = createPlugin();
    const imageFile = new TFile({ path: "assets/image.png", name: "image.png", extension: "png" });
    plugin.app.metadataCache.getFirstLinkpathDest = jest.fn((path: string) =>
      path === "image.png" ? imageFile : null
    );

    const service = SystemSculptService.getInstance(plugin);
    const count = (service as any).countImageContextFiles(
      new Set(["[[image.png]]", "doc:example.pdf", "notes.md"])
    );

    expect(count).toBe(1);
  });

  it("delegates license validation, model retrieval, and uploads", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    await service.validateLicense(true);
    await service.getModels();
    await service.uploadDocument(new TFile({ path: "doc.pdf", name: "doc.pdf" }));
    await service.uploadAudio(new TFile({ path: "audio.wav", name: "audio.wav" }));

    expect(licenseService.validateLicense).toHaveBeenCalledWith(true);
    expect(modelManagementService.getModels).toHaveBeenCalled();
    expect(documentUploadService.uploadDocument).toHaveBeenCalled();
    expect(audioUploadService.uploadAudio).toHaveBeenCalled();
  });

  it("fetches credits balance from the SystemSculpt API", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          included_remaining: 9000,
          add_on_remaining: 0,
          total_remaining: 9000,
          included_per_month: 10000,
          cycle_anchor_at: "2026-02-01T00:00:00.000Z",
          cycle_started_at: "2026-02-01T00:00:00.000Z",
          cycle_ends_at: "2026-03-01T00:00:00.000Z",
          turn_in_flight_until: null,
          purchase_url: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as any;

    const balance = await service.getCreditsBalance();

    expect(balance).toMatchObject({
      totalRemaining: 9000,
      includedPerMonth: 10000,
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.systemsculpt.test/api/v1/credits/balance",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-license-key": "license",
        }),
      })
    );
  });

  it("parses annual upgrade savings details from the credits balance", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          included_remaining: 9000,
          add_on_remaining: 0,
          total_remaining: 9000,
          included_per_month: 10000,
          cycle_anchor_at: "2026-02-01T00:00:00.000Z",
          cycle_started_at: "2026-02-01T00:00:00.000Z",
          cycle_ends_at: "2026-03-01T00:00:00.000Z",
          turn_in_flight_until: null,
          purchase_url: null,
          billing_cycle: "monthly",
          annual_upgrade_offer: {
            amount_saved_cents: 12900,
            percent_saved: 57,
            annual_price_cents: 9900,
            monthly_equivalent_annual_cents: 22800,
            checkout_path: "/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as any;

    const balance = await service.getCreditsBalance();

    expect(balance.billingCycle).toBe("monthly");
    expect(balance.annualUpgradeOffer).toEqual({
      amountSavedCents: 12900,
      percentSaved: 57,
      annualPriceCents: 9900,
      monthlyEquivalentAnnualCents: 22800,
      checkoutUrl: "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8",
    });
  });

  it("fetches credits usage history from the SystemSculpt API", async () => {
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "tx_1",
              created_at: "2026-02-11T00:00:00.000Z",
              transaction_type: "agent_turn",
              endpoint: "audio/transcriptions/jobs/start",
              usage_kind: "audio_transcription",
              provider: "groq",
              model: "whisper-large-v3",
              duration_seconds: 23,
              total_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              page_count: 0,
              credits_charged: 3,
              included_delta: -3,
              add_on_delta: 0,
              total_delta: -3,
              included_before: 100,
              included_after: 97,
              add_on_before: 0,
              add_on_after: 0,
              total_before: 100,
              total_after: 97,
              raw_usd: 0.002553,
              file_size_bytes: 48203,
              file_format: "wav",
              billing_formula_version: "raw_usd_x_markup_x_credits_per_usd.ceil.v1",
              billing_credits_per_usd: 800,
              billing_markup_multiplier: 1.25,
              billing_credits_exact: 2.553,
            },
          ],
          next_before: "2026-02-11T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as any;

    const usage = await service.getCreditsUsage({
      limit: 25,
      before: "2026-02-12T00:00:00.000Z",
      endpoints: ["audio/transcriptions/jobs/start"],
    });

    expect(usage.items).toHaveLength(1);
    expect(usage.items[0]).toMatchObject({
      endpoint: "audio/transcriptions/jobs/start",
      creditsCharged: 3,
      rawUsd: 0.002553,
      billingCreditsExact: 2.553,
    });
    expect((usage.items[0] as any)?.provider).toBeUndefined();
    expect((usage.items[0] as any)?.model).toBeUndefined();
    expect(usage.nextBefore).toBe("2026-02-11T00:00:00.000Z");
  });

  it("uses the development-aware API base url helper", () => {
    (SystemSculptEnvironment.resolveBaseUrl as jest.Mock).mockReturnValueOnce(
      "https://api.systemsculpt.test/api/v1"
    );
    const plugin = createPlugin();
    const service = SystemSculptService.getInstance(plugin);
    expect(service.baseUrl).toBe("https://api.systemsculpt.test/api/v1");
  });
});
