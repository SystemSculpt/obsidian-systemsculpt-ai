import { applyCurrentSecretsToBackup, redactSettingsForBackup } from "../backupSanitizer";

describe("backupSanitizer", () => {
  it("redacts top-level and nested API secrets for backup payloads", () => {
    const source = {
      licenseKey: "license-secret",
      openAiApiKey: "openai-secret",
      customTranscriptionApiKey: "transcription-secret",
      replicateApiKey: "replicate-secret",
      embeddingsCustomApiKey: "embeddings-secret",
      readwiseApiToken: "readwise-secret",
      customProviders: [
        { id: "provider-a", apiKey: "provider-secret", endpoint: "https://api.example.com" },
      ],
      mcpServers: [
        { id: "mcp-a", transport: "http", endpoint: "https://mcp.example.com", apiKey: "mcp-secret" },
      ],
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
    };

    const redacted = redactSettingsForBackup(source);

    expect(redacted.licenseKey).toBe("");
    expect(redacted.openAiApiKey).toBe("");
    expect(redacted.customTranscriptionApiKey).toBe("");
    expect(redacted.replicateApiKey).toBe("");
    expect(redacted.embeddingsCustomApiKey).toBe("");
    expect(redacted.readwiseApiToken).toBe("");
    expect(redacted.customProviders[0].apiKey).toBe("");
    expect(redacted.mcpServers[0].apiKey).toBe("");
    expect(redacted.customProviders[0].endpoint).toBe("https://api.example.com");
    expect(redacted.selectedModelId).toBe("systemsculpt@@systemsculpt/ai-agent");
  });

  it("restores backups while preserving current secrets instead of trusting backup secrets", () => {
    const backup = {
      licenseKey: "malicious-backup-key",
      openAiApiKey: "malicious-openai-key",
      customProviders: [
        { id: "provider-a", apiKey: "malicious-provider-key", endpoint: "https://api.example.com" },
        { id: "provider-b", apiKey: "malicious-provider-key-b", endpoint: "https://api-2.example.com" },
      ],
      mcpServers: [
        { id: "mcp-a", apiKey: "malicious-mcp-key", transport: "http" },
      ],
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
    };

    const currentSettings = {
      licenseKey: "current-license-key",
      openAiApiKey: "current-openai-key",
      customTranscriptionApiKey: "current-transcription-key",
      replicateApiKey: "current-replicate-key",
      embeddingsCustomApiKey: "current-embeddings-key",
      readwiseApiToken: "current-readwise-key",
      customProviders: [
        { id: "provider-a", apiKey: "current-provider-a-key" },
      ],
      mcpServers: [
        { id: "mcp-a", apiKey: "current-mcp-key" },
      ],
    };

    const restored = applyCurrentSecretsToBackup(backup, currentSettings);

    expect(restored.licenseKey).toBe("current-license-key");
    expect(restored.openAiApiKey).toBe("current-openai-key");
    expect(restored.customTranscriptionApiKey).toBe("current-transcription-key");
    expect(restored.replicateApiKey).toBe("current-replicate-key");
    expect(restored.embeddingsCustomApiKey).toBe("current-embeddings-key");
    expect(restored.readwiseApiToken).toBe("current-readwise-key");
    expect(restored.customProviders[0].apiKey).toBe("current-provider-a-key");
    expect(restored.customProviders[1].apiKey).toBe("");
    expect(restored.mcpServers[0].apiKey).toBe("current-mcp-key");
    expect(restored.selectedModelId).toBe("systemsculpt@@systemsculpt/ai-agent");
  });
});
