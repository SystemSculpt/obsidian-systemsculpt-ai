/**
 * The settings schema version this build understands. Bump it whenever a
 * release changes the persisted settings shape in a way that needs an explicit
 * transform, and add a matching step to SETTINGS_MIGRATIONS (SettingsMigrator).
 *
 * Kept in its own dependency-free module so both `types.ts` (for
 * DEFAULT_SETTINGS) and the migrator can import it without an import cycle.
 *
 * History:
 *  - 0: pre-versioning data (no `schemaVersion` field). Migrated on first load.
 *  - 1: schema versioning introduced; legacy/dead keys pruned (see #212).
 *  - 2: retired client-side managed disclosure acceptance removed.
 */
export const CURRENT_SCHEMA_VERSION = 2;
