import type SystemSculptPlugin from "../../../main";
import type { StudioMediaModelKind } from "../../../studio/StudioMediaModelCapabilities";

/** Retired catalog IDs remain inert in saved preferences. */
export function readMediaModelFavorites(plugin: SystemSculptPlugin, _kind: StudioMediaModelKind): string[] {
  const stored = plugin.settings.favoriteVideoModels;
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
}

/** Toggles one model and resolves to its new favorite state. */
export async function toggleMediaModelFavorite(plugin: SystemSculptPlugin, kind: StudioMediaModelKind, modelId: string): Promise<boolean> {
  const current = readMediaModelFavorites(plugin, kind);
  const nextState = !current.includes(modelId);
  const updated = nextState ? [...current, modelId] : current.filter(id => id !== modelId);
  await plugin.getSettingsManager().updateSettings({ favoriteVideoModels: updated });
  return nextState;
}
