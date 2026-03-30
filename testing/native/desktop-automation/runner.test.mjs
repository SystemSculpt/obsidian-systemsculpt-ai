import test from "node:test";
import assert from "node:assert/strict";
import {
  assertHealthyStatus,
  BASELINE_SUITE_CASE,
  CHATVIEW_STRESS_CASE,
  MANAGED_BASELINE_CASE,
  PROVIDER_CONNECTED_BASELINE_CASE,
  SETUP_BASELINE_CASE,
  buildBaselineSummary,
  caseList,
  isTransientModelExecutionError,
  resolveBootstrapReload,
  runChatExactCase,
  runManagedBaselineCase,
  runProviderConnectedBaselineCase,
  runChatViewStressCase,
  runModelSwitchCase,
  runCase,
  runReloadStressCase,
  runSetupBaselineCase,
} from "./runner.mjs";
import { findProviderModelOption } from "../shared/model-inventory.mjs";

function buildHealthyStatus(startedAt, options = {}) {
  return {
    bridge: {
      host: "127.0.0.1",
      port: options.port || 62001,
      startedAt,
      discoveryFilePath: options.discoveryFilePath || "/tmp/bridge.json",
      reload: {
        scheduled: Boolean(options.reloadScheduled),
        inFlight: Boolean(options.reloadInFlight),
        requestedAt: options.requestedAt || null,
      },
    },
    ui: {
      pluginStatusBarClass: "plugin-systemsculpt-ai",
      pluginStatusBarItemCount: options.pluginStatusBarItemCount ?? 1,
      embeddingsStatusBarItemCount: options.embeddingsStatusBarItemCount ?? 1,
      embeddingsStatusBarTexts: ["Embeddings: 6.5k/6.5k"],
    },
    chat: {
      selectedModelId: options.selectedModelId ?? null,
      currentModelName: options.currentModelName ?? null,
    },
  };
}

test("caseList resolves stress aliases to the dedicated reload stress case", () => {
  assert.deepEqual(caseList("stress"), ["reload-stress"]);
  assert.deepEqual(caseList("reload-stress"), ["reload-stress"]);
  assert.deepEqual(caseList(CHATVIEW_STRESS_CASE), [CHATVIEW_STRESS_CASE]);
  assert.deepEqual(caseList(SETUP_BASELINE_CASE), [SETUP_BASELINE_CASE]);
  assert.deepEqual(caseList(BASELINE_SUITE_CASE), [
    MANAGED_BASELINE_CASE,
    PROVIDER_CONNECTED_BASELINE_CASE,
  ]);
  assert.deepEqual(caseList(MANAGED_BASELINE_CASE), [MANAGED_BASELINE_CASE]);
  assert.deepEqual(caseList(PROVIDER_CONNECTED_BASELINE_CASE), [PROVIDER_CONNECTED_BASELINE_CASE]);
  assert.deepEqual(caseList("soak"), ["reload-stress", CHATVIEW_STRESS_CASE]);
});

test("resolveBootstrapReload skips the implicit bootstrap reload for stress runs", () => {
  assert.equal(resolveBootstrapReload({ caseName: "stress", reload: true }), false);
  assert.equal(resolveBootstrapReload({ caseName: "reload-stress", reload: true }), false);
  assert.equal(resolveBootstrapReload({ caseName: "extended", reload: true }), true);
  assert.equal(resolveBootstrapReload({ caseName: "stress", reload: false }), false);
});

test("assertHealthyStatus fails when duplicate status bar items are detected", () => {
  assert.throws(
    () =>
      assertHealthyStatus(
        buildHealthyStatus("2026-03-28T02:00:00.000Z", {
          pluginStatusBarItemCount: 2,
          embeddingsStatusBarItemCount: 2,
        }),
        "After reload"
      ),
    /After reload plugin status bar item count expected "1" but got "2"/
  );
});

test("buildBaselineSummary surfaces one combined baselines verdict", () => {
  const summary = buildBaselineSummary(
    {
      [MANAGED_BASELINE_CASE]: {
        hostedTurn: { token: "WINDOWS_MANAGED_BASELINE_1" },
        recoveryTurn: null,
        transientFailures: [{ phase: "recovery" }],
      },
      [PROVIDER_CONNECTED_BASELINE_CASE]: {
        provider: { providerId: "openrouter" },
        providerModel: { modelId: "local-pi-openrouter@@openai/gpt-5.4-mini" },
        providerTurn: { token: "PROVIDER_CONNECTED_OPENROUTER_1" },
        recoverySelection: {
          selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
        },
      },
    },
    {
      chat: {
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      },
    }
  );

  assert.equal(summary?.ok, true);
  assert.equal(summary?.managed.hostedTurnOk, true);
  assert.equal(summary?.managed.recoveryTurnOk, false);
  assert.equal(summary?.managed.transientFailureCount, 1);
  assert.equal(summary?.provider.connectedOk, true);
  assert.equal(summary?.provider.providerId, "openrouter");
  assert.equal(summary?.provider.modelId, "local-pi-openrouter@@openai/gpt-5.4-mini");
  assert.equal(summary?.provider.recoverySelectionOk, true);
  assert.equal(summary?.finalManagedSelectionOk, true);
});

test("isTransientModelExecutionError treats generic provider-side upstream failures as transient", () => {
  assert.equal(isTransientModelExecutionError(new Error("Provider returned error")), true);
  assert.equal(
    isTransientModelExecutionError(
      new Error("Provider returned error moonshotai/kimi-k2.5 is temporarily rate-limited upstream.")
    ),
    true
  );
  assert.equal(isTransientModelExecutionError(new Error("This operation was aborted")), true);
  assert.equal(
    isTransientModelExecutionError(new Error("Timed out waiting for providers settings panel.")),
    true
  );
  assert.equal(isTransientModelExecutionError(new Error("Invalid API key")), false);
});

test("findProviderModelOption can prefer a stable provider model by canonical suffix", () => {
  const inventory = {
    options: [
      {
        value: "openrouter@@moonshotai/kimi-k2.5",
        label: "Kimi K2.5",
        providerAuthenticated: true,
        providerId: "openrouter",
        section: "local",
      },
      {
        value: "local-pi-openrouter@@openai/gpt-5.4-mini",
        label: "GPT-5.4 Mini",
        providerAuthenticated: true,
        providerId: "openrouter",
        section: "local",
        piExecutionModelId: "openrouter/openai/gpt-5.4-mini",
      },
    ],
  };

  assert.equal(
    findProviderModelOption(inventory, "openrouter", {
      authenticated: true,
      preferredModelIds: ["openai/gpt-5.4-mini"],
    })?.value,
    "local-pi-openrouter@@openai/gpt-5.4-mini"
  );
  assert.equal(
    findProviderModelOption(inventory, "openrouter", {
      authenticated: true,
      preferredModelIds: ["gpt-5.4-mini"],
    })?.value,
    "local-pi-openrouter@@openai/gpt-5.4-mini"
  );
});

