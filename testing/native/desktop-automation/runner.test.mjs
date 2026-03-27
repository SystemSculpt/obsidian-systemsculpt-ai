import test from "node:test";
import assert from "node:assert/strict";
import {
  assertHealthyStatus,
  CHATVIEW_STRESS_CASE,
  caseList,
  isTransientModelExecutionError,
  resolveBootstrapReload,
  runChatViewStressCase,
  runReloadStressCase,
} from "./runner.mjs";

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

test("isTransientModelExecutionError treats generic provider-side upstream failures as transient", () => {
  assert.equal(isTransientModelExecutionError(new Error("Provider returned error")), true);
  assert.equal(
    isTransientModelExecutionError(
      new Error("Provider returned error moonshotai/kimi-k2.5 is temporarily rate-limited upstream.")
    ),
    true
  );
  assert.equal(isTransientModelExecutionError(new Error("Invalid API key")), false);
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
