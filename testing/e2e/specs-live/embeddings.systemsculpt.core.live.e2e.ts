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
  hasEmbeddingsForPaths,
  processVaultEmbeddings,
  searchSimilarByText,
} from "../utils/systemsculptEmbeddings";

describe("Embeddings (live) SystemSculpt core", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  const nonce = crypto.randomUUID().slice(0, 8);
  const keyphrase = `E2E_SYS_${nonce}`;
  const fileA = `E2E/sys-a-${nonce}.md`;
  const fileB = `E2E/sys-b-${nonce}.md`;
  const longEnough = (topic: string) =>
    [
      topic,
      "This paragraph is intentionally long enough to exceed the embeddings preprocessor minimum length.",
      "It exists only to ensure the note gets a real embedding (not an empty sentinel).",
      "Additional filler: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.",
      "",
    ].join(" ");

  before(async () => {
    const vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        embeddingsEnabled: true,
        embeddingsProvider: "systemsculpt",
        embeddingsAutoProcess: false,
        embeddingsBatchSize: 8,
        embeddingsRateLimitPerMinute: 0,
      },
    });

    await upsertVaultFile(fileA, `# ${keyphrase} A\n\n${keyphrase} alpha banana apple\n\n${longEnough("Topic: semantic similarity.")}\n`);
    await upsertVaultFile(fileB, `# ${keyphrase} B\n\n${keyphrase} alpha banana apple\n\n${longEnough("Topic: semantic similarity.")}\n`);
  });

  it("processes embeddings and returns similar results", async function () {
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
    expect(currentNamespace.provider).toBe("systemsculpt");

    const presence = await hasEmbeddingsForPaths([fileA, fileB]);
    expect(Object.values(presence).every(Boolean)).toBe(true);

    const searchResults = await searchSimilarByText(keyphrase, 5);
    expect(searchResults.some((r) => r.path === fileA || r.path === fileB)).toBe(true);
  });
});
