import { App } from "obsidian";
import { StandardModal } from "../../../core/ui/modals/standard/StandardModal";
import { createUiAction, updateUiAction } from "../../../core/ui/surface/SurfacePrimitives";
import type { ManagedImageModel } from "../../../services/images/ManagedImageModelCatalog";
import { findManagedVideoEstimate, type ManagedVideoModel } from "../../../services/videos/ManagedVideoModelCatalog";
import { describeStudioMediaModelInputs, type StudioMediaModelKind } from "../../../studio/StudioMediaModelCapabilities";

export type StudioMediaModelPickerModel = ManagedImageModel | ManagedVideoModel;

export type StudioMediaModelPickerModalOptions = {
  kind: StudioMediaModelKind;
  models: readonly StudioMediaModelPickerModel[];
  selectedId: string;
  onSelect: (model: StudioMediaModelPickerModel) => void;
  onClose?: (selected: boolean) => void;
  favoriteIds?: readonly string[];
  /** Persists the toggle and resolves to the model's new favorite state. */
  onToggleFavorite?: (modelId: string) => Promise<boolean>;
};

export type StudioMediaModelSortKey = "released" | "recommended" | "price-asc" | "price-desc" | "speed";

const SORT_CHOICES: readonly { key: StudioMediaModelSortKey; label: string }[] = [
  { key: "released", label: "Release date" },
  { key: "recommended", label: "Recommended" },
  { key: "price-asc", label: "Cheapest" },
  { key: "price-desc", label: "Premium" },
  { key: "speed", label: "Fastest" },
];

/** A group with no label renders as a plain run of cards under no heading. */
export type StudioMediaModelGroup = { key: string; label: string; models: StudioMediaModelPickerModel[] };

// Session-scoped: reopening the picker keeps the last sort per media kind.
const lastSortByKind = new Map<StudioMediaModelKind, StudioMediaModelSortKey>();

function credits(value: number): string {
  return Number.isFinite(value) && value > 0 ? (Number.isInteger(value) ? String(value) : value.toFixed(1)) : "n/a";
}

export function isStudioImageModel(model: StudioMediaModelPickerModel): model is ManagedImageModel {
  return "supportsImageInput" in model;
}

/**
 * Providers charge more for larger images, so a model with size tiers is
 * quoted as a range. One number would price every selection at the smallest
 * size the model offers.
 */
function imagePriceLabel(model: ManagedImageModel): string {
  const tiers = model.sizeEstimates.map(estimate => estimate.estimatedCredits).filter(value => Number.isFinite(value) && value > 0);
  const low = Math.min(...tiers);
  const high = Math.max(...tiers);
  return tiers.length > 1 && high > low
    ? `~${credits(low)}-${credits(high)} credits/image`
    : `~${credits(model.estimatedCredits)} credits/image`;
}

function defaultVideoEstimate(model: ManagedVideoModel) {
  return findManagedVideoEstimate(model, {
    resolution: model.defaultResolution,
    generateAudio: model.defaultGenerateAudio,
    durationSeconds: model.defaultDurationSeconds,
  });
}

/** Short price for a trigger chip or card heading. */
export function studioMediaModelPriceLabel(model: StudioMediaModelPickerModel): string {
  if (isStudioImageModel(model)) return imagePriceLabel(model);
  const estimate = defaultVideoEstimate(model);
  if (!estimate) return "Priced per job";
  return `~${credits(estimate.estimatedCredits)} credits · ${estimate.durationSeconds}s ${estimate.resolution}`;
}

/**
 * Comparable price in credits: per image for image models, per output second
 * at the model's default selection for video models (durations differ, so a
 * per-clip number would make long-clip models look expensive). Null when the
 * server published no usable estimate; those sort last under either order.
 */
export function studioMediaModelPriceKey(model: StudioMediaModelPickerModel): number | null {
  if (isStudioImageModel(model)) {
    return Number.isFinite(model.estimatedCredits) && model.estimatedCredits > 0 ? model.estimatedCredits : null;
  }
  const estimate = defaultVideoEstimate(model);
  if (!estimate || !Number.isFinite(estimate.estimatedCredits) || estimate.estimatedCredits <= 0) return null;
  return estimate.estimatedCredits / Math.max(1, estimate.durationSeconds);
}

function releasedAtMs(model: StudioMediaModelPickerModel): number | null {
  if (!model.releasedAt) return null;
  const parsed = Date.parse(model.releasedAt);
  return Number.isNaN(parsed) ? null : parsed;
}

