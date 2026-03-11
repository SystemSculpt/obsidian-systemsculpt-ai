import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { buildManagedSystemSculptModel } from "../systemsculpt/ManagedSystemSculptModel";

export async function listPiTextCatalogModels(
  plugin: SystemSculptPlugin
): Promise<SystemSculptModel[]> {
  return [buildManagedSystemSculptModel(plugin)];
}