test("runReloadStressCase waits for a new stable bridge generation and preserves health", async () => {
  const previousStartedAt = "2026-03-28T02:00:00.000Z";
  const nextStartedAt = "2026-03-28T02:00:05.000Z";
  const currentClient = {
    baseUrl: "http://127.0.0.1:62001",
    record: {
      host: "127.0.0.1",
      port: 62001,
      startedAt: previousStartedAt,
      discoveryFilePath: "/tmp/old.json",
    },
    async status() {
      return buildHealthyStatus(previousStartedAt, {
        port: 62001,
        discoveryFilePath: "/tmp/old.json",
      });
    },
    async reloadPlugin() {
      return {
        scheduled: true,
        alreadyScheduled: false,
        requestedAt: "2026-03-28T02:00:01.000Z",
      };
    },
  };

  const nextStatuses = [
    buildHealthyStatus(nextStartedAt, {
      port: 62002,
      discoveryFilePath: "/tmp/new.json",
    }),
    buildHealthyStatus(nextStartedAt, {
      port: 62002,
      discoveryFilePath: "/tmp/new.json",
      selectedModelId: "model-a",
      currentModelName: "Model A",
    }),
    buildHealthyStatus(nextStartedAt, {
      port: 62002,
      discoveryFilePath: "/tmp/new.json",
      selectedModelId: "model-b",
      currentModelName: "Model B",
    }),
  ];
  const nextClient = {
    baseUrl: "http://127.0.0.1:62002",
    record: {
      host: "127.0.0.1",
      port: 62002,
      startedAt: nextStartedAt,
      discoveryFilePath: "/tmp/new.json",
    },
    async status() {
      const nextStatus = nextStatuses.shift();
      if (!nextStatus) {
        throw new Error("Unexpected extra status request.");
      }
      return nextStatus;
    },
  };

  let waitArgs = null;
  const outcome = await runReloadStressCase(currentClient, {
    vaultName: "automation-vault",
    vaultPath: "/tmp/automation-vault",
    waitForStableClient: async (args) => {
      waitArgs = args;
      return nextClient;
    },
    runModelSwitchCase: async (client) => {
      assert.equal(client, nextClient);
      return {
        switches: [
          { modelId: "model-a", label: "Model A" },
          { modelId: "model-b", label: "Model B" },
        ],
      };
    },
    runChatExactCase: async (client) => {
      assert.equal(client, nextClient);
      return {
        selectedModelId: "model-b",
        currentModelName: "Model B",
        response: "DESKTOP_CHAT_EXACT_123",
      };
    },
  });

  assert.equal(outcome.client, nextClient);
  assert.equal(waitArgs.excludeStartedAt, previousStartedAt);
  assert.equal(waitArgs.vaultName, "automation-vault");
  assert.equal(outcome.result.reload.previousStartedAt, previousStartedAt);
  assert.equal(outcome.result.reload.nextStartedAt, nextStartedAt);
  assert.equal(outcome.result.reload.nextBaseUrl, "http://127.0.0.1:62002");
  assert.equal(outcome.result.health.afterReload.ui.pluginStatusBarItemCount, 1);
  assert.equal(outcome.result.health.afterChatExact.chat.selectedModelId, "model-b");
  assert.equal(nextStatuses.length, 0);
});

test("runReloadStressCase fails when the bridge generation does not change after reload", async () => {
  const startedAt = "2026-03-28T02:10:00.000Z";
  const currentClient = {
    baseUrl: "http://127.0.0.1:62001",
    record: {
      host: "127.0.0.1",
      port: 62001,
      startedAt,
      discoveryFilePath: "/tmp/old.json",
    },
    async status() {
      return buildHealthyStatus(startedAt, {
        port: 62001,
        discoveryFilePath: "/tmp/old.json",
      });
    },
    async reloadPlugin() {
      return {
        scheduled: true,
        alreadyScheduled: false,
        requestedAt: "2026-03-28T02:10:01.000Z",
      };
    },
  };
  const nextClient = {
    baseUrl: "http://127.0.0.1:62001",
    record: {
      host: "127.0.0.1",
      port: 62001,
      startedAt,
      discoveryFilePath: "/tmp/old.json",
    },
    async status() {
      return buildHealthyStatus(startedAt, {
        port: 62001,
        discoveryFilePath: "/tmp/old.json",
      });
    },
  };

  await assert.rejects(
    runReloadStressCase(currentClient, {
      vaultName: "automation-vault",
      vaultPath: "/tmp/automation-vault",
      waitForStableClient: async () => nextClient,
      runModelSwitchCase: async () => ({ switches: [] }),
      runChatExactCase: async () => ({ response: "unused" }),
    }),
    /expected a new bridge generation after reload/
  );
});

test("runChatViewStressCase exercises chat churn on a single automation leaf", async () => {
  const primaryModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const secondaryModel = {
    value: "local-pi-github-copilot@@claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    providerAuthenticated: true,
    providerId: "local-pi-github-copilot",
    providerLabel: "GitHub Copilot",
    section: "pi",
  };

  let currentChatId = "";
  let currentLeafId = "leaf-automation";
  let currentMessageCount = 0;
  let currentModelId = primaryModel.value;
  let webSearchEnabled = false;
  let approvalMode = "interactive";
  let inputValue = "";
  const messages = [];

  const client = {
    async listModels() {
      return {
        selectedModelId: primaryModel.value,
        options: [primaryModel, secondaryModel],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.reset) {
        currentChatId = "";
        currentMessageCount = 0;
        messages.length = 0;
        currentModelId = body.selectedModelId || currentModelId;
      }
      return {
        leafId: currentLeafId,
        chatId: currentChatId,
        selectedModelId: currentModelId,
        messageCount: currentMessageCount,
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [...messages],
      };
    },
    async getChatSnapshot() {
      return {
        leafId: currentLeafId,
        chatId: currentChatId,
        selectedModelId: currentModelId,
        messageCount: currentMessageCount,
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [...messages],
      };
    },
    async setInput(text) {
      inputValue = String(text || "");
      return await this.getChatSnapshot();
    },
    async setWebSearch(enabled) {
      webSearchEnabled = !!enabled;
      return await this.getChatSnapshot();
    },
    async setApprovalMode(mode) {
      approvalMode = mode;
      return await this.getChatSnapshot();
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return await this.getChatSnapshot();
    },
    async sendChat(body = {}) {
      const previousApprovalMode = approvalMode;
      if (typeof body.webSearchEnabled === "boolean") {
        webSearchEnabled = body.webSearchEnabled;
      }
      if (body.approvalMode) {
        approvalMode = body.approvalMode;
      }

      const tokenMatch = String(inputValue || body.text || "").match(/(DESKTOP_CHATVIEW_STRESS_[A-Z]_\d+)/);
      const token = tokenMatch?.[1] || "DESKTOP_CHATVIEW_STRESS_UNKNOWN";
      if (!currentChatId) {
        currentChatId = `chat-${token}`;
      }

      messages.push({ role: "user", content: String(inputValue || body.text || "") });
      messages.push({ role: "assistant", content: token });
      currentMessageCount = messages.length;
      inputValue = "";
      approvalMode = previousApprovalMode;

      return {
        leafId: currentLeafId,
        chatId: currentChatId,
        selectedModelId: currentModelId,
        messageCount: currentMessageCount,
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [...messages],
      };
    },
  };

  const outcome = await runChatViewStressCase(client);

  assert.equal(outcome.primaryModel.modelId, primaryModel.value);
  assert.equal(outcome.secondaryModel.modelId, secondaryModel.value);
  assert.equal(outcome.leafId, currentLeafId);
  assert.equal(outcome.transientSkips.length, 0);
  assert.equal(outcome.transcriptPreservedAcrossModelSwitch, true);
  assert.equal(outcome.messageCounts.first, 2);
  assert.equal(outcome.messageCounts.second, 4);
  assert.equal(outcome.messageCounts.fresh, 2);
  assert.ok(String(outcome.firstChatId).startsWith("chat-DESKTOP_CHATVIEW_STRESS_A_"));
  assert.ok(String(outcome.freshChatId).startsWith("chat-DESKTOP_CHATVIEW_STRESS_C_"));
});