export function sortStudioMediaModels(models: readonly StudioMediaModelPickerModel[], sort: StudioMediaModelSortKey): StudioMediaModelPickerModel[] {
  const list = [...models];
  if (sort === "recommended") return list;
  const key = (model: StudioMediaModelPickerModel): number | null => {
    if (sort === "speed") return model.typicalDurationMs;
    if (sort === "released") return releasedAtMs(model);
    return studioMediaModelPriceKey(model);
  };
  const ascending = sort === "price-asc" || sort === "speed";
  // Stable sort keeps the server's recommended order inside ties; models
  // without data always trail regardless of direction.
  return list.sort((a, b) => {
    const aKey = key(a);
    const bKey = key(b);
    if (aKey === null && bKey === null) return 0;
    if (aKey === null) return 1;
    if (bKey === null) return -1;
    return ascending ? aKey - bKey : bKey - aKey;
  });
}

export function filterStudioMediaModels(models: readonly StudioMediaModelPickerModel[], query: string): StudioMediaModelPickerModel[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...models];
  return models.filter(model => {
    const details = [model.name, model.provider, model.id, model.description, ...model.inputModalities, ...describeStudioMediaModelInputs(model)];
    if (!isStudioImageModel(model)) details.push(...model.resolutions, ...model.aspectRatios);
    else details.push(...model.imageSizes, ...model.aspectRatios, ...model.qualities);
    return details.join(" ").toLowerCase().includes(normalized);
  });
}

/**
 * Favorites lead every order, including the server's recommended one: a user
 * who stars a model is saying it should be the first thing they see. The sort
 * is stable, so the chosen order still decides the run inside each group.
 */
export function pinFavoriteStudioMediaModels(models: readonly StudioMediaModelPickerModel[], favoriteIds: ReadonlySet<string>): StudioMediaModelPickerModel[] {
  if (favoriteIds.size === 0) return [...models];
  const favorites = models.filter(model => favoriteIds.has(model.id));
  return favorites.length === 0 ? [...models] : [...favorites, ...models.filter(model => !favoriteIds.has(model.id))];
}

/**
 * Release dates arrive as a plain YYYY-MM-DD day, so the month is read off the
 * string. Parsing to a Date first resolves midnight UTC in the local zone,
 * which drops the first of a month into the one before it for every user west
 * of UTC — exactly the boundary a month heading must get right.
 */
function releaseMonthKey(model: StudioMediaModelPickerModel): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(model.releasedAt ?? "");
  return match ? `${match[1]}-${match[2]}` : null;
}

function releaseMonthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * The release order is the only one where a heading means anything, so it is
 * the only one that gets sections. Favorites lead as their own section rather
 * than inside their month; a model appears exactly once.
 */
export function groupStudioMediaModels(models: readonly StudioMediaModelPickerModel[], sort: StudioMediaModelSortKey, favoriteIds: ReadonlySet<string>): StudioMediaModelGroup[] {
  if (sort !== "released") {
    const flat = pinFavoriteStudioMediaModels(models, favoriteIds);
    return flat.length === 0 ? [] : [{ key: "all", label: "", models: flat }];
  }
  const groups: StudioMediaModelGroup[] = [];
  const favorites = models.filter(model => favoriteIds.has(model.id));
  if (favorites.length > 0) groups.push({ key: "favorites", label: "Favorites", models: favorites });
  // Insertion order is the caller's release order, so months come out newest
  // first and each month keeps its newest model at the top.
  const byMonth = new Map<string, StudioMediaModelPickerModel[]>();
  const undated: StudioMediaModelPickerModel[] = [];
  for (const model of models) {
    if (favoriteIds.has(model.id)) continue;
    const month = releaseMonthKey(model);
    if (month === null) {
      undated.push(model);
      continue;
    }
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(model);
    else byMonth.set(month, [model]);
  }
  for (const [key, grouped] of byMonth) groups.push({ key, label: releaseMonthLabel(key), models: grouped });
  if (undated.length > 0) groups.push({ key: "undated", label: "Release date unknown", models: undated });
  return groups;
}

function formatTypicalDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `~${seconds}s to generate`;
  return `~${Math.round(seconds / 60)} min to generate`;
}

function formatRange(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  return `${values[0]}–${values[values.length - 1]}`;
}

function formatDurationRange(values: readonly number[]): string {
  if (values.length === 0) return "";
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return `${sorted[0]}s clips`;
  return `${sorted[0]}–${sorted[sorted.length - 1]}s clips`;
}

/** Capability tags: what the model takes first, then what it can produce. */
export function studioMediaModelTags(model: StudioMediaModelPickerModel): string[] {
  const tags = describeStudioMediaModelInputs(model);
  if (isStudioImageModel(model)) {
    if (model.imageSizes.length > 0) tags.push(formatRange(model.imageSizes));
    if (model.qualities.length > 0) tags.push(`${model.qualities.length} quality levels`);
    tags.push(`${model.aspectRatios.length} aspect ratios`);
    return tags;
  }
  if (model.resolutions.length > 0) tags.push(model.resolutions.join(" · "));
  if (model.durationsSeconds.length > 0) tags.push(formatDurationRange(model.durationsSeconds));
  if (model.aspectRatios.length > 0) tags.push(`${model.aspectRatios.length} aspect ratios`);
  return tags;
}

