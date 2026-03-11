export async function loadStandardModelSelectionModalModule(): Promise<
  typeof import("../../modals/StandardModelSelectionModal")
> {
  return await import("../../modals/StandardModelSelectionModal");
}

export async function loadPiTextMigrationModule(): Promise<
  typeof import("../../services/pi-native/PiTextMigration")
> {
  return await import("../../services/pi-native/PiTextMigration");
}
