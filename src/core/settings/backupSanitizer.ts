const TOP_LEVEL_SECRET_KEYS = [
  "licenseKey",
  "openAiApiKey",
  "customTranscriptionApiKey",
  "embeddingsCustomApiKey",
  "readwiseApiToken",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function redactArrayApiKeys(entries: unknown): unknown {
  if (!Array.isArray(entries)) {
    return entries;
  }

  return entries.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    return {
      ...entry,
      apiKey: "",
    };
  });
}

function mapCurrentApiKeys(entries: unknown): Map<string, string> {
  const keyedSecrets = new Map<string, string>();
  if (!Array.isArray(entries)) {
    return keyedSecrets;
  }

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id) {
      continue;
    }
    keyedSecrets.set(id, typeof entry.apiKey === "string" ? entry.apiKey : "");
  }

  return keyedSecrets;
}

function applyCurrentApiKeys(backupEntries: unknown, currentEntries: unknown): unknown {
  if (!Array.isArray(backupEntries)) {
    return backupEntries;
  }

  const currentApiKeys = mapCurrentApiKeys(currentEntries);
  return backupEntries.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }

    const id = typeof entry.id === "string" ? entry.id : "";
    return {
      ...entry,
      apiKey: currentApiKeys.get(id) ?? "",
    };
  });
}

export function redactSettingsForBackup<T extends Record<string, unknown>>(settings: T): T {
  const redacted: Record<string, unknown> = {
    ...settings,
  };

  for (const key of TOP_LEVEL_SECRET_KEYS) {
    redacted[key] = "";
  }

  redacted.customProviders = redactArrayApiKeys(settings.customProviders);
  redacted.mcpServers = redactArrayApiKeys(settings.mcpServers);

  return redacted as T;
}

export function applyCurrentSecretsToBackup<T extends Record<string, unknown>>(
  backup: T,
  currentSettings: Record<string, unknown>,
): T {
  const merged: Record<string, unknown> = {
    ...backup,
  };

  for (const key of TOP_LEVEL_SECRET_KEYS) {
    merged[key] = typeof currentSettings[key] === "string" ? currentSettings[key] : "";
  }

  merged.customProviders = applyCurrentApiKeys(backup.customProviders, currentSettings.customProviders);
  merged.mcpServers = applyCurrentApiKeys(backup.mcpServers, currentSettings.mcpServers);

  return merged as T;
}
