import { TFile, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { ManagedMediaJobClient } from "../../services/managed/ManagedMediaJobClient";
import { ManagedImageGenerationAdapter } from "../../services/images/ManagedImageGenerationAdapter";
import { ManagedVideoGenerationAdapter } from "../../services/videos/ManagedVideoGenerationAdapter";
import { getVideoGenerationAvailability } from "../../services/videos/VideoGenerationAvailability";
import { getStudioMediaCatalogs } from "../../studio/StudioMediaCatalogs";
import { SYSTEMSCULPT_WEBSITE } from "../../constants/externalServices";
import { SystemSculptToolService } from "./SystemSculptToolService";

const services = new WeakMap<SystemSculptPlugin, SystemSculptToolService>();

type MediaAdapters = Readonly<{ images: ManagedImageGenerationAdapter; videos: ManagedVideoGenerationAdapter }>;

/**
 * One tool service per plugin, over the same hosted media contract Studio
 * uses. Hosted clients are built on the first call, so offering the tools to
 * an agent costs nothing.
 */
export function systemSculptToolService(plugin: SystemSculptPlugin): SystemSculptToolService {
  const existing = services.get(plugin);
  if (existing) return existing;
  let adapters: MediaAdapters | undefined;
  const media = (): MediaAdapters => {
    if (adapters) return adapters;
    const graph = plugin.getManagedCapabilityGraph();
    const jobs = new ManagedMediaJobClient(graph.transport);
    const admission = (signal?: AbortSignal) => graph.admission.checkLicense(signal);
    adapters = {
      images: new ManagedImageGenerationAdapter({ admission, jobs: jobs.images, prepareInputs: jobs.images.prepareInputs, recovery: graph.recovery }),
      videos: new ManagedVideoGenerationAdapter({
        availability: signal => getVideoGenerationAvailability(plugin, {}, signal),
        admission, jobs: jobs.videos, prepareFrames: jobs.images.prepareInputs, recovery: graph.recovery,
      }),
    };
    return adapters;
  };
  const service = new SystemSculptToolService({
    app: plugin.app,
    hasLicenseKey: () => String(plugin.settings?.licenseKey ?? "").trim().length > 0,
    checkLicense: signal => plugin.getManagedCapabilityGraph().admission.checkLicense(signal),
    images: {
      generate: operation => media().images.generate(operation),
      beginLocalCommit: (id, signal) => media().images.beginLocalCommit(id, signal),
      completeLocalCommit: (id, signal) => media().images.completeLocalCommit(id, signal),
    },
    videos: {
      generate: operation => media().videos.generate(operation),
      beginLocalCommit: (id, signal) => media().videos.beginLocalCommit(id, signal),
      markDisplayed: (id, signal) => media().videos.markDisplayed(id, signal),
      markVaultWriteCompleted: (id, signal) => media().videos.markVaultWriteCompleted(id, signal),
      completeLocalCommit: (id, signal) => media().videos.completeLocalCommit(id, signal),
    },
    videoModels: async signal => (await getStudioMediaCatalogs(plugin).videos.load(signal)).models,
    studio: () => plugin.getStudioService(),
    openFile: async (path, active) => {
      const file = plugin.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(file instanceof TFile)) return;
      const workspace = plugin.app.workspace, shown = workspace.getMostRecentLeaf();
      await workspace.getLeaf("tab").openFile(file, { active });
      // A new tab shows in its group even when inactive; put the chat back in front.
      if (!active && shown) workspace.setActiveLeaf(shown, { focus: false });
    },
    links: { subscribe: SYSTEMSCULPT_WEBSITE.MONTHLY_CHAT_TOOLS, credits: SYSTEMSCULPT_WEBSITE.BUY_CREDITS },
  });
  services.set(plugin, service);
  return service;
}
