import { DEFAULT_SETTINGS } from "../../../../types";
import {
  CURRENT_SCHEMA_VERSION,
  LEGACY_KEYS_REMOVED_IN_V1,
  deepMergeDefaults,
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

  it("preserves the user's custom providers and license through migration (#112)", () => {
    const raw = {
      licenseKey: "user-key",
      licenseValid: true,
      customProviders: [
        { id: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", apiKey: "k", isEnabled: true },
      ],
    };
    const result = migrateSettingsToCurrentSchema(raw, DEFAULT_SETTINGS);
    expect(result.settings.customProviders).toEqual(raw.customProviders);
    expect(result.settings.licenseKey).toBe("user-key");
    expect(result.settings.licenseValid).toBe(true);
  });

  it("back-fills brand-new install defaults for empty persisted data", () => {
    const result = migrateSettingsToCurrentSchema({}, DEFAULT_SETTINGS);
    expect(result.settings.selectedModelId).toBe(DEFAULT_SETTINGS.selectedModelId);
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
