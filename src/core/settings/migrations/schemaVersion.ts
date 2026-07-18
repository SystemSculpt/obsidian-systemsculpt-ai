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
 *  - 3: legacy configurable embeddings provider and retry controls removed.
 *  - 4: client-side provider, model selection, Pi auth, and BYOK state removed.
 *  - 5: client-owned chat prompts, modes, hidden-message preferences, and obsolete directory state removed.
 *  - 6: orphaned feature, model-routing, and modal-state fields removed.
 *  - 7: retired the semantic-index auto-process switch; enabled now means automatic.
 *  - 8: retired duplicate plugin-update notification state; Obsidian owns updates.
 *  - 9: retired recorder prompt-source, format-chooser, and resampling state.
 *  - 10: moved microphone preference to vault-scoped device-local storage.
 *  - 11: removed obsolete top-level transcription language overrides; transcription now auto-detects source language.
 *  - 12: removed retired user-configured workflow automations, backlog state, and automation skip records.
 */
export const CURRENT_SCHEMA_VERSION = 12;
