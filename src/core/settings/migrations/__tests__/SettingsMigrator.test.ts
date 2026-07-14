import { DEFAULT_SETTINGS } from "../../../../types";
import {
  CURRENT_SCHEMA_VERSION,
  LEGACY_CHAT_KEYS_REMOVED_IN_V5,
  LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4,
  LEGACY_DIRECTORY_KEYS_REMOVED_IN_V5,
  LEGACY_EMBEDDINGS_KEYS_REMOVED_IN_V3,
  LEGACY_FEATURE_KEYS_REMOVED_IN_V6,
  LEGACY_UPDATE_KEYS_REMOVED_IN_V8,
  LEGACY_KEYS_REMOVED_IN_V1,
  LEGACY_SEMANTIC_INDEX_KEYS_REMOVED_IN_V7,
  deepMergeDefaults,
  findMissingMigrationVersions,
  migrateSettingsToCurrentSchema,
  readSchemaVersion,
} from "../SettingsMigrator";

describe("readSchemaVersion", () => {
  it("returns 0 for pre-versioning, missing, or garbage input", () => {
    expect(readSchemaVersion({})).toBe(0);
    expect(readSchemaVersion({ schemaVersion: undefined })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: "1" })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: NaN })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: -3 })).toBe(0);
    expect(readSchemaVersion(null as never)).toBe(0);
    expect(readSchemaVersion([] as never)).toBe(0);
  });

  it("floors a valid non-negative version", () => {
    expect(readSchemaVersion({ schemaVersion: 1 })).toBe(1);
    expect(readSchemaVersion({ schemaVersion: 2.9 })).toBe(2);
  });
});

describe("deepMergeDefaults", () => {
  it("back-fills missing top-level keys without overwriting user values", () => {
    const defaults = { a: 1, b: 2, c: 3 };
    const merged = deepMergeDefaults(defaults, { a: 99 });
    expect(merged).toEqual({ a: 99, b: 2, c: 3 });
  });

  it("back-fills new nested sub-keys while preserving existing ones (#112/#100)", () => {
    const defaults = {
      exclusions: { folders: [], patterns: [], ignoreChatHistory: true, respectObsidian: true },
    };
    const merged = deepMergeDefaults(defaults, {
      exclusions: { folders: ["Private"], ignoreChatHistory: false },
    });
    expect(merged.exclusions).toEqual({
      folders: ["Private"],
      patterns: [],
      ignoreChatHistory: false,
      respectObsidian: true,
    });
  });

  it("preserves unknown keys present in raw but absent from defaults", () => {
    const merged = deepMergeDefaults({ known: 1 }, { known: 1, futureKey: "keep-me" });
    expect(merged.futureKey).toBe("keep-me");
  });

  it("resets a corrupt nested object (non-object in raw) to the default", () => {
    const defaults = { nested: { x: 1 } };
    const merged = deepMergeDefaults(defaults, { nested: "corrupt" as unknown });
    expect(merged.nested).toEqual({ x: 1 });
  });

  it("takes the raw array wholesale rather than element-merging", () => {
    const merged = deepMergeDefaults({ list: [1, 2, 3] }, { list: [9] });
    expect(merged.list).toEqual([9]);
  });

  it("does not share references with the defaults it clones in", () => {
    const defaults = { nested: { inner: { v: 1 } } };
    const merged = deepMergeDefaults(defaults, {});
    (merged.nested as { inner: { v: number } }).inner.v = 42;
    expect(defaults.nested.inner.v).toBe(1);
  });
});

