/**
 * Migration harness (#212): settings fixtures captured from past releases must
 * load cleanly into HEAD — no throw, no lost custom providers/license, legacy
 * keys pruned, new nested defaults back-filled, and the schema version stamped.
 *
 * Add a fixture here whenever the persisted settings shape changes across a
 * release so the upgrade path stays permanently guarded in CI. Fixtures live in
 * testing/fixtures/settings/ and represent real-world data.json shapes.
 */
import { DEFAULT_SETTINGS } from "../../../../types";
import {
  CURRENT_SCHEMA_VERSION,
  LEGACY_KEYS_REMOVED_IN_V1,
  migrateSettingsToCurrentSchema,
} from "../SettingsMigrator";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const v4Legacy = require("../../../../../testing/fixtures/settings/v4.x-legacy.json");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const v5PreVersioning = require("../../../../../testing/fixtures/settings/v5.x-pre-versioning.json");

interface SettingsFixture {
  name: string;
  raw: Record<string, unknown>;
}

function stripFixtureMeta(fixture: Record<string, unknown>): Record<string, unknown> {
  const { _fixtureMeta, ...rest } = fixture;
  return rest;
}

const FIXTURES: SettingsFixture[] = [
  { name: "v4.x legacy", raw: stripFixtureMeta(v4Legacy) },
  { name: "v5.x pre-versioning", raw: stripFixtureMeta(v5PreVersioning) },
];

describe("settings migration harness — past releases load cleanly into HEAD (#212)", () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      const result = migrateSettingsToCurrentSchema(fixture.raw, DEFAULT_SETTINGS);

      it("migrates without throwing and stamps the current schema version", () => {
        expect(result.future).toBe(false);
        expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
        expect(result.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      });

      it("prunes every legacy key the fixture carried", () => {
        for (const key of LEGACY_KEYS_REMOVED_IN_V1) {
          expect(result.settings).not.toHaveProperty(key);
        }
      });

      it("preserves the user's custom providers — never wiped by an update (#112)", () => {
        const original = (fixture.raw.customProviders as Array<{ id: string }>) ?? [];
        const migrated = (result.settings.customProviders as Array<{ id: string }>) ?? [];
        expect(migrated).toHaveLength(original.length);
        expect(migrated.map((p) => p.id).sort()).toEqual(original.map((p) => p.id).sort());
      });

      it("preserves the user's license fields", () => {
        expect(result.settings.licenseKey).toBe(fixture.raw.licenseKey);
        expect(result.settings.licenseValid).toBe(fixture.raw.licenseValid);
      });

      it("yields a complete settings shape — every default key back-filled (#100)", () => {
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          expect(result.settings).toHaveProperty(key);
        }
      });
    });
  }

  it("back-fills new nested sub-keys while keeping the fixture's own (#112/#100)", () => {
    const result = migrateSettingsToCurrentSchema(stripFixtureMeta(v5PreVersioning), DEFAULT_SETTINGS);
    const exclusions = result.settings.embeddingsExclusions as Record<string, unknown>;
    // The fixture only set `folders`; the rest must come from current defaults.
    expect(exclusions.folders).toEqual(["Daily Notes"]);
    for (const key of Object.keys(DEFAULT_SETTINGS.embeddingsExclusions as Record<string, unknown>)) {
      expect(exclusions).toHaveProperty(key);
    }
  });
});