test("runChatExactCase works with a single authenticated model", async () => {
  const primaryModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };

  let currentModelId = primaryModel.value;
  let webSearchEnabled = false;
  let approvalMode = "interactive";
  let inputValue = "";

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [primaryModel],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return await this.getChatSnapshot();
    },
    async getChatSnapshot() {
      return {
        selectedModelId: currentModelId,
        currentModelName: "SystemSculpt Agent",
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [],
      };
    },
    async setInput(text) {
      inputValue = String(text || "");
      return await this.getChatSnapshot();
    },
    async setWebSearch(enabled) {
      webSearchEnabled = Boolean(enabled);
      return await this.getChatSnapshot();
    },
    async setApprovalMode(mode) {
      approvalMode = mode;
      return await this.getChatSnapshot();
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return await this.getChatSnapshot();
    },
    async sendChat() {
      const token = String(inputValue || "").replace("Reply with exactly ", "");
      inputValue = "";
      return {
        selectedModelId: currentModelId,
        currentModelName: "SystemSculpt Agent",
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runChatExactCase(client);
  assert.match(outcome.response, /DESKTOP_CHAT_EXACT_/);
  assert.equal(outcome.selectedModelId, primaryModel.value);
  assert.equal(outcome.currentModelName, "SystemSculpt Agent");
});

test("runModelSwitchCase falls back to the unavailable OpenRouter Pi model when only one authenticated model exists", async () => {
  const primaryModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const fallbackModel = {
    value: "local-pi-openrouter@@openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerAuthenticated: false,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "pi",
  };

  let currentModelId = primaryModel.value;
  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [primaryModel, fallbackModel],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (currentModelId === fallbackModel.value) {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const token = String(body.text || "").replace("Reply with this exact token and nothing else: ", "");
      return {
        selectedModelId: currentModelId,
        currentModelName: "SystemSculpt Agent",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runModelSwitchCase(client, {
    allowSingleModelFallback: true,
  });

  assert.equal(outcome.switches.length, 3);
  assert.equal(outcome.switches[0].modelId, primaryModel.value);
  assert.equal(outcome.switches[1].modelId, fallbackModel.value);
  assert.match(outcome.switches[1].error, /Providers/i);
  assert.equal(outcome.switches[2].modelId, primaryModel.value);
  assert.match(outcome.singleModelFallback.recoveryTurn.response, /DESKTOP_SINGLE_MODEL_RECOVERY_/);
});

test("runChatViewStressCase falls back to the unavailable OpenRouter Pi model on fresh Windows", async () => {
  const primaryModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const fallbackModel = {
    value: "local-pi-openrouter@@openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerAuthenticated: false,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "pi",
  };

  let currentChatId = "";
  let currentLeafId = "leaf-automation";
  let currentMessageCount = 0;
  let currentModelId = primaryModel.value;
  let webSearchEnabled = false;
  let approvalMode = "interactive";
  let inputValue = "";
  const messages = [];

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [primaryModel, fallbackModel],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.reset) {
        currentChatId = "";
        currentMessageCount = 0;
        messages.length = 0;
        currentModelId = body.selectedModelId || currentModelId;
      } else if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        leafId: currentLeafId,
        chatId: currentChatId,
        selectedModelId: currentModelId,
        messageCount: currentMessageCount,
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [...messages],
      };
    },
    async getChatSnapshot() {
      return {
        leafId: currentLeafId,
        chatId: currentChatId,
        selectedModelId: currentModelId,
        messageCount: currentMessageCount,
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [...messages],
      };
    },
    async setInput(text) {
      inputValue = String(text || "");
      return await this.getChatSnapshot();
    },
    async setWebSearch(enabled) {
      webSearchEnabled = !!enabled;
      return await this.getChatSnapshot();
    },
    async setApprovalMode(mode) {
      approvalMode = mode;
      return await this.getChatSnapshot();
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return await this.getChatSnapshot();
    },
    async sendChat(body = {}) {
      if (currentModelId === fallbackModel.value) {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const previousApprovalMode = approvalMode;
      if (typeof body.webSearchEnabled === "boolean") {
        webSearchEnabled = body.webSearchEnabled;
      }
      if (body.approvalMode) {
        approvalMode = body.approvalMode;
      }

      const tokenMatch = String(inputValue || body.text || "").match(/(DESKTOP_CHATVIEW_STRESS_[A-Z]_\d+)/);
      const token = tokenMatch?.[1] || "DESKTOP_CHATVIEW_STRESS_UNKNOWN";
      if (!currentChatId) {
        currentChatId = `chat-${token}`;
      }

      messages.push({ role: "user", content: String(inputValue || body.text || "") });
      messages.push({ role: "assistant", content: token });
      currentMessageCount = messages.length;
      inputValue = "";
      approvalMode = previousApprovalMode;

      return {
        leafId: currentLeafId,
        chatId: currentChatId,
        selectedModelId: currentModelId,
        messageCount: currentMessageCount,
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [...messages],
      };
    },
  };

  const outcome = await runChatViewStressCase(client, {
    allowSingleModelFallback: true,
  });

  assert.equal(outcome.primaryModel.modelId, primaryModel.value);
  assert.equal(outcome.secondaryModel.modelId, fallbackModel.value);
  assert.equal(outcome.singleModelFallback, true);
  assert.equal(outcome.leafId, currentLeafId);
  assert.equal(outcome.transientSkips.length, 0);
  assert.equal(outcome.transcriptPreservedAcrossModelSwitch, true);
  assert.equal(outcome.messageCounts.first, 2);
  assert.equal(outcome.messageCounts.blocked, 2);
  assert.equal(outcome.messageCounts.second, 4);
  assert.equal(outcome.messageCounts.fresh, 2);
  assert.match(outcome.blockedFallback.error, /Providers/i);
  assert.ok(String(outcome.firstChatId).startsWith("chat-DESKTOP_CHATVIEW_STRESS_A_"));
  assert.ok(String(outcome.freshChatId).startsWith("chat-DESKTOP_CHATVIEW_STRESS_C_"));
});

