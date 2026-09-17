/** @jest-environment jsdom */
import { App } from "obsidian";
import { parseManagedImageModelCatalog } from "../../../../services/images/ManagedImageModelCatalog";
import { parseManagedVideoModelCatalog } from "../../../../services/videos/ManagedVideoModelCatalog";
import {
  filterStudioMediaModels,
  groupStudioMediaModels,
  openStudioMediaModelPickerModal,
  sortStudioMediaModels,
  studioMediaModelPriceLabel,
  studioMediaModelTags,
  type StudioMediaModelPickerModel,
} from "../StudioMediaModelPickerModal";

const image = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id.split("/")[1], provider: "Maker", best_for: `${id} art.`, is_default: false, supports_image_input: true, supports_seed: false,
  estimated_cost_per_image_credits: 50, max_images_per_job: 4, allowed_aspect_ratios: ["1:1"], allowed_image_sizes: [], input_schema: { inputs: [] },
  released_at: "2026-08-02", typical_duration_ms: 20_000, ...overrides,
});
const imageModels = (): StudioMediaModelPickerModel[] => [...parseManagedImageModelCatalog({
  contract: "systemsculpt-media-models-v1", default_model_id: "maker/alpha",
  models: [
    image("maker/alpha", { is_default: true, estimates: [{ image_size: "1K", estimated_cost_per_image_credits: 40 }, { image_size: "4K", estimated_cost_per_image_credits: 160 }], allowed_image_sizes: ["1K", "4K"] }),
    image("maker/beta", { estimated_cost_per_image_credits: 20, released_at: "2026-07-10", supports_image_input: false, typical_duration_ms: 5_000 }),
    image("maker/gamma", { estimated_cost_per_image_credits: 90, released_at: null, typical_duration_ms: null }),
  ],
}).models];
const videoModels = (): StudioMediaModelPickerModel[] => [...parseManagedVideoModelCatalog({
  contract: "systemsculpt-media-models-v1",
  models: [{
    id: "maker/clip", name: "Clip", provider: "Maker", best_for: "Short shots.", supports_audio_toggle: true, default_generate_audio: true,
    supported_frame_roles: ["first_frame", "last_frame"], default_resolution: "1080p", allowed_resolutions: ["720p", "1080p"],
    default_aspect_ratio: "16:9", allowed_aspect_ratios: ["16:9", "9:16"], default_duration_seconds: 8, allowed_durations_seconds: [4, 8],
    estimates: [{ resolution: "1080p", generate_audio: true, duration_seconds: 8, estimated_credits: 400 }],
  }],
}).models];

describe("model picker helpers", () => {
  it("prices, tags, sorts, filters, and groups models by what they accept", () => {
    const [alpha, beta, gamma] = imageModels();
    expect(studioMediaModelPriceLabel(alpha)).toBe("~40-160 credits/image");
    expect(studioMediaModelPriceLabel(beta)).toBe("~20 credits/image");
    expect(studioMediaModelTags(beta)[0]).toBe("Text only");
    expect(studioMediaModelTags(alpha)).toEqual(["Image input · up to 4", "Up to 4 per job", "1K–4K", "1 aspect ratios"]);
    expect(studioMediaModelPriceLabel(videoModels()[0])).toBe("~400 credits · 8s 1080p");
    expect(studioMediaModelTags(videoModels()[0])).toEqual(["First + last frame", "Audio", "720p · 1080p", "4–8s clips", "2 aspect ratios"]);
    expect(sortStudioMediaModels([alpha, beta, gamma], "price-asc").map(model => model.id)).toEqual(["maker/beta", "maker/alpha", "maker/gamma"]);
    expect(sortStudioMediaModels([alpha, beta, gamma], "speed").map(model => model.id)).toEqual(["maker/beta", "maker/alpha", "maker/gamma"]);
    expect(filterStudioMediaModels([alpha, beta, gamma], "text only").map(model => model.id)).toEqual(["maker/beta"]);
    const groups = groupStudioMediaModels(sortStudioMediaModels([alpha, beta, gamma], "released"), "released", new Set(["maker/gamma"]));
    expect(groups.map(group => [group.key, group.models.map(model => model.id)])).toEqual([
      ["favorites", ["maker/gamma"]], ["2026-08", ["maker/alpha"]], ["2026-07", ["maker/beta"]],
    ]);
  });
});

describe("StudioMediaModelPickerModal", () => {
  it("lists models with input tags, filters by search, selects on click, and toggles favorites in place", async () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    const onToggleFavorite = jest.fn(async () => true);
    const modal = openStudioMediaModelPickerModal(new App(), {
      kind: "image", models: imageModels(), selectedId: "maker/beta", favoriteIds: ["maker/gamma"], onSelect, onClose, onToggleFavorite,
    });
    const root = modal.modalEl;
    const cards = () => Array.from(root.querySelectorAll<HTMLButtonElement>('[data-testid="studio.media-model-picker.model"]'));
    expect(cards().map(card => card.dataset.modelId)).toEqual(["maker/gamma", "maker/alpha", "maker/beta"]);
    expect(root.querySelector('[data-testid="studio.media-model-picker.group"][data-group="favorites"]')).not.toBeNull();
    expect(cards()[2].getAttribute("aria-pressed")).toBe("true");
    expect(cards()[1].textContent).toContain("Default");
    expect(cards()[2].textContent).toContain("Text only");
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