export function openStudioMediaModelPickerModal(app: App, options: StudioMediaModelPickerModalOptions): StudioMediaModelPickerModal {
  const modal = new StudioMediaModelPickerModal(app, options);
  modal.open();
  return modal;
}

export class StudioMediaModelPickerModal extends StandardModal {
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private sortBarEl: HTMLElement | null = null;
  private query = "";
  private sort: StudioMediaModelSortKey;
  private revealSelectedOnce = true;
  private selectedModel = false;
  private readonly favorites: Set<string>;

  constructor(app: App, private readonly options: StudioMediaModelPickerModalOptions) {
    super(app);
    this.favorites = new Set(options.favoriteIds ?? []);
    this.setSize("large");
    this.modalEl.addClass("ss-studio-media-model-picker-modal-shell");
    this.sort = lastSortByKind.get(options.kind) ?? "released";
    if (!this.availableSortKeys().includes(this.sort)) this.sort = "recommended";
  }

  onOpen(): void {
    super.onOpen();
    const kindLabel = this.options.kind === "image" ? "Image" : "Video";
    this.addTitle(`${kindLabel} generation models`, "Every currently available model with what it accepts and its server-computed price. Select one to use it in this node.");
    this.contentEl.addClass("ss-studio-media-model-picker-modal");
    const searchInput = this.addSearchBar("studio.media-model-picker.search", "Search models, providers, or capabilities", (query) => {
      this.query = query;
      this.renderModels();
    });
    const toolbarEl = this.contentEl.createDiv({ cls: "ss-studio-media-model-picker-toolbar" });
    this.sortBarEl = toolbarEl.createDiv({ cls: "ss-studio-media-model-picker-sortbar", attr: { role: "group", "aria-label": "Sort models" } });
    this.countEl = toolbarEl.createDiv({ cls: "ss-studio-media-model-picker-count", attr: { "aria-live": "polite" } });
    this.listEl = this.contentEl.createDiv({ cls: "ss-studio-media-model-picker-list" });
    this.renderSortBar();
    this.renderModels();
    // Touch hosts open the on-screen keyboard on focus, hiding half the list;
    // only pre-focus search where a hardware keyboard is the norm.
    const win = this.modalEl.ownerDocument.defaultView;
    if (!win?.matchMedia?.("(pointer: coarse)").matches) searchInput.focus();
  }

  private availableSortKeys(): StudioMediaModelSortKey[] {
    const models = this.options.models;
    return SORT_CHOICES.map(choice => choice.key).filter(key => {
      if (key === "speed") return models.some(model => model.typicalDurationMs !== null);
      if (key === "released") return models.some(model => releasedAtMs(model) !== null);
      if (key === "price-asc" || key === "price-desc") return models.some(model => studioMediaModelPriceKey(model) !== null);
      return true;
    });
  }

  private renderSortBar(): void {
    if (!this.sortBarEl) return;
    this.sortBarEl.empty();
    const available = this.availableSortKeys();
    if (available.length <= 1) return;
    for (const choice of SORT_CHOICES) {
      if (!available.includes(choice.key)) continue;
      const active = choice.key === this.sort;
      const chip = this.sortBarEl.createEl("button", {
        cls: `ss-studio-media-model-picker-sort-chip${active ? " is-active" : ""}`,
        text: choice.label,
        attr: { type: "button", "aria-pressed": active ? "true" : "false", "data-testid": `studio.media-model-picker.sort.${choice.key}` },
      });
      chip.addEventListener("click", () => {
        if (this.sort === choice.key) return;
        this.sort = choice.key;
        lastSortByKind.set(this.options.kind, choice.key);
        this.renderSortBar();
        this.renderModels();
      });
    }
  }

