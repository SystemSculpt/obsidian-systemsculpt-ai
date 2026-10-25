/** @jest-environment jsdom */
import { App, ItemView, Scope, WorkspaceLeaf } from "obsidian";
import { parseManagedVideoModelCatalog } from "../../../services/videos/ManagedVideoModelCatalog";
import { getStudioMediaCatalogs } from "../../../studio/StudioMediaCatalogs";
import { StudioProjectSession } from "../../../studio/StudioProjectSession";
import { createEmptyStudioProject } from "../../../studio/schema";
import { videoGenerationNode } from "../../../studio/nodes/videoGenerationNode";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import * as picker from "../canvas/StudioMediaModelPickerModal";

jest.mock("../../../studio/StudioMediaCatalogs", () => ({ getStudioMediaCatalogs: jest.fn() }));
jest.mock("../canvas/StudioMediaModelPickerModal", () => {
  const actual = jest.requireActual("../canvas/StudioMediaModelPickerModal");
  return { ...actual, openStudioMediaModelPickerModal: jest.fn(actual.openStudioMediaModelPickerModal) };
});

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

it("commits a video model from the rendered catalog, refreshes dependent controls and preserves the authored prompt", async () => {
  const app = new App();
  app.scope = new Scope();
  Object.assign(app.workspace, { requestSaveLayout: jest.fn() });
  const host = ItemView.prototype as unknown as { setState?: () => Promise<void> };
  const originalSetState = host.setState;
  host.setState = async () => {};
  const model = (id: string, name: string, resolution: string, duration: number, aspectRatio: string) => ({
    id, name, provider: "Maker", best_for: "Clips", supports_audio_toggle: true, default_generate_audio: true,
    supported_frame_roles: ["first_frame"], default_resolution: resolution, allowed_resolutions: [resolution, "480p"],
    default_aspect_ratio: aspectRatio, allowed_aspect_ratios: [aspectRatio, "1:1"], default_duration_seconds: duration,
    allowed_durations_seconds: [duration, duration + 1], estimates: [{ resolution, generate_audio: true, duration_seconds: duration, estimated_credits: 400 }],
  });
  const catalog = parseManagedVideoModelCatalog({
    contract: "systemsculpt-media-models-v1",
    models: [model("old", "Old model", "1080p", 8, "16:9"), model("new", "New model", "720p", 4, "9:16")],
  });
  jest.mocked(getStudioMediaCatalogs).mockReturnValue({ videos: { load: async () => catalog, peek: () => catalog } } as ReturnType<typeof getStudioMediaCatalogs>);
  const openPicker = jest.mocked(picker.openStudioMediaModelPickerModal);
  let disk = createEmptyStudioProject({ name: "Video options", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  disk.graph.layout = { mode: "manual" };
  disk.graph.nodes = [{
    id: "video", kind: videoGenerationNode.kind, version: videoGenerationNode.version,
    title: "Video", position: { x: 0, y: 0 },
    config: { ...videoGenerationNode.configDefaults, model: "old", resolution: "1080p", durationSeconds: "8", aspectRatio: "16:9" },
  }];
  const session = new StudioProjectSession({ projectPath: "Studio/Video.systemsculpt", project: disk,
    saveProject: async (_path, desired) => { disk = desired; return { project: disk, conflicts: [] }; },
  });
  const service = {
    subscribeRunEvents: () => () => {}, getActiveRun: () => null, getLatestRunEvents: async () => [],
    agentRuns: { subscribe: () => () => {}, list: () => [] }, listNodeDefinitions: () => [videoGenerationNode],
    retainProjectSession: async () => session, releaseProjectSession: async () => {},
    getProjectNodeCache: async () => null, consumeBlockedProjectRecovery: async () => null,
  };
  const view = new SystemSculptStudioView(new WorkspaceLeaf(app), { app, getStudioService: () => service, settings: {} } as any);
  Object.assign(view.contentEl, { onWindowMigrated: () => () => {} });
  document.body.appendChild(view.containerEl);
  try {
    await view.onOpen();
    await view.setState({ file: "Studio/Video.systemsculpt" }, {} as any);
    await flush();
    const field = (key: string) => view.contentEl.querySelector<HTMLElement>(`.ss-studio-node-inline-config-field--${key.toLowerCase()}`)!;
    const prompt = () => field("prompt").querySelector<HTMLTextAreaElement>("textarea")!;
    const trigger = () => field("model").querySelector<HTMLButtonElement>('[data-testid="studio.media-model-picker.trigger"]')!;
    prompt().value = "a lighthouse at dusk";
    prompt().dispatchEvent(new Event("input", { bubbles: true }));
    expect(field("resolution").textContent).toContain("1080p");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    trigger().click();
    await flush();
    expect(openPicker).toHaveBeenCalledTimes(1);
    const modal = openPicker.mock.results[0].value as ReturnType<typeof picker.openStudioMediaModelPickerModal>;
    modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="studio.media-model-picker.model"][data-model-id="new"]')!.click();
    await flush();
    expect(trigger().textContent).toContain("New model");
    expect(trigger().textContent).toContain("~400 credits/clip");
    for (const key of ["durationSeconds", "resolution", "aspectRatio"]) {
      expect(field(key).querySelector("button")!.textContent).toContain("Model default");
    }
    expect(prompt().value).toBe("a lighthouse at dusk");
    field("resolution").querySelector<HTMLButtonElement>("button")!.click();
    await flush();
    expect(field("resolution").textContent).not.toContain("1080p");
    expect(field("resolution").textContent).toContain("720p");
    await session.flushPendingSaveWork();
    expect(disk.graph.nodes[0].config).toMatchObject({
      model: "new", durationSeconds: "", resolution: "", aspectRatio: "", prompt: "a lighthouse at dusk", generateAudio: true,
    });
  } finally {
    await view.onClose();
    view.containerEl.remove();
    await session.close();
    host.setState = originalSetState;
    jest.restoreAllMocks();
  }
});
