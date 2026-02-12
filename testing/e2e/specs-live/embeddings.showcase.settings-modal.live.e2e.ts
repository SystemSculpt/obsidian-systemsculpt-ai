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
  getSimilarNotesViewState,
  openMarkdownFile,
  openSimilarNotesView,
  searchSimilarByText,
  startEmbeddingsProcessingFromView,
  waitForEmbeddingsProcessingToComplete,
  waitForEmbeddingsProgressUi,
} from "../utils/systemsculptEmbeddings";
import {
  closeSystemSculptSettingsIfOpen,
  openSystemSculptSettingsTab,
  setSystemSculptDropdownSetting,
  setSystemSculptToggleSetting,
  waitForSystemSculptSetting,
} from "../utils/systemsculptSettings";

describe("Embeddings showcase (live) settings + processing modal", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  const nonce = crypto.randomUUID().slice(0, 8);
  const semanticToken = `EMBED_SHOWCASE_${nonce}`;
  const notePaths = Array.from({ length: 14 }, (_, index) =>
    `E2E/Embeddings Showcase/showcase-${String(index + 1).padStart(2, "0")}.md`
  );

  const beat = async (ms = 850) => {
    await browser.pause(ms);
  };

  const longParagraph = (index: number) =>
    [
      `This showcase note ${index + 1} is intentionally long so embeddings processing has enough content to work with.`,
      `Primary semantic token: ${semanticToken}.`,
      "We want visual progress in the Similar Notes panel while vectors are being generated and stored.",
      "Additional narrative: product onboarding, settings discoverability, and quick activation for semantic search.",
      "Filler sequence: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron.",
      "Final sentence keeps this chunk above minimum token length and useful for semantic retrieval examples.",
    ].join(" ");

  before(async () => {
    const vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);

    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        embeddingsEnabled: false,
        embeddingsProvider: "systemsculpt",
        embeddingsAutoProcess: false,
        embeddingsBatchSize: 8,
        embeddingsRateLimitPerMinute: 0,
      },
    });

    for (const [index, notePath] of notePaths.entries()) {
      await upsertVaultFile(
        notePath,
        `# Embeddings Showcase ${index + 1}\n\n${longParagraph(index)}\n\n${longParagraph(index + notePaths.length)}\n`
      );
    }
  });

  it("shows where embeddings live in settings and records processing in the modal", async function () {
    this.timeout(300000);

    await openSystemSculptSettingsTab("embeddings");
    await waitForSystemSculptSetting("Enable embeddings", { tabId: "embeddings" });
    await beat(1200);

    await setSystemSculptToggleSetting("Enable embeddings", true, { tabId: "embeddings" });
    await beat(1100);

    await setSystemSculptDropdownSetting("Embeddings provider", "SystemSculpt (Default)", { tabId: "embeddings" });
    await beat(1100);

    await browser.execute(() => {
      const panel = document.querySelector('.systemsculpt-tab-content[data-tab="embeddings"]') as HTMLElement | null;
      if (!panel) return;
      panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
    });
    await beat(900);
    await browser.execute(() => {
      const panel = document.querySelector('.systemsculpt-tab-content[data-tab="embeddings"]') as HTMLElement | null;
      if (!panel) return;
      panel.scrollTo({ top: 0, behavior: "smooth" });
    });
    await beat(900);

    await closeSystemSculptSettingsIfOpen();
    await beat(500);

    await openMarkdownFile(notePaths[0]);
    await beat(1000);

    await openSimilarNotesView();
    await browser.waitUntil(
      async () => {
        const state = await getSimilarNotesViewState();
        return state.isVisible && state.leafCount > 0;
      },
      { timeout: 20000, timeoutMsg: "Similar Notes view did not become visible." }
    );
    await beat(1200);

    await startEmbeddingsProcessingFromView();
    await waitForEmbeddingsProgressUi({ timeoutMs: 30000 });
    await beat(2400);

    const stats = await waitForEmbeddingsProcessingToComplete({
      timeoutMs: 260000,
      minPresent: notePaths.length,
    });
    expect(stats.present).toBeGreaterThanOrEqual(notePaths.length);
    await beat(1200);

    const searchResults = await searchSimilarByText(semanticToken, 8);
    expect(searchResults.length).toBeGreaterThan(0);
  });
});
