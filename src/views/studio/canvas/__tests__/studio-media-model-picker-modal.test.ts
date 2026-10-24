/** @jest-environment jsdom */
import { App } from "obsidian";
import { parseManagedVideoModelCatalog } from "../../../../services/videos/ManagedVideoModelCatalog";
import {
  filterStudioMediaModels,
  groupStudioMediaModels,
  openStudioMediaModelPickerModal,
  sortStudioMediaModels,
  studioMediaModelPriceKey,
  studioMediaModelPriceLabel,
  studioMediaModelTags,
  type StudioMediaModelPickerModel,
} from "../StudioMediaModelPickerModal";

const video = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id.split("/")[1], provider: "Maker", best_for: `${id} clips.`, supports_audio_toggle: true, default_generate_audio: true,
  supported_frame_roles: ["first_frame", "last_frame"], default_resolution: "1080p", allowed_resolutions: ["720p", "1080p"],
  default_aspect_ratio: "16:9", allowed_aspect_ratios: ["16:9", "9:16"], default_duration_seconds: 8, allowed_durations_seconds: [4, 8],
  estimates: [{ resolution: "1080p", generate_audio: true, duration_seconds: 8, estimated_credits: 400 }],
  released_at: "2026-08-02", typical_duration_ms: 20_000, ...overrides,
});
const videoModels = (): StudioMediaModelPickerModel[] => [...parseManagedVideoModelCatalog({
  contract: "systemsculpt-media-models-v1",
  models: [
    video("maker/alpha"),
    video("maker/beta", {
      released_at: "2026-07-10", typical_duration_ms: 5_000, supported_frame_roles: [], supports_audio_toggle: false, default_generate_audio: false,
      default_duration_seconds: 4, estimates: [{ resolution: "1080p", generate_audio: false, duration_seconds: 4, estimated_credits: 120 }],
    }),
    video("maker/gamma", {
      released_at: null, typical_duration_ms: null,
      estimates: [{ resolution: "1080p", generate_audio: true, duration_seconds: 8, estimated_credits: 900 }],
    }),
  ],
}).models];

describe("model picker helpers", () => {
  it("prices, tags, sorts, filters, and groups models by what they accept", () => {
    const [alpha, beta, gamma] = videoModels();
    expect(studioMediaModelPriceLabel(alpha)).toBe("~400 credits · 8s 1080p");
    expect(studioMediaModelPriceLabel(beta)).toBe("~120 credits · 4s 1080p");
    expect(studioMediaModelPriceKey(alpha)).toBe(50);
    expect(studioMediaModelPriceKey(beta)).toBe(30);
    expect(studioMediaModelTags(beta)[0]).toBe("Text to video");
    expect(studioMediaModelTags(alpha)).toEqual(["First + last frame", "Audio", "720p · 1080p", "4–8s clips", "2 aspect ratios"]);
    expect(sortStudioMediaModels([alpha, beta, gamma], "price-asc").map(model => model.id)).toEqual(["maker/beta", "maker/alpha", "maker/gamma"]);
    expect(sortStudioMediaModels([alpha, beta, gamma], "speed").map(model => model.id)).toEqual(["maker/beta", "maker/alpha", "maker/gamma"]);
    expect(filterStudioMediaModels([alpha, beta, gamma], "text to video").map(model => model.id)).toEqual(["maker/beta"]);
    expect(filterStudioMediaModels([alpha], "720p")).toEqual([alpha]);
    const groups = groupStudioMediaModels(sortStudioMediaModels([alpha, beta, gamma], "released"), "released", new Set(["maker/gamma"]));
    expect(groups.map(group => [group.key, group.models.map(model => model.id)])).toEqual([
      ["favorites", ["maker/gamma"]], ["2026-08", ["maker/alpha"]], ["2026-07", ["maker/beta"]],
    ]);
  });

  it("sorts by credits per second rather than clip price and leaves missing prices last", () => {
    const [alpha, beta] = videoModels();
    const longClip = { ...alpha, defaultDurationSeconds: 20, estimates: [{ resolution: "1080p", generateAudio: true, durationSeconds: 20, estimatedCredits: 500 }] };
    const unpriced = { ...alpha, id: "maker/unpriced", estimates: [] };
    expect(sortStudioMediaModels([beta, longClip, unpriced], "price-asc")).toEqual([longClip, beta, unpriced]);
    expect(sortStudioMediaModels([beta, longClip, unpriced], "price-desc")).toEqual([beta, longClip, unpriced]);
    expect(studioMediaModelPriceLabel(unpriced)).toBe("Priced per job");
  });
});

describe("StudioMediaModelPickerModal", () => {
  it("lists models with input tags, filters by search, selects on click, and toggles favorites in place", async () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    const onToggleFavorite = jest.fn(async () => true);
    const modal = openStudioMediaModelPickerModal(new App(), {
      kind: "video", models: videoModels(), selectedId: "maker/beta", favoriteIds: ["maker/gamma"], onSelect, onClose, onToggleFavorite,
    });
    const root = modal.modalEl;
    expect(root.textContent).toContain("Video generation models");
    const cards = () => Array.from(root.querySelectorAll<HTMLButtonElement>('[data-testid="studio.media-model-picker.model"]'));
    expect(cards().map(card => card.dataset.modelId)).toEqual(["maker/gamma", "maker/alpha", "maker/beta"]);
    expect(root.querySelector('[data-testid="studio.media-model-picker.group"][data-group="favorites"]')).not.toBeNull();
    expect(cards()[2].getAttribute("aria-pressed")).toBe("true");
    expect(cards()[1].textContent).toContain("~400 credits · 8s 1080p");
    expect(cards()[2].textContent).toContain("Text to video");
    expect(root.querySelector(".ss-studio-media-model-picker-count")?.textContent).toBe("3 models");

    const search = root.querySelector<HTMLInputElement>('[data-testid="studio.media-model-picker.search"]')!;
    search.value = "beta";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(cards().map(card => card.dataset.modelId)).toEqual(["maker/beta"]);
    expect(root.querySelector(".ss-studio-media-model-picker-count")?.textContent).toBe("1 of 3 models");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    root.querySelector<HTMLButtonElement>('[data-testid="studio.media-model-picker.sort.price-asc"]')!.click();
    expect(cards().map(card => card.dataset.modelId)).toEqual(["maker/gamma", "maker/beta", "maker/alpha"]);

    const star = root.querySelector<HTMLButtonElement>('[data-testid="studio.media-model-picker.favorite"][data-model-id="maker/beta"]')!;
    star.click();
    expect(onToggleFavorite).toHaveBeenCalledWith("maker/beta");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(star.classList.contains("is-favorite")).toBe(true);
    expect(star.getAttribute("aria-label")).toBe("Remove favorite");
    // The list does not reorder under the pointer; favorites settle on the next open.
    expect(cards().map(card => card.dataset.modelId)).toEqual(["maker/gamma", "maker/beta", "maker/alpha"]);

    cards()[2].click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "maker/alpha" }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("reports a dismissal without a selection", () => {
    const onClose = jest.fn();
    const modal = openStudioMediaModelPickerModal(new App(), { kind: "video", models: videoModels(), selectedId: "", onSelect: jest.fn(), onClose });
    expect(modal.modalEl.textContent).toContain("Video generation models");
    modal.close();
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
