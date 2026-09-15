import type SystemSculptPlugin from "../main";
import { ManagedImageModelCatalog } from "../services/images/ManagedImageModelCatalog";
import { ManagedVideoModelCatalog } from "../services/videos/ManagedVideoModelCatalog";

export type StudioMediaCatalogs = Readonly<{
  images: ManagedImageModelCatalog;
  videos: ManagedVideoModelCatalog;
}>;

type Entry = { licenseKey: string; catalogs: StudioMediaCatalogs };
const entries = new WeakMap<SystemSculptPlugin, Entry>();

/**
 * One image and one video catalog per plugin, shared by the pickers, the
 * inline option lists, card input gating, and execution. Switching the
 * license discards the cache so another account's prices never show.
 */
export function getStudioMediaCatalogs(plugin: SystemSculptPlugin): StudioMediaCatalogs {
  const licenseKey = String(plugin.settings?.licenseKey ?? "");
  const existing = entries.get(plugin);
  if (existing && existing.licenseKey === licenseKey) return existing.catalogs;
  const transport = plugin.getManagedCapabilityGraph().transport;
  const catalogs: StudioMediaCatalogs = Object.freeze({
    images: new ManagedImageModelCatalog(transport),
    videos: new ManagedVideoModelCatalog(transport),
  });
  entries.set(plugin, { licenseKey, catalogs });
  return catalogs;
}
