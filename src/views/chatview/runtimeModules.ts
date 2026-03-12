export async function loadPiTextMigrationModule(): Promise<
  typeof import("../../services/pi-native/PiTextMigration")
> {
  return await import("../../services/pi-native/PiTextMigration");
}
