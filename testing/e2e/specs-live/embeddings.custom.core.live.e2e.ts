import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  PLUGIN_ID,
  requireEnv,
  upsertVaultFile,
} from "../utils/systemsculptChat";
import {
  findSimilarByFile,
  hasEmbeddingsForPaths,
  processVaultEmbeddings,
} from "../utils/systemsculptEmbeddings";
import { detectLmStudioEmbeddings, detectOllamaEmbeddings } from "../utils/localEmbeddingsProviders";

describe("Embeddings (live) Custom provider core", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  const nonce = crypto.randomUUID().slice(0, 8);
  const keyphrase = `E2E_CUSTOM_${nonce}`;
  const fileA = `E2E/custom-a-${nonce}.md`;
  const fileB = `E2E/custom-b-${nonce}.md`;
  const longEnough = (topic: string) =>
    [
      topic,
      "This paragraph is intentionally long enough to exceed the embeddings preprocessor minimum length.",
      "It exists only to ensure the note gets a real embedding (not an empty sentinel).",
      "Additional filler: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.",
      "",
    ].join(" ");

  let endpoint = "";
  let model = "";

  before(async () => {
    const vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);

    let providerLabel = "";
    try {
      const lm = await detectLmStudioEmbeddings();
      endpoint = lm.endpoint;
      model = lm.model;
      providerLabel = "lmstudio";
    } catch (_) {
      const ol = await detectOllamaEmbeddings();
      endpoint = ol.endpoint;
      model = ol.model;
      providerLabel = "ollama";
    }
    if (!endpoint || !model) {
      throw new Error("No local custom embeddings provider available (LM Studio or Ollama).");
    }

    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        embeddingsEnabled: true,
        embeddingsProvider: "custom",
        embeddingsAutoProcess: false,
        embeddingsCustomEndpoint: endpoint,
        embeddingsCustomApiKey: "",
        embeddingsCustomModel: model,
        embeddingsBatchSize: 8,
        embeddingsRateLimitPerMinute: 0,
      },
    });

    await upsertVaultFile(fileA, `# ${keyphrase} A\n\n${keyphrase} alpha banana apple\nProvider: ${providerLabel}\n\n${longEnough("Topic: semantic similarity.")}\n`);
    await upsertVaultFile(fileB, `# ${keyphrase} B\n\n${keyphrase} alpha banana apple\nProvider: ${providerLabel}\n\n${longEnough("Topic: semantic similarity.")}\n`);
  });

  it("processes custom embeddings and returns similar results", async function () {
    this.timeout(180000);

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }, { fileA, fileB }) => {
          const files = app.vault.getMarkdownFiles();
          return files.some((f) => f.path === fileA) && files.some((f) => f.path === fileB);
        }, { fileA, fileB }),
      { timeout: 20000, timeoutMsg: "Markdown files were not indexed in time." }
    );

    const { run, stats, currentNamespace } = await processVaultEmbeddings({ clearFirst: true });
    expect(run.status).toBe("complete");
    expect(stats.failed).toBe(0);
    expect(stats.present).toBeGreaterThanOrEqual(2);
    expect(currentNamespace.provider).toBe("custom");

    const presence = await hasEmbeddingsForPaths([fileA, fileB]);
    expect(Object.values(presence).every(Boolean)).toBe(true);

    const similarToA = await findSimilarByFile(fileA, 5);
    expect(similarToA.some((r) => r.path === fileB)).toBe(true);
  });
});
