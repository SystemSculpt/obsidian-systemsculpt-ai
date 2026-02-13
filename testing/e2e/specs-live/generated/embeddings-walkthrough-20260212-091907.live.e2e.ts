import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import { ensurePluginEnabled } from "../../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  PLUGIN_ID,
  requireEnv,
  upsertVaultFile,
} from "../../utils/systemsculptChat";
import {
  getSimilarNotesViewState,
  openMarkdownFile,
  openSimilarNotesView,
  searchSimilarByText,
  startEmbeddingsProcessingFromView,
  waitForEmbeddingsProcessingToComplete,
  waitForEmbeddingsProgressUi,
} from "../../utils/systemsculptEmbeddings";
import {
  closeSystemSculptSettingsIfOpen,
  openSystemSculptSettingsTab,
  setSystemSculptDropdownSetting,
  setSystemSculptToggleSetting,
  waitForSystemSculptSetting,
} from "../../utils/systemsculptSettings";

describe("Embeddings showcase (live) generated from brief", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  const nonce = crypto.randomUUID().slice(0, 8);
  const semanticToken = "EMBED_BRIEF_" + nonce;
  const notePaths = Array.from({ length: 14 }, (_, index) =>
    "E2E/Embeddings Showcase/brief-showcase-" + String(index + 1).padStart(2, "0") + ".md"
  );

  const beat = async (ms = 850) => {
    await browser.pause(ms);
  };

  const longParagraph = (index: number) =>
    [
      "This generated showcase note " + String(index + 1) + " contains enough text for meaningful embeddings processing.",
      "Semantic token for verification: " + semanticToken + ".",
      "This run demonstrates where embeddings are configured and how processing appears in the Similar Notes panel.",
      "Additional context: onboarding clarity, discoverability of settings, and visible processing progress.",
      "Filler sequence: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron.",
      "Final sentence keeps this content safely above minimum preprocessing thresholds.",
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
        [
          "# Brief Showcase " + String(index + 1),
          "",
          longParagraph(index),
          "",
          longParagraph(index + notePaths.length),
          "",
        ].join("\n")
      );
    }
  });

  it("executes the requested embeddings walkthrough", async function () {
    this.timeout(300000);

    await openSystemSculptSettingsTab("embeddings");
    await waitForSystemSculptSetting("Enable embeddings", { tabId: "embeddings" });
    await beat(1200);

    await setSystemSculptToggleSetting("Enable embeddings", true, { tabId: "embeddings" });
    await beat(1000);

    await setSystemSculptDropdownSetting("Embeddings provider", "SystemSculpt (Default)", { tabId: "embeddings" });
    await beat(1000);

    await closeSystemSculptSettingsIfOpen();
    await beat(500);

    await openMarkdownFile(notePaths[0]);
    await beat(900);

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
    await beat(2200);

    const stats = await waitForEmbeddingsProcessingToComplete({ timeoutMs: 260000, minPresent: notePaths.length });
    expect(stats.present).toBeGreaterThanOrEqual(notePaths.length);
    await beat(900);

    const searchResults = await searchSimilarByText(semanticToken, 8);
    expect(searchResults.length).toBeGreaterThan(0);
  });
});