describe("migrateSettingsToCurrentSchema", () => {
  it("stamps the current version and prunes every legacy key from v0 data", () => {
    const raw: Record<string, unknown> = {
      licenseKey: "abc",
      customProviders: [{ id: "openrouter", name: "OpenRouter", isEnabled: true }],
    };
    for (const key of LEGACY_KEYS_REMOVED_IN_V1) raw[key] = "legacy-value";

    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);

    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.future).toBe(false);
    expect(result.appliedSteps.length).toBeGreaterThan(0);
    expect(result.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    for (const key of LEGACY_KEYS_REMOVED_IN_V1) {
      expect(result.settings).not.toHaveProperty(key);
    }
  });

  it("removes retired provider credentials while preserving managed account state", () => {
    const raw = {
      licenseKey: "user-key",
      licenseValid: true,
      customProviders: [
        { id: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", apiKey: "k", isEnabled: true },
      ],
    };
    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);
    expect(result.settings).not.toHaveProperty("customProviders");
    expect(result.settings.licenseKey).toBe("user-key");
    expect(result.settings.licenseValid).toBe(true);
  });

  it("upgrades schema v3 to v4 by deleting every retired client authority key", () => {
    const raw: Record<string, unknown> = {
      schemaVersion: 3,
      licenseKey: "managed-license",
      licenseValid: true,
      chatsDirectory: "Vault/Chats",
    };
    for (const key of LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4) {
      raw[key] = key.includes("Key") || key.includes("Auth")
        ? "sentinel-secret"
        : { retired: true };
    }

    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);

    expect(result.appliedSteps).toContain(
      "Remove retired client-side provider, model, Pi auth, and BYOK settings",
    );
    for (const key of LEGACY_CLIENT_MODEL_KEYS_REMOVED_IN_V4) {
      expect(result.settings).not.toHaveProperty(key);
    }
    expect(result.settings).toMatchObject({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      licenseKey: "managed-license",
      licenseValid: true,
      chatsDirectory: "Vault/Chats",
    });
  });

  it("prunes retired disclosure acceptance when upgrading a schema-v1 settings file", () => {
    const result = migrateSettingsToCurrentSchema({
      schemaVersion: 1,
      licenseKey: "user-key",
      managedDisclosureAcceptance: { version: "legacy", acceptedAt: "2026-07-11T00:00:00Z" },
    }, DEFAULT_SETTINGS);
    expect(result.appliedSteps).toContain("Remove retired managed disclosure acceptance");
    expect(result.settings).not.toHaveProperty("managedDisclosureAcceptance");
    expect(result.settings.licenseKey).toBe("user-key");
  });

  it("prunes configurable embeddings provider and retry fields when upgrading schema v2", () => {
    const raw: Record<string, unknown> = { schemaVersion: 2, licenseKey: "user-key" };
    for (const key of LEGACY_EMBEDDINGS_KEYS_REMOVED_IN_V3) raw[key] = "legacy-value";

    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);

    expect(result.appliedSteps).toContain("Remove legacy configurable embeddings provider and retry controls");
    for (const key of LEGACY_EMBEDDINGS_KEYS_REMOVED_IN_V3) {
      expect(result.settings).not.toHaveProperty(key);
    }
    expect(result.settings.licenseKey).toBe("user-key");
  });

  it("removes client-owned chat prompts, modes, reasoning preferences, and obsolete directory state in v5", () => {
    const raw: Record<string, unknown> = { schemaVersion: 4, licenseKey: "managed-license" };
    for (const key of LEGACY_CHAT_KEYS_REMOVED_IN_V5) raw[key] = "retired";
    for (const key of LEGACY_DIRECTORY_KEYS_REMOVED_IN_V5) raw[key] = "retired";

    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);

    expect(result.appliedSteps).toContain("Remove retired client-owned chat prompt, mode, and directory settings");
    for (const key of LEGACY_CHAT_KEYS_REMOVED_IN_V5) expect(result.settings).not.toHaveProperty(key);
    for (const key of LEGACY_DIRECTORY_KEYS_REMOVED_IN_V5) expect(result.settings).not.toHaveProperty(key);
    expect(result.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.settings.licenseKey).toBe("managed-license");
  });

  it("removes orphaned feature and model-routing state when upgrading schema v5", () => {
    const raw: Record<string, unknown> = { schemaVersion: 5, licenseKey: "managed-license" };
    for (const key of LEGACY_FEATURE_KEYS_REMOVED_IN_V6) raw[key] = { retired: true };

    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);

    expect(result.appliedSteps).toContain("Remove orphaned feature, model-routing, and modal-state settings");
    for (const key of LEGACY_FEATURE_KEYS_REMOVED_IN_V6) expect(result.settings).not.toHaveProperty(key);
    expect(result.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.settings.licenseKey).toBe("managed-license");
  });

  it("removes the obsolete auto-process switch when upgrading schema v6", () => {
    const raw: Record<string, unknown> = {
      schemaVersion: 6,
      embeddingsEnabled: true,
      embeddingsAutoProcess: false,
    };

    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);

    expect(result.appliedSteps).toContain("Remove the retired semantic-index auto-process switch");
    for (const key of LEGACY_SEMANTIC_INDEX_KEYS_REMOVED_IN_V7) {
      expect(result.settings).not.toHaveProperty(key);
    }
    expect(result.settings.embeddingsEnabled).toBe(true);
    expect(result.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("removes duplicate plugin-update state when upgrading schema v7", () => {
    const raw: Record<string, unknown> = {
      schemaVersion: 7,
      showUpdateNotifications: false,
      lastKnownVersion: "1.2.3",
    };

    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);

    expect(result.appliedSteps).toContain("Remove duplicate plugin-update notification state");
    for (const key of LEGACY_UPDATE_KEYS_REMOVED_IN_V8) {
      expect(result.settings).not.toHaveProperty(key);
    }
    expect(result.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("back-fills brand-new install defaults for empty persisted data", () => {
    const result = migrateSettingsToCurrentSchema({}, DEFAULT_SETTINGS);
    expect(result.settings.chatsDirectory).toBe(DEFAULT_SETTINGS.chatsDirectory);
    expect(result.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("is idempotent — re-running on already-migrated data is a no-op for version", () => {
    const once = migrateSettingsToCurrentSchema({ licenseKey: "x" }, DEFAULT_SETTINGS);
    const twice = migrateSettingsToCurrentSchema(once.settings, DEFAULT_SETTINGS);
    expect(twice.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(twice.appliedSteps).toHaveLength(0);
    expect(twice.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("never downgrades or prunes newer-than-current (future) data, but still back-fills gaps", () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION + 5,
      someFutureKey: "from-a-newer-build",
      // a legacy key here must NOT be pruned — a future build may have revived it
      selectedProvider: "future-meaning",
    };
    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);
    expect(result.future).toBe(true);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION + 5);
    expect(result.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION + 5);
    expect(result.settings.someFutureKey).toBe("from-a-newer-build");
    expect(result.settings.selectedProvider).toBe("future-meaning");
    expect(result.appliedSteps).toHaveLength(0);
    // still gains current defaults it was missing
    expect(result.settings.chatsDirectory).toBe(DEFAULT_SETTINGS.chatsDirectory);
  });

  it("does not mutate the raw input object", () => {
    const raw = { licenseKey: "x", selectedProvider: "legacy" };
    migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);
    expect(raw).toHaveProperty("selectedProvider", "legacy");
    expect(raw).not.toHaveProperty("schemaVersion");
  });
});

describe("findMissingMigrationVersions (chain-completeness guard, #212)", () => {
  it("reports no gaps for the shipped migration registry", () => {
    expect(findMissingMigrationVersions()).toEqual([]);
  });

  it("detects a missing intermediate step before a future bump", () => {
    const gappy = [
      { to: 1, describe: "v0->v1", migrate: (s: Record<string, unknown>) => s },
      { to: 3, describe: "v2->v3", migrate: (s: Record<string, unknown>) => s },
    ];
    // Bumping to v3 with no v2 step must surface version 2 as missing.
    expect(findMissingMigrationVersions(gappy, 3)).toEqual([2]);
  });
});