test("runChatViewStressCase ignores authenticated local models when local Pi is disallowed", async () => {
  const primaryModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const staleLocalModel = {
    value: "local-pi-google@@gemini-1.5-flash",
    label: "Gemini 1.5 Flash",
    providerAuthenticated: true,
    providerId: "google",
    providerLabel: "Google Gemini",
    section: "local",
  };
  const fallbackModel = {
    value: "local-pi-openrouter@@openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerAuthenticated: false,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "local",
  };

  let currentModelId = staleLocalModel.value;
  let currentLeafId = "leaf-windows";
  let currentChatId = "";
  let currentMessageCount = 0;
  let inputValue = "";
  let webSearchEnabled = false;
  let approvalMode = "interactive";
  let messages = [];

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [primaryModel, staleLocalModel, fallbackModel],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.reset) {
        currentChatId = "";
        currentMessageCount = 0;
        messages = [];
      }
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return await this.getChatSnapshot();
    },
    async getChatSnapshot() {
      return {
        leafId: currentLeafId,
        chatId: currentChatId,
        selectedModelId: currentModelId,
        messageCount: currentMessageCount,
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [...messages],
      };
    },
    async setInput(text) {
      inputValue = String(text || "");
      return await this.getChatSnapshot();
    },
    async setWebSearch(enabled) {
      webSearchEnabled = Boolean(enabled);
      return await this.getChatSnapshot();
    },
    async setApprovalMode(mode) {
      approvalMode = mode;
      return await this.getChatSnapshot();
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return await this.getChatSnapshot();
    },
    async sendChat(body = {}) {
      if (currentModelId !== primaryModel.value) {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const previousApprovalMode = approvalMode;
      if (typeof body.webSearchEnabled === "boolean") {
        webSearchEnabled = body.webSearchEnabled;
      }
      if (body.approvalMode) {
        approvalMode = body.approvalMode;
      }

      const tokenMatch = String(inputValue || body.text || "").match(/(DESKTOP_CHATVIEW_STRESS_[A-Z]_\d+)/);
      const token = tokenMatch?.[1] || "DESKTOP_CHATVIEW_STRESS_UNKNOWN";
      if (!currentChatId) {
        currentChatId = `chat-${token}`;
      }

      messages.push({ role: "user", content: String(inputValue || body.text || "") });
      messages.push({ role: "assistant", content: token });
      currentMessageCount = messages.length;
      inputValue = "";
      approvalMode = previousApprovalMode;

      return {
        leafId: currentLeafId,
        chatId: currentChatId,
        selectedModelId: currentModelId,
        messageCount: currentMessageCount,
        input: {
          value: inputValue,
          webSearchEnabled,
          approvalMode,
        },
        messages: [...messages],
      };
    },
  };

  const outcome = await runChatViewStressCase(client, {
    allowSingleModelFallback: true,
    allowLocalPi: false,
  });

  assert.equal(outcome.primaryModel.modelId, primaryModel.value);
  assert.equal(outcome.secondaryModel.modelId, fallbackModel.value);
  assert.equal(outcome.singleModelFallback, true);
  assert.match(outcome.blockedFallback.error, /Providers/i);
});

test("runSetupBaselineCase proves fresh-install setup guidance without hosted auth", async () => {
  let currentModelId = "systemsculpt@@systemsculpt/ai-agent";
  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [
          {
            value: "systemsculpt@@systemsculpt/ai-agent",
            label: "SystemSculpt Agent",
            providerAuthenticated: false,
            providerLabel: "SystemSculpt",
            section: "systemsculpt",
          },
        ],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat() {
      if (currentModelId === "systemsculpt@@systemsculpt/ai-agent") {
        throw new Error("Activate your SystemSculpt license in Account before starting a chat.");
      }

      throw new Error(
        "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
      );
    },
  };

  const outcome = await runSetupBaselineCase(client);
  assert.equal(outcome.availableModelCount, 1);
  assert.equal(outcome.readyModelCount, 0);
  assert.match(outcome.setupRequired.account, /Account/i);
  assert.match(outcome.setupRequired.providers, /Providers/i);
});

