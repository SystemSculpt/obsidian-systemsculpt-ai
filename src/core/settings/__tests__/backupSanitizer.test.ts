import { applyCurrentSecretsToBackup, redactSettingsForBackup } from "../backupSanitizer";
import {
  LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4,
  LEGACY_FEATURE_KEYS_REMOVED_IN_V6,
  LEGACY_UPDATE_KEYS_REMOVED_IN_V8,
} from "../migrations/SettingsMigrator";

describe("backupSanitizer", () => {
  const retiredSecretState = {
    openAiApiKey: "openai-secret",
    customTranscriptionApiKey: "transcription-secret",
    readwiseApiToken: "readwise-secret",
    customProviders: [{ id: "provider-a", apiKey: "provider-secret" }],
    mcpServers: [{ id: "mcp-a", apiKey: "mcp-secret" }],
    piAuth: { token: "pi-secret" },
    selectedModelId: "legacy-provider@@legacy-model",
    postProcessingProviderId: "legacy-provider",
    postProcessingModelId: "legacy-model",
    titleGenerationProviderId: "legacy-provider",
    titleGenerationModelId: "legacy-model",
  };

  it("redacts the current license and drops all retired authority state", () => {
    const redacted = redactSettingsForBackup({
      licenseKey: "license-secret",
      chatsDirectory: "SystemSculpt/Chats",
      ...retiredSecretState,
    });

    expect(redacted).toMatchObject({
      licenseKey: "",
      chatsDirectory: "SystemSculpt/Chats",
    });
    for (const key of LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4) {
      expect(redacted).not.toHaveProperty(key);
    }
    for (const key of LEGACY_FEATURE_KEYS_REMOVED_IN_V6) {
      expect(redacted).not.toHaveProperty(key);
    }
    for (const key of LEGACY_UPDATE_KEYS_REMOVED_IN_V8) {
      expect(redacted).not.toHaveProperty(key);
    }
  });

  it("restores only the current license and cannot reintroduce retired secrets", () => {
    const restored = applyCurrentSecretsToBackup(
      { licenseKey: "malicious-backup-key", ...retiredSecretState },
      { licenseKey: "current-license-key", ...retiredSecretState },
    );

    expect(restored.licenseKey).toBe("current-license-key");
    for (const key of LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4) {
      expect(restored).not.toHaveProperty(key);
    }
    for (const key of LEGACY_FEATURE_KEYS_REMOVED_IN_V6) {
      expect(restored).not.toHaveProperty(key);
    }
    for (const key of LEGACY_UPDATE_KEYS_REMOVED_IN_V8) {
      expect(restored).not.toHaveProperty(key);
    }
  });
});
