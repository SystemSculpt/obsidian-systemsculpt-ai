import type SystemSculptPlugin from "../main";
import { ManagedImageModelCatalog } from "../services/images/ManagedImageModelCatalog";
import { ManagedVideoModelCatalog } from "../services/videos/ManagedVideoModelCatalog";

export type StudioMediaCatalogs = Readonly<{
  images: ManagedImageModelCatalog;
  videos: ManagedVideoModelCatalog;
}>;

const entries = new WeakMap<SystemSculptPlugin, StudioMediaCatalogs>();

/**
 * One image and one video catalog per plugin, shared by the pickers, the
 * inline option lists, card input gating, and execution. Switching the
 * license discards the cache so another account's prices never show.
 */
export function getStudioMediaCatalogs(plugin: SystemSculptPlugin): StudioMediaCatalogs {
  const existing = entries.get(plugin);
  if (existing) return existing;
  const transport = plugin.getManagedCapabilityGraph().transport;
  const options = { licenseKey: () => String(plugin.settings?.licenseKey ?? "") };
  const catalogs: StudioMediaCatalogs = Object.freeze({
    images: new ManagedImageModelCatalog(transport, options),
    videos: new ManagedVideoModelCatalog(transport, options),
  });
  entries.set(plugin, catalogs);
  return catalogs;
}