test("runManagedBaselineCase proves managed hosted chat and local Pi failure recovery", async () => {
  let currentModelId = "systemsculpt@@systemsculpt/ai-agent";
  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [
          {
            value: "systemsculpt@@systemsculpt/ai-agent",
            label: "SystemSculpt Agent",
            providerAuthenticated: true,
            providerLabel: "SystemSculpt",
            section: "systemsculpt",
          },
        ],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (currentModelId !== "systemsculpt@@systemsculpt/ai-agent") {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const token = String(body.text || "").replace("Reply with this exact token and nothing else: ", "");
      return {
        selectedModelId: currentModelId,
        currentModelName: "SystemSculpt Agent",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runManagedBaselineCase(client);
  assert.equal(outcome.availableModelCount, 1);
  assert.equal(outcome.readyModelCount, 1);
  assert.match(outcome.hostedTurn.response, /WINDOWS_MANAGED_BASELINE_/);
  assert.match(outcome.blockedLocalPi.error, /Providers/i);
  assert.match(outcome.recoveryTurn.response, /WINDOWS_MANAGED_RECOVERY_/);
});

test("runManagedBaselineCase exercises the authenticated OpenRouter Pi model when it is available", async () => {
  let currentModelId = "systemsculpt@@systemsculpt/ai-agent";
  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [
          {
            value: "systemsculpt@@systemsculpt/ai-agent",
            label: "SystemSculpt Agent",
            providerAuthenticated: true,
            providerLabel: "SystemSculpt",
            section: "systemsculpt",
          },
          {
            value: "local-pi-openrouter@@openai/gpt-5.4-mini",
            label: "GPT-5.4 Mini",
            providerAuthenticated: true,
            providerId: "openrouter",
            providerLabel: "OpenRouter",
            section: "pi",
          },
        ],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      const token = String(body.text || "").replace("Reply with this exact token and nothing else: ", "");
      return {
        selectedModelId: currentModelId,
        currentModelName:
          currentModelId === "systemsculpt@@systemsculpt/ai-agent"
            ? "SystemSculpt Agent"
            : "GPT-5.4 Mini",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runManagedBaselineCase(client);
  assert.match(outcome.hostedTurn.response, /WINDOWS_MANAGED_BASELINE_/);
  assert.equal(outcome.localPiModel?.modelId, "local-pi-openrouter@@openai/gpt-5.4-mini");
  assert.match(outcome.localPiTurn?.response || "", /DESKTOP_PI_BASELINE_/);
  assert.equal(outcome.blockedLocalPi, null);
  assert.match(outcome.recoveryTurn.response, /WINDOWS_MANAGED_RECOVERY_/);
});

test("runManagedBaselineCase retries transient hosted failures before succeeding", async () => {
  let currentModelId = "systemsculpt@@systemsculpt/ai-agent";
  let transientFailuresRemaining = 1;
  let managedSendAttempts = 0;
  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [
          {
            value: "systemsculpt@@systemsculpt/ai-agent",
            label: "SystemSculpt Agent",
            providerAuthenticated: true,
            providerLabel: "SystemSculpt",
            section: "systemsculpt",
          },
        ],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (currentModelId !== "systemsculpt@@systemsculpt/ai-agent") {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      managedSendAttempts += 1;
      if (transientFailuresRemaining > 0) {
        transientFailuresRemaining -= 1;
        throw new Error(
          "Provider returned error moonshotai/kimi-k2.5 is temporarily rate-limited upstream. Please retry shortly."
        );
      }

      const token = String(body.text || "").replace("Reply with this exact token and nothing else: ", "");
      return {
        selectedModelId: currentModelId,
        currentModelName: "SystemSculpt Agent",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runManagedBaselineCase(client);
  assert.equal(managedSendAttempts, 3);
  assert.equal(outcome.hostedTurn.transientRetries.length, 1);
  assert.match(outcome.hostedTurn.transientRetries[0].error, /rate-limited upstream/i);
  assert.match(outcome.hostedTurn.response, /WINDOWS_MANAGED_BASELINE_/);
  assert.match(outcome.recoveryTurn.response, /WINDOWS_MANAGED_RECOVERY_/);
});

test("runManagedBaselineCase can recover when the first managed turn stays transiently throttled", async () => {
  let currentModelId = "systemsculpt@@systemsculpt/ai-agent";
  let transientFailuresRemaining = 3;
  let managedSendAttempts = 0;
  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [
          {
            value: "systemsculpt@@systemsculpt/ai-agent",
            label: "SystemSculpt Agent",
            providerAuthenticated: true,
            providerLabel: "SystemSculpt",
            section: "systemsculpt",
          },
        ],
      };
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (currentModelId !== "systemsculpt@@systemsculpt/ai-agent") {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      managedSendAttempts += 1;
      if (transientFailuresRemaining > 0) {
        transientFailuresRemaining -= 1;
        throw new Error(
          "Provider returned error moonshotai/kimi-k2.5 is temporarily rate-limited upstream. Please retry shortly."
        );
      }

      const token = String(body.text || "").replace("Reply with this exact token and nothing else: ", "");
      return {
        selectedModelId: currentModelId,
        currentModelName: "SystemSculpt Agent",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runManagedBaselineCase(client);
  assert.equal(managedSendAttempts, 4);
  assert.equal(outcome.hostedTurn, null);
  assert.equal(outcome.recoveryTurn?.transientRetries.length, 0);
  assert.equal(outcome.transientFailures.length, 1);
  assert.equal(outcome.transientFailures[0].phase, "hosted");
  assert.match(outcome.transientFailures[0].error, /rate-limited upstream/i);
  assert.match(outcome.recoveryTurn?.response || "", /WINDOWS_MANAGED_RECOVERY_/);
});

test("runProviderConnectedBaselineCase drives provider auth through settings and recovers cleanly", async () => {
  const managedModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const providerReadyModel = {
    value: "openai@@gpt-4.1",
    label: "GPT-4.1",
    providerAuthenticated: true,
    providerId: "openai",
    providerLabel: "OpenAI",
    section: "local",
  };
  const providerSetupModel = {
    ...providerReadyModel,
    providerAuthenticated: false,
  };

  let currentModelId = managedModel.value;
  let providerConnected = false;
  let hasStoredCredential = false;

  function buildProvidersSnapshot() {
    return {
      settings: {
        settingsModalOpen: true,
        pluginSettingsOpen: true,
        activePluginTabId: "providers",
      },
      ui: {
        panelVisible: true,
        rowCount: 1,
      },
      providers: {
        rowCount: 1,
        rows: [
          {
            providerId: "openai",
            label: "OpenAI",
            source: providerConnected ? "api_key" : "none",
            credentialType: providerConnected ? "api_key" : "none",
            isLocalProvider: false,
            apiKeyEnvVar: "OPENAI_API_KEY",
            oauthEnabled: true,
            apiKeyEnabled: true,
            hasAnyAuth: providerConnected,
            hasStoredCredential,
            display: {
              ready: providerConnected,
              connected: providerConnected,
              blocked: false,
              tone: providerConnected ? "connected" : "disconnected",
              summary: providerConnected ? "Connected via API key" : "Not connected",
            },
          },
        ],
      },
    };
  }

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [managedModel, providerConnected ? providerReadyModel : providerSetupModel],
      };
    },
    async getProvidersSnapshot() {
      return buildProvidersSnapshot();
    },
    async clearProviderAuth(providerId) {
      assert.equal(providerId, "openai");
      providerConnected = false;
      hasStoredCredential = false;
      return buildProvidersSnapshot();
    },
    async setProviderApiKey(providerId, apiKey) {
      assert.equal(providerId, "openai");
      assert.equal(apiKey, "sk-provider");
      providerConnected = true;
      hasStoredCredential = true;
      return buildProvidersSnapshot();
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (currentModelId === providerReadyModel.value && !providerConnected) {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const token = String(body.text || "").replace(
        "Reply with this exact token and nothing else: ",
        ""
      );
      return {
        selectedModelId: currentModelId,
        currentModelName:
          currentModelId === managedModel.value ? "SystemSculpt Agent" : "GPT-4.1",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runProviderConnectedBaselineCase(client, {
    env: {
      SYSTEMSCULPT_DESKTOP_PROVIDER_ID: "openai",
      SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY: "sk-provider",
    },
  });

  assert.equal(outcome.availableModelCount, 2);
  assert.equal(outcome.readyModelCount, 1);
  assert.equal(outcome.candidateCount, 1);
  assert.deepEqual(outcome.attemptedCandidateIds, ["openai"]);
  assert.equal(outcome.provider.providerId, "openai");
  assert.equal(outcome.provider.credentialSource, "SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY");
  assert.equal(outcome.providerModel.modelId, providerReadyModel.value);
  assert.match(outcome.providerTurn.response, /PROVIDER_CONNECTED_OPENAI_/);
  assert.match(outcome.blockedProviderSend.error, /Providers/i);
  assert.equal(outcome.blockedProviderSend.matchedProviderTurnModelId, true);
  assert.equal(outcome.recoverySelection.selectedModelId, managedModel.value);
  assert.equal(outcome.providerStates.beforeConnect.source, "none");
  assert.equal(outcome.providerStates.connected.source, "api_key");
  assert.equal(outcome.providerStates.afterClear.source, "none");
});

test("runProviderConnectedBaselineCase skips a redundant managed precheck before provider auth", async () => {
  const managedModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const providerReadyModel = {
    value: "openrouter@@openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerAuthenticated: true,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "local",
  };
  const providerSetupModel = {
    ...providerReadyModel,
    providerAuthenticated: false,
  };

  let currentModelId = managedModel.value;
  let providerConnected = false;
  let managedSendCount = 0;

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [managedModel, providerConnected ? providerReadyModel : providerSetupModel],
      };
    },
    async getProvidersSnapshot() {
      return {
        settings: {
          settingsModalOpen: true,
          pluginSettingsOpen: true,
          activePluginTabId: "providers",
        },
        ui: {
          panelVisible: true,
        },
        providers: {
          rowCount: 1,
          rows: [
            {
              providerId: "openrouter",
              label: "OpenRouter",
              source: providerConnected ? "api_key" : "none",
              credentialType: providerConnected ? "api_key" : "none",
              isLocalProvider: false,
              apiKeyEnvVar: "OPENROUTER_API_KEY",
              oauthEnabled: true,
              apiKeyEnabled: true,
              hasAnyAuth: providerConnected,
              hasStoredCredential: providerConnected,
              display: {
                ready: providerConnected,
                connected: providerConnected,
                blocked: false,
                tone: providerConnected ? "connected" : "disconnected",
                summary: providerConnected ? "Connected via API key" : "Not connected",
              },
            },
          ],
        },
      };
    },
    async clearProviderAuth() {
      providerConnected = false;
      return await this.getProvidersSnapshot();
    },
    async setProviderApiKey(providerId, apiKey) {
      assert.equal(providerId, "openrouter");
      assert.equal(apiKey, "sk-openrouter");
      providerConnected = true;
      return await this.getProvidersSnapshot();
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (!providerConnected && currentModelId === providerReadyModel.value) {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const token = String(body.text || "").replace(
        "Reply with this exact token and nothing else: ",
        ""
      );
      if (currentModelId === managedModel.value) {
        managedSendCount += 1;
      }
      return {
        selectedModelId: currentModelId,
        currentModelName:
          currentModelId === managedModel.value ? "SystemSculpt Agent" : "GPT-5.4 Mini",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runProviderConnectedBaselineCase(client, {
    env: {
      SYSTEMSCULPT_DESKTOP_PROVIDER_ID: "openrouter",
      SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY: "sk-openrouter",
    },
  });

  assert.equal(outcome.provider.providerId, "openrouter");
  assert.equal(outcome.providerTurn.model.modelId, providerReadyModel.value);
  assert.match(outcome.providerTurn.response, /PROVIDER_CONNECTED_OPENROUTER_/);
  assert.equal(outcome.recoverySelection.selectedModelId, managedModel.value);
  assert.equal(managedSendCount, 0);
});

test("runProviderConnectedBaselineCase prefers OpenRouter first and falls back to environment auth after clearing API-key state", async () => {
  const managedModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const googleModel = {
    value: "google@@gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    providerAuthenticated: true,
    providerId: "google",
    providerLabel: "Google",
    section: "local",
  };
  const openrouterModel = {
    value: "openrouter@@openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerAuthenticated: true,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "local",
  };

  let currentModelId = managedModel.value;
  let openrouterState = "environment";
  const clearCalls = [];
  const setApiKeyCalls = [];

  function buildProvidersSnapshot() {
    const openrouterConnected = openrouterState === "environment" || openrouterState === "api_key";
    const openrouterStoredCredential = openrouterState === "api_key";
    return {
      settings: {
        settingsModalOpen: true,
        pluginSettingsOpen: true,
        activePluginTabId: "providers",
      },
      ui: {
        panelVisible: true,
      },
      providers: {
        rowCount: 2,
        rows: [
          {
            providerId: "google",
            label: "Google",
            source: "environment_or_fallback",
            credentialType: "none",
            isLocalProvider: false,
            apiKeyEnvVar: "GOOGLE_API_KEY",
            apiKeyEnabled: true,
            hasAnyAuth: true,
            hasStoredCredential: false,
            display: {
              ready: true,
              connected: true,
              blocked: false,
              tone: "connected",
              summary: "Connected from environment",
            },
          },
          {
            providerId: "openrouter",
            label: "OpenRouter",
            source: openrouterState === "api_key" ? "api_key" : "environment_or_fallback",
            credentialType: openrouterState === "api_key" ? "api_key" : "none",
            isLocalProvider: false,
            apiKeyEnvVar: "OPENROUTER_API_KEY",
            apiKeyEnabled: true,
            hasAnyAuth: openrouterConnected,
            hasStoredCredential: openrouterStoredCredential,
            display: {
              ready: openrouterConnected,
              connected: openrouterConnected,
              blocked: false,
              tone: "connected",
              summary:
                openrouterState === "api_key" ? "Connected via API key" : "Connected from environment",
            },
          },
        ],
      },
    };
  }

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [managedModel, googleModel, openrouterModel],
      };
    },
    async getProvidersSnapshot() {
      return buildProvidersSnapshot();
    },
    async clearProviderAuth(providerId) {
      clearCalls.push(providerId);
      assert.equal(providerId, "openrouter");
      openrouterState = "environment";
      return buildProvidersSnapshot();
    },
    async setProviderApiKey(providerId, apiKey) {
      setApiKeyCalls.push(providerId);
      assert.equal(providerId, "openrouter");
      assert.equal(apiKey, "sk-openrouter");
      return buildProvidersSnapshot();
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      const token = String(body.text || "").replace(
        "Reply with this exact token and nothing else: ",
        ""
      );
      return {
        selectedModelId: currentModelId,
        currentModelName:
          currentModelId === managedModel.value
            ? "SystemSculpt Agent"
            : currentModelId === openrouterModel.value
              ? "GPT-5.4 Mini"
              : "Gemini 2.5 Flash",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runProviderConnectedBaselineCase(client, {
    env: {
      SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS: JSON.stringify({
        google: "sk-google",
        openrouter: "sk-openrouter",
      }),
    },
  });

  assert.deepEqual(outcome.attemptedCandidateIds, ["openrouter"]);
  assert.deepEqual(setApiKeyCalls, ["openrouter"]);
  assert.deepEqual(clearCalls, ["openrouter", "openrouter"]);
  assert.equal(outcome.provider.providerId, "openrouter");
  assert.equal(outcome.provider.connectionMode, "environment_or_fallback");
  assert.equal(outcome.providerStates.beforeConnect.source, "environment_or_fallback");
  assert.equal(outcome.providerStates.connected.source, "environment_or_fallback");
  assert.equal(outcome.providerStates.afterClear.source, "environment_or_fallback");
  assert.equal(outcome.blockedProviderSend, null);
  assert.match(outcome.providerTurn.response, /PROVIDER_CONNECTED_OPENROUTER_/);
  assert.match(outcome.providerTurnAfterClear.response, /PROVIDER_CONNECTED_OPENROUTER_AFTER_CLEAR_/);
  assert.equal(outcome.recoverySelection.selectedModelId, managedModel.value);
});

test("runProviderConnectedBaselineCase retries transient OpenRouter failures without falling back to other providers", async () => {
  const managedModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const googleModel = {
    value: "google@@gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    providerAuthenticated: true,
    providerId: "google",
    providerLabel: "Google",
    section: "local",
  };
  const openrouterModel = {
    value: "openrouter@@openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerAuthenticated: true,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "local",
  };

  let currentModelId = managedModel.value;
  let openrouterState = "environment";
  let openrouterTurnAttempts = 0;
  let googleTurnAttempts = 0;
  const clearCalls = [];
  const setApiKeyCalls = [];

  function buildProvidersSnapshot() {
    const openrouterConnected = openrouterState === "environment" || openrouterState === "api_key";
    const openrouterStoredCredential = openrouterState === "api_key";
    return {
      settings: {
        settingsModalOpen: true,
        pluginSettingsOpen: true,
        activePluginTabId: "providers",
      },
      ui: {
        panelVisible: true,
      },
      providers: {
        rowCount: 2,
        rows: [
          {
            providerId: "google",
            label: "Google",
            source: "environment_or_fallback",
            credentialType: "none",
            isLocalProvider: false,
            apiKeyEnvVar: "GOOGLE_API_KEY",
            apiKeyEnabled: true,
            hasAnyAuth: true,
            hasStoredCredential: false,
            display: {
              ready: true,
              connected: true,
              blocked: false,
              tone: "connected",
              summary: "Connected from environment",
            },
          },
          {
            providerId: "openrouter",
            label: "OpenRouter",
            source: openrouterState === "api_key" ? "api_key" : "environment_or_fallback",
            credentialType: openrouterState === "api_key" ? "api_key" : "none",
            isLocalProvider: false,
            apiKeyEnvVar: "OPENROUTER_API_KEY",
            apiKeyEnabled: true,
            hasAnyAuth: openrouterConnected,
            hasStoredCredential: openrouterStoredCredential,
            display: {
              ready: openrouterConnected,
              connected: openrouterConnected,
              blocked: false,
              tone: "connected",
              summary:
                openrouterState === "api_key" ? "Connected via API key" : "Connected from environment",
            },
          },
        ],
      },
    };
  }

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [managedModel, googleModel, openrouterModel],
      };
    },
    async getProvidersSnapshot() {
      return buildProvidersSnapshot();
    },
    async clearProviderAuth(providerId) {
      clearCalls.push(providerId);
      assert.equal(providerId, "openrouter");
      openrouterState = "environment";
      return buildProvidersSnapshot();
    },
    async setProviderApiKey(providerId, apiKey) {
      setApiKeyCalls.push(providerId);
      assert.equal(providerId, "openrouter");
      assert.equal(apiKey, "sk-openrouter");
      return buildProvidersSnapshot();
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      const token = String(body.text || "").replace(
        "Reply with this exact token and nothing else: ",
        ""
      );
      if (currentModelId === openrouterModel.value) {
        openrouterTurnAttempts += 1;
        if (openrouterTurnAttempts === 1) {
          throw new Error("This operation was aborted");
        }
      }
      if (currentModelId === googleModel.value) {
        googleTurnAttempts += 1;
      }
      return {
        selectedModelId: currentModelId,
        currentModelName:
          currentModelId === managedModel.value
            ? "SystemSculpt Agent"
            : currentModelId === openrouterModel.value
              ? "GPT-5.4 Mini"
              : "Gemini 2.5 Flash",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runProviderConnectedBaselineCase(client, {
    env: {
      SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS: JSON.stringify({
        google: "sk-google",
        openrouter: "sk-openrouter",
      }),
    },
  });

  assert.deepEqual(outcome.attemptedCandidateIds, ["openrouter"]);
  assert.equal(openrouterTurnAttempts, 3);
  assert.equal(googleTurnAttempts, 0);
  assert.deepEqual(setApiKeyCalls, ["openrouter"]);
  assert.deepEqual(clearCalls, ["openrouter", "openrouter"]);
  assert.equal(outcome.provider.providerId, "openrouter");
  assert.match(outcome.providerTurn.response, /PROVIDER_CONNECTED_OPENROUTER_/);
  assert.match(outcome.providerTurnAfterClear.response, /PROVIDER_CONNECTED_OPENROUTER_AFTER_CLEAR_/);
});

test("runProviderConnectedBaselineCase only force-refreshes provider state once per auth transition", async () => {
  const managedModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const providerReadyModel = {
    value: "openai@@gpt-4.1",
    label: "GPT-4.1",
    providerAuthenticated: true,
    providerId: "openai",
    providerLabel: "OpenAI",
    section: "local",
  };
  const providerSetupModel = {
    ...providerReadyModel,
    providerAuthenticated: false,
  };

  let currentModelId = managedModel.value;
  let providerRowState = "disconnected";
  let modelCatalogState = "disconnected";
  const providerSnapshotCalls = [];
  const modelCalls = [];

  function buildProvidersSnapshot(state = providerRowState) {
    const connected = state === "connected" || state === "disconnecting";
    return {
      settings: {
        settingsModalOpen: true,
        pluginSettingsOpen: true,
        activePluginTabId: "providers",
      },
      ui: {
        panelVisible: true,
        rowCount: 1,
      },
      providers: {
        rowCount: 1,
        rows: [
          {
            providerId: "openai",
            label: "OpenAI",
            source: connected ? "api_key" : "none",
            credentialType: connected ? "api_key" : "none",
            isLocalProvider: false,
            apiKeyEnvVar: "OPENAI_API_KEY",
            oauthEnabled: true,
            apiKeyEnabled: true,
            hasAnyAuth: connected,
            hasStoredCredential: connected,
            display: {
              ready: connected,
              connected,
              blocked: false,
              tone: connected ? "connected" : "disconnected",
              summary: connected ? "Connected via API key" : "Not connected",
            },
          },
        ],
      },
    };
  }

  const client = {
    async listModels(options = {}) {
      modelCalls.push({ ...options });
      if (modelCatalogState === "connecting") {
        modelCatalogState = "connected";
        return {
          selectedModelId: currentModelId,
          options: [managedModel, providerSetupModel],
        };
      }
      if (modelCatalogState === "disconnecting") {
        modelCatalogState = "disconnected";
        return {
          selectedModelId: currentModelId,
          options: [managedModel, providerReadyModel],
        };
      }
      return {
        selectedModelId: currentModelId,
        options: [managedModel, modelCatalogState === "connected" ? providerReadyModel : providerSetupModel],
      };
    },
    async getProvidersSnapshot(body = {}) {
      providerSnapshotCalls.push({ ...body });
      if (providerRowState === "connecting") {
        providerRowState = "connected";
      } else if (providerRowState === "disconnecting") {
        providerRowState = "disconnected";
      }
      return buildProvidersSnapshot();
    },
    async clearProviderAuth(providerId) {
      assert.equal(providerId, "openai");
      if (providerRowState === "connected") {
        providerRowState = "disconnecting";
        modelCatalogState = "disconnecting";
        return buildProvidersSnapshot("disconnecting");
      }
      providerRowState = "disconnected";
      modelCatalogState = "disconnected";
      return buildProvidersSnapshot("disconnected");
    },
    async setProviderApiKey(providerId, apiKey) {
      assert.equal(providerId, "openai");
      assert.equal(apiKey, "sk-provider");
      providerRowState = "connecting";
      modelCatalogState = "connecting";
      return buildProvidersSnapshot("connecting");
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (currentModelId !== managedModel.value && providerRowState !== "connected") {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const token = String(body.text || "").replace(
        "Reply with this exact token and nothing else: ",
        ""
      );
      return {
        selectedModelId: currentModelId,
        currentModelName:
          currentModelId === managedModel.value ? "SystemSculpt Agent" : "GPT-4.1",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runProviderConnectedBaselineCase(client, {
    env: {
      SYSTEMSCULPT_DESKTOP_PROVIDER_ID: "openai",
      SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY: "sk-provider",
    },
  });

  assert.equal(outcome.provider.providerId, "openai");
  assert.deepEqual(providerSnapshotCalls, [
    { ensureOpen: true, waitForLoaded: true },
    { ensureOpen: false, waitForLoaded: true, preflightRefresh: false },
    { ensureOpen: false, waitForLoaded: true, preflightRefresh: false },
  ]);
  assert.deepEqual(modelCalls, [
    {},
    { refresh: true, preflightRefresh: false },
    { refresh: true, preflightRefresh: false },
    { refresh: false, preflightRefresh: false },
    { refresh: true, preflightRefresh: false },
    { refresh: false, preflightRefresh: false },
    { refresh: true, preflightRefresh: false },
  ]);
});

test("runProviderConnectedBaselineCase prefers the stable OpenRouter model instead of the first authenticated match", async () => {
  const managedModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const kimiModel = {
    value: "openrouter@@moonshotai/kimi-k2.5",
    label: "Kimi K2.5",
    providerAuthenticated: true,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "local",
  };
  const stableModel = {
    value: "openrouter@@openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerAuthenticated: true,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "local",
  };

  let currentModelId = managedModel.value;
  let providerConnected = false;

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [
          managedModel,
          { ...kimiModel, providerAuthenticated: providerConnected },
          { ...stableModel, providerAuthenticated: providerConnected },
        ],
      };
    },
    async getProvidersSnapshot() {
      return {
        settings: {
          settingsModalOpen: true,
          pluginSettingsOpen: true,
          activePluginTabId: "providers",
        },
        ui: {
          panelVisible: true,
        },
        providers: {
          rowCount: 1,
          rows: [
            {
              providerId: "openrouter",
              label: "OpenRouter",
              source: providerConnected ? "api_key" : "none",
              credentialType: providerConnected ? "api_key" : null,
              hasAnyAuth: providerConnected,
              hasStoredCredential: providerConnected,
              isLocalProvider: false,
              apiKeyEnabled: true,
              apiKeyEnvVar: "OPENROUTER_API_KEY",
              display: {
                ready: providerConnected,
              },
            },
          ],
        },
      };
    },
    async clearProviderAuth(providerId) {
      assert.equal(providerId, "openrouter");
      providerConnected = false;
      return await this.getProvidersSnapshot();
    },
    async setProviderApiKey(providerId, apiKey) {
      assert.equal(providerId, "openrouter");
      assert.equal(apiKey, "sk-openrouter");
      providerConnected = true;
      return await this.getProvidersSnapshot();
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (!providerConnected && (currentModelId === kimiModel.value || currentModelId === stableModel.value)) {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const token = String(body.text || "").replace(
        "Reply with this exact token and nothing else: ",
        ""
      );
      return {
        selectedModelId: currentModelId,
        currentModelName:
          currentModelId === managedModel.value
            ? "SystemSculpt Agent"
            : currentModelId === stableModel.value
              ? "GPT-5.4 Mini"
              : "Kimi K2.5",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runProviderConnectedBaselineCase(client, {
    env: {
      SYSTEMSCULPT_DESKTOP_PROVIDER_ID: "openrouter",
      SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY: "sk-openrouter",
    },
  });

  assert.equal(outcome.provider.providerId, "openrouter");
  assert.equal(outcome.providerModel.modelId, stableModel.value);
  assert.match(outcome.providerTurn.response, /PROVIDER_CONNECTED_OPENROUTER_/);
});

test("runCase forwards provider-connected model preferences into the provider baseline runner", async () => {
  const managedModel = {
    value: "systemsculpt@@systemsculpt/ai-agent",
    label: "SystemSculpt Agent",
    providerAuthenticated: true,
    providerId: "systemsculpt",
    providerLabel: "SystemSculpt",
    section: "systemsculpt",
  };
  const defaultModel = {
    value: "openrouter@@openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerAuthenticated: true,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "local",
  };
  const overrideModel = {
    value: "openrouter@@openai/gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    providerAuthenticated: true,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    section: "local",
  };

  let currentModelId = managedModel.value;
  let providerConnected = false;

  const client = {
    async listModels() {
      return {
        selectedModelId: currentModelId,
        options: [
          managedModel,
          { ...defaultModel, providerAuthenticated: providerConnected },
          { ...overrideModel, providerAuthenticated: providerConnected },
        ],
      };
    },
    async getProvidersSnapshot() {
      return {
        settings: {
          settingsModalOpen: true,
          pluginSettingsOpen: true,
          activePluginTabId: "providers",
        },
        ui: {
          panelVisible: true,
        },
        providers: {
          rowCount: 1,
          rows: [
            {
              providerId: "openrouter",
              label: "OpenRouter",
              source: providerConnected ? "api_key" : "none",
              credentialType: providerConnected ? "api_key" : null,
              hasAnyAuth: providerConnected,
              hasStoredCredential: providerConnected,
              isLocalProvider: false,
              apiKeyEnabled: true,
              apiKeyEnvVar: "OPENROUTER_API_KEY",
              display: {
                ready: providerConnected,
              },
            },
          ],
        },
      };
    },
    async clearProviderAuth() {
      providerConnected = false;
      return await this.getProvidersSnapshot();
    },
    async setProviderApiKey() {
      providerConnected = true;
      return await this.getProvidersSnapshot();
    },
    async ensureChatOpen(body = {}) {
      if (body.selectedModelId) {
        currentModelId = body.selectedModelId;
      }
      return {
        selectedModelId: currentModelId,
      };
    },
    async setModel(modelId) {
      currentModelId = modelId;
      return {
        selectedModelId: currentModelId,
      };
    },
    async sendChat(body = {}) {
      if (!providerConnected && currentModelId === overrideModel.value) {
        throw new Error(
          "The selected Pi model is unavailable. Reconnect the provider or pick another model in Settings -> Providers."
        );
      }

      const token = String(body.text || "").replace(
        "Reply with this exact token and nothing else: ",
        ""
      );
      return {
        selectedModelId: currentModelId,
        currentModelName:
          currentModelId === managedModel.value
            ? "SystemSculpt Agent"
            : currentModelId === overrideModel.value
              ? "GPT-4.1 Mini"
              : "GPT-5.4 Mini",
        messages: [{ role: "assistant", content: token }],
      };
    },
  };

  const outcome = await runCase(
    client,
    {
      env: {
        SYSTEMSCULPT_DESKTOP_PROVIDER_ID: "openrouter",
        SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY: "sk-openrouter",
        SYSTEMSCULPT_DESKTOP_PROVIDER_MODEL_ID: "openai/gpt-4.1-mini",
      },
    },
    PROVIDER_CONNECTED_BASELINE_CASE
  );

  assert.equal(outcome.result.provider.providerId, "openrouter");
  assert.equal(outcome.result.providerModel.modelId, overrideModel.value);
});

test("runProviderConnectedBaselineCase fails clearly when no provider API key is configured", async () => {
  const client = {
    async listModels() {
      return {
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
        options: [
          {
            value: "systemsculpt@@systemsculpt/ai-agent",
            label: "SystemSculpt Agent",
            providerAuthenticated: true,
            providerId: "systemsculpt",
            providerLabel: "SystemSculpt",
            section: "systemsculpt",
          },
        ],
      };
    },
    async getProvidersSnapshot() {
      return {
        settings: {
          settingsModalOpen: true,
          pluginSettingsOpen: true,
          activePluginTabId: "providers",
        },
        ui: {
          panelVisible: true,
          rowCount: 1,
        },
        providers: {
          rowCount: 1,
          rows: [
            {
              providerId: "openai",
              label: "OpenAI",
              source: "none",
              credentialType: "none",
              isLocalProvider: false,
              apiKeyEnvVar: "OPENAI_API_KEY",
              oauthEnabled: true,
              apiKeyEnabled: true,
              hasAnyAuth: false,
              hasStoredCredential: false,
              display: {
                ready: false,
                connected: false,
                blocked: false,
                tone: "disconnected",
                summary: "Not connected",
              },
            },
          ],
        },
      };
    },
  };

  await assert.rejects(
    runProviderConnectedBaselineCase(client, { env: {} }),
    /No provider API key was available/
  );
});
