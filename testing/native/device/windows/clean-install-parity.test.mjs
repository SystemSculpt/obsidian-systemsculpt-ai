import test from "node:test";
import assert from "node:assert/strict";
import {
  findProviderModel,
  findProviderRow,
  isTransientError,
  parseCleanInstallParityArgs,
  summarizeProvidersPanel,
} from "./clean-install-parity.mjs";

test("parseCleanInstallParityArgs accepts provider auth inputs", () => {
  const parsed = parseCleanInstallParityArgs([
    "--provider-id",
    "google",
    "--provider-model-id",
    "gemini-2.5-flash,gemini-2.5-pro",
    "--api-key-file",
    "C:/Temp/google.txt",
    "--wait-timeout-ms",
    "90000",
    "--send-timeout-ms",
    "180000",
  ]);

  assert.equal(parsed.providerId, "google");
  assert.deepEqual(parsed.preferredProviderModelIds, ["gemini-2.5-flash", "gemini-2.5-pro"]);
  assert.equal(parsed.apiKeyFile, "C:/Temp/google.txt");
  assert.equal(parsed.waitTimeoutMs, 90000);
  assert.equal(parsed.sendTimeoutMs, 180000);
});

test("findProviderRow resolves a provider case-insensitively", () => {
  const row = findProviderRow(
    {
      providers: {
        rows: [{ providerId: "Google", hasAnyAuth: true }],
      },
    },
    "google"
  );

  assert.deepEqual(row, { providerId: "Google", hasAnyAuth: true });
});

test("findProviderModel resolves the authenticated provider option without depending on section", () => {
  const option = findProviderModel(
    {
      options: [
        { providerId: "google", section: "pi", providerAuthenticated: false, value: "setup" },
        { providerId: "google", section: "local", providerAuthenticated: true, value: "ready" },
      ],
    },
    "google",
    true
  );

  assert.equal(option?.value, "ready");
});

test("findProviderModel prefers the requested OpenRouter model before falling back", () => {
  const option = findProviderModel(
    {
      options: [
        {
          providerId: "openrouter",
          section: "pi",
          providerAuthenticated: true,
          value: "local-pi-openrouter@@ai21/jamba-large-1.7",
          label: "AI21: Jamba Large 1.7",
          piExecutionModelId: "openrouter/ai21/jamba-large-1.7",
        },
        {
          providerId: "openrouter",
          section: "pi",
          providerAuthenticated: true,
          value: "local-pi-openrouter@@openai/gpt-5.4-mini",
          label: "OpenAI: GPT-5.4 Mini",
          piExecutionModelId: "openrouter/openai/gpt-5.4-mini",
        },
      ],
    },
    "openrouter",
    true,
    {
      preferredModelIds: ["openai/gpt-5.4-mini"],
    }
  );

  assert.equal(option?.value, "local-pi-openrouter@@openai/gpt-5.4-mini");
});

test("findProviderModel applies the shared stable-provider defaults when no explicit model is pinned", () => {
  const option = findProviderModel(
    {
      options: [
        {
          providerId: "openrouter",
          section: "pi",
          providerAuthenticated: true,
          value: "local-pi-openrouter@@ai21/jamba-large-1.7",
          label: "AI21: Jamba Large 1.7",
          piExecutionModelId: "openrouter/ai21/jamba-large-1.7",
        },
        {
          providerId: "openrouter",
          section: "pi",
          providerAuthenticated: true,
          value: "local-pi-openrouter@@openai/gpt-5.4-mini",
          label: "OpenAI: GPT-5.4 Mini",
          piExecutionModelId: "openrouter/openai/gpt-5.4-mini",
        },
      ],
    },
    "openrouter",
    true
  );

  assert.equal(option?.value, "local-pi-openrouter@@openai/gpt-5.4-mini");
});

test("summarizeProvidersPanel reads the nested settings and ui snapshot shape", () => {
  const summary = summarizeProvidersPanel({
    settings: {
      settingsModalOpen: true,
      pluginSettingsOpen: true,
      activePluginTabId: "providers",
    },
    ui: {
      panelVisible: true,
      error: null,
    },
    providers: {
      rows: [{ providerId: "openrouter" }],
    },
  });

  assert.deepEqual(summary, {
    settingsModalOpen: true,
    pluginSettingsOpen: true,
    activePluginTabId: "providers",
    panelVisible: true,
    rowCount: 1,
    error: null,
  });
});

test("isTransientError matches 429 and retryable upstream conditions", () => {
  assert.equal(isTransientError(new Error("HTTP 429 from upstream")), true);
  assert.equal(isTransientError(new Error("retry after 10 seconds")), true);
  assert.equal(isTransientError(new Error("providers tab not found")), false);
});