  private renderModels(): void {
    if (!this.listEl || !this.countEl) return;
    this.listEl.empty();
    const filtered = sortStudioMediaModels(filterStudioMediaModels(this.options.models, this.query), this.sort);
    this.countEl.setText(
      filtered.length === this.options.models.length
        ? `${filtered.length} model${filtered.length === 1 ? "" : "s"}`
        : `${filtered.length} of ${this.options.models.length} models`,
    );
    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: "ss-studio-media-model-picker-empty", text: "No models match this search." });
      return;
    }
    for (const group of groupStudioMediaModels(filtered, this.sort, this.favorites)) {
      if (group.label) this.renderGroupHeading(group);
      for (const model of group.models) this.renderModelCard(model);
    }
    if (this.revealSelectedOnce) {
      this.revealSelectedOnce = false;
      const selectedCard = this.listEl.querySelector(".is-selected");
      if (selectedCard instanceof HTMLElement && typeof selectedCard.scrollIntoView === "function") {
        selectedCard.scrollIntoView({ block: "nearest" });
      }
    }
  }

  /** Spans the whole card grid, so a month always starts its own row. */
  private renderGroupHeading(group: StudioMediaModelGroup): void {
    if (!this.listEl) return;
    const heading = this.listEl.createDiv({ cls: "ss-studio-media-model-picker-group", attr: { "data-testid": "studio.media-model-picker.group", "data-group": group.key } });
    heading.createSpan({ cls: "ss-studio-media-model-picker-group-label", text: group.label });
    heading.createSpan({ cls: "ss-studio-media-model-picker-group-count", text: String(group.models.length) });
  }

  private renderModelCard(model: StudioMediaModelPickerModel): void {
    if (!this.listEl) return;
    const selected = model.id === this.options.selectedId;
    // The star is a sibling of the card, not a child: a button cannot legally
    // contain another button, and nesting one breaks click handling.
    const shell = this.listEl.createDiv({ cls: "ss-studio-media-model-picker-card-shell" });
    const button = shell.createEl("button", {
      cls: `ss-studio-media-model-picker-card${selected ? " is-selected" : ""}`,
      attr: { type: "button", "aria-pressed": selected ? "true" : "false", "data-testid": "studio.media-model-picker.model", "data-model-id": model.id },
    });

    const heading = button.createDiv({ cls: "ss-studio-media-model-picker-card-heading" });
    const nameWrap = heading.createDiv({ cls: "ss-studio-media-model-picker-card-name-wrap" });
    nameWrap.createSpan({ cls: "ss-studio-media-model-picker-card-name", text: model.name });
    if (isStudioImageModel(model) && model.isDefault) {
      nameWrap.createSpan({ cls: "ss-studio-media-model-picker-card-default", text: "Default" });
    }
    heading.createSpan({ cls: "ss-studio-media-model-picker-card-price", text: studioMediaModelPriceLabel(model) });

    const provider = button.createDiv({ cls: "ss-studio-media-model-picker-card-provider" });
    provider.createSpan({ text: model.provider });
    provider.createSpan({ cls: "ss-studio-media-model-picker-card-id", text: model.id });
    if (selected) provider.createSpan({ cls: "ss-studio-media-model-picker-card-selected", text: "✓ Selected" });

    button.createDiv({ cls: "ss-studio-media-model-picker-card-description", text: model.description });

    const tags = button.createDiv({ cls: "ss-studio-media-model-picker-card-tags" });
    for (const label of studioMediaModelTags(model)) tags.createSpan({ cls: "ss-studio-media-model-picker-card-tag", text: label });

    const foot: string[] = [];
    const typical = formatTypicalDuration(model.typicalDurationMs);
    if (typical) foot.push(typical);
    if (isStudioImageModel(model) && model.reservationCredits) foot.push(`Hold from ${credits(model.reservationCredits)} credits`);
    if (foot.length > 0) {
      const footEl = button.createDiv({ cls: "ss-studio-media-model-picker-card-foot" });
      for (const text of foot) footEl.createSpan({ text });
    }

    button.addEventListener("click", () => {
      this.selectedModel = true;
      this.options.onSelect(model);
      this.close();
    });

    this.renderFavoriteToggle(shell, model.id);
  }

  onClose(): void {
    this.options.onClose?.(this.selectedModel);
    super.onClose();
  }

  /**
   * Toggling restyles the star in place instead of re-sorting the list: a card
   * that jumps out from under the pointer is worse than favorites settling
   * into place the next time the list is built.
   */
  private renderFavoriteToggle(shell: HTMLElement, modelId: string): void {
    const { onToggleFavorite } = this.options;
    if (!onToggleFavorite) return;
    const favorite = this.favorites.has(modelId);
    const star = createUiAction(shell, {
      label: favorite ? "Remove favorite" : "Add favorite",
      testId: "studio.media-model-picker.favorite",
      icon: favorite ? "star" : "star-off",
      size: "icon",
      selected: favorite,
    });
    star.addClass("ss-studio-media-model-picker-favorite");
    star.toggleClass("is-favorite", favorite);
    star.dataset.modelId = modelId;
    star.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      star.disabled = true;
      void onToggleFavorite(modelId)
        .then((nextState) => {
          if (nextState) this.favorites.add(modelId);
          else this.favorites.delete(modelId);
          updateUiAction(star, { label: nextState ? "Remove favorite" : "Add favorite", icon: nextState ? "star" : "star-off", selected: nextState });
          star.toggleClass("is-favorite", nextState);
        })
        .catch(() => undefined)
        .finally(() => {
          star.disabled = false;
        });
    });
  }
}
