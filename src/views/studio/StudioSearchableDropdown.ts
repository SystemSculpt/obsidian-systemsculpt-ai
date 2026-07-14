import type { StudioNodeConfigSelectOption } from "../../studio/types";
import { applyPluginSurface, SurfaceCombobox } from "../../core/ui/surface";
import { rankStudioFuzzyItems } from "./StudioFuzzySearch";
import { getStudioOwnerDocument, getStudioOwnerWindow } from "./StudioDomContext";

type StudioSearchableDropdownOptions = {
  containerEl: HTMLElement;
  ariaLabel: string;
  value: string;
  disabled: boolean;
  placeholder?: string;
  noResultsText?: string;
  loadOptions: () => Promise<StudioNodeConfigSelectOption[]>;
  onValueChange: (value: string) => void;
};

export type StudioSearchableDropdownHandle = Readonly<{
  rootEl: HTMLElement;
  destroy: () => void;
}>;

const STUDIO_DROPDOWN_MIN_PANEL_WIDTH_PX = 220;
const STUDIO_DROPDOWN_MAX_PANEL_WIDTH_PX = 760;
const STUDIO_DROPDOWN_ESTIMATED_GLYPH_WIDTH_PX = 7.2;
const STUDIO_DROPDOWN_ESTIMATED_PADDING_PX = 84;
const STUDIO_DROPDOWN_MAX_DESCRIPTION_CHARS_FOR_WIDTH = 60;
const STUDIO_DROPDOWN_VIEWPORT_MARGIN_PX = 12;
const STUDIO_DROPDOWN_PANEL_GAP_PX = 4;
const STUDIO_DROPDOWN_FALLBACK_PANEL_HEIGHT_PX = 280;
const STUDIO_DROPDOWN_FALLBACK_PANEL_CHROME_PX = 74;
const STUDIO_DROPDOWN_MIN_LIST_HEIGHT_PX = 72;

function optionSearchText(option: StudioNodeConfigSelectOption): string {
  const parts: string[] = [option.label, option.value, option.description || "", option.badge || ""];
  if (Array.isArray(option.keywords)) {
    parts.push(...option.keywords);
  }
  return parts.join(" ");
}

function estimatePreferredPanelWidth(optionsList: StudioNodeConfigSelectOption[]): number {
  let longest = 0;
  for (const option of optionsList) {
    const label = String(option.label || option.value || "").trim();
    const value = String(option.value || "").trim();
    const badge = option.badge ? `[${String(option.badge).trim()}] ` : "";
    const description = String(option.description || "")
      .trim()
      .slice(0, STUDIO_DROPDOWN_MAX_DESCRIPTION_CHARS_FOR_WIDTH);
    longest = Math.max(longest, (badge + label).length, value.length, description.length);
  }
  return Math.round(longest * STUDIO_DROPDOWN_ESTIMATED_GLYPH_WIDTH_PX + STUDIO_DROPDOWN_ESTIMATED_PADDING_PX);
}

export function renderStudioSearchableDropdown(
  options: StudioSearchableDropdownOptions
): StudioSearchableDropdownHandle {
  const {
    containerEl,
    ariaLabel,
    disabled,
    placeholder,
    noResultsText,
    loadOptions,
    onValueChange,
  } = options;
  const ownerDocument = getStudioOwnerDocument(containerEl);
  const ownerWindow = getStudioOwnerWindow(containerEl);

  let currentValue = String(options.value || "").trim();
  let loadedOptions: StudioNodeConfigSelectOption[] | null = null;
  let loadErrorMessage: string | null = null;
  let openGeneration = 0;
  let loadingPromise: Promise<void> | null = null;
  let teardownViewportListeners: (() => void) | null = null;
  let lifecycleObserver: MutationObserver | null = null;
  let destroyed = false;
  let combobox: SurfaceCombobox<StudioNodeConfigSelectOption> | null = null;

  const rootEl = containerEl.createDiv({ cls: "ss-studio-searchable-select" });
  const triggerEl = rootEl.createEl("button", {
    cls: "ss-studio-searchable-select-trigger",
    attr: {
      "aria-label": ariaLabel,
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
    },
  });
  triggerEl.type = "button";
  triggerEl.disabled = disabled;
  const triggerLabelEl = triggerEl.createSpan({ cls: "ss-studio-searchable-select-trigger-label" });
  const triggerChevronEl = triggerEl.createSpan({ cls: "ss-studio-searchable-select-trigger-chevron" });
  triggerChevronEl.setText("▾");

  const panelEl = rootEl.createDiv({ cls: "ss-studio-searchable-select-panel" });
  applyPluginSurface(panelEl, "transient");
  panelEl.setCssStyles({ display: "none" });
  const searchEl = panelEl.createEl("input", {
    cls: "ss-studio-searchable-select-search",
    type: "text",
    attr: {
      placeholder: "Search options...",
      "aria-label": `${ariaLabel} search`,
    },
  });
  searchEl.spellcheck = false;
  searchEl.autocomplete = "off";
  const listEl = panelEl.createDiv({
    cls: "ss-studio-searchable-select-list",
    attr: { "aria-label": ariaLabel },
  });

  const positionPanel = (): void => {
    // Reset sizing constraints from any previous pass BEFORE measuring.
    // Without this, the first pass (measured while the list still shows the
    // empty "Loading options..." state) writes a collapsed list max-height,
    // and every later re-measure reads the panel WITH that stale constraint
    // applied — a feedback loop that pins the list at a few pixels tall.
    panelEl.setCssStyles({ maxHeight: "" });
    listEl.setCssStyles({ maxHeight: "" });

    // The panel renders inside the zoomed graph canvas (CSS scale()), so a
    // CSS pixel applied here occupies `scale` visual pixels. Measure the
    // scale from the trigger and convert every visual-viewport budget into
    // local CSS pixels before applying it.
    const rootRect = rootEl.getBoundingClientRect();
    const rawScale = rootEl.offsetWidth > 0 ? rootRect.width / rootEl.offsetWidth : 1;
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
    const toLocalPx = (visualPx: number): number => visualPx / scale;

    const viewportWidth = ownerWindow.innerWidth || ownerDocument.documentElement?.clientWidth || 0;
    const viewportHeight = ownerWindow.innerHeight || ownerDocument.documentElement?.clientHeight || 0;
    if (!viewportWidth) {
      // Static full-width reset lives in views/studio/editor-dropdowns.css.
      panelEl.classList.add("ss-studio-searchable-select-panel--full-width");
      panelEl.setCssStyles({ left: "" });
      panelEl.setCssStyles({ right: "" });
      panelEl.setCssStyles({ width: "" });
    } else {
      panelEl.classList.remove("ss-studio-searchable-select-panel--full-width");
      const viewportMargin = STUDIO_DROPDOWN_VIEWPORT_MARGIN_PX;
      const availableWidth = toLocalPx(Math.max(rootRect.width, viewportWidth - viewportMargin * 2));
      const triggerWidth = rootEl.offsetWidth || toLocalPx(rootRect.width);
      const optionsForSizing = loadedOptions ? ensureCurrentValuePresent(loadedOptions) : [];
      const estimatedContentWidth = estimatePreferredPanelWidth(optionsForSizing);
      const minPanelWidth = Math.min(
        availableWidth,
        Math.max(triggerWidth, STUDIO_DROPDOWN_MIN_PANEL_WIDTH_PX)
      );
      const preferredWidth = Math.max(minPanelWidth, Math.max(triggerWidth, estimatedContentWidth));
      const cappedPreferredWidth = Math.min(STUDIO_DROPDOWN_MAX_PANEL_WIDTH_PX, preferredWidth);
      const panelWidth = Math.min(availableWidth, cappedPreferredWidth);

      let leftOffsetVisual = 0;
      const rightOverflow = rootRect.left + panelWidth * scale - (viewportWidth - viewportMargin);
      if (rightOverflow > 0) {
        leftOffsetVisual -= rightOverflow;
      }
      const leftOverflow = viewportMargin - (rootRect.left + leftOffsetVisual);
      if (leftOverflow > 0) {
        leftOffsetVisual += leftOverflow;
      }

      panelEl.style.left = `${Math.round(toLocalPx(leftOffsetVisual))}px`;
      panelEl.setCssStyles({ right: "auto" });
      panelEl.style.width = `${Math.round(panelWidth)}px`;
    }

    if (!viewportHeight) {
      rootEl.classList.remove("is-open-upward");
      panelEl.style.top = `calc(100% + ${STUDIO_DROPDOWN_PANEL_GAP_PX}px)`;
      panelEl.setCssStyles({ bottom: "auto" });
      return;
    }

    const viewportMargin = STUDIO_DROPDOWN_VIEWPORT_MARGIN_PX;
    const availableBelow = toLocalPx(
      Math.max(0, viewportHeight - rootRect.bottom - viewportMargin) - STUDIO_DROPDOWN_PANEL_GAP_PX
    );
    const availableAbove = toLocalPx(
      Math.max(0, rootRect.top - viewportMargin) - STUDIO_DROPDOWN_PANEL_GAP_PX
    );
    // Measured with constraints cleared, so these reflect natural content.
    // scrollHeight is already in local CSS pixels.
    const naturalPanelHeight = Math.max(
      panelEl.scrollHeight || 0,
      STUDIO_DROPDOWN_FALLBACK_PANEL_HEIGHT_PX
    );
    // Chrome = everything except the list (search box, borders, padding).
    const chromeHeight = Math.max(
      STUDIO_DROPDOWN_FALLBACK_PANEL_CHROME_PX,
      (panelEl.scrollHeight || 0) - (listEl.scrollHeight || 0)
    );
    const openUpward = availableBelow < naturalPanelHeight && availableAbove > availableBelow;
    const availableVerticalSpace = Math.max(0, openUpward ? availableAbove : availableBelow);
    // The list keeps a usable floor no matter how tight the space math gets;
    // the panel budget follows from it instead of the other way around.
    const listMaxHeight = Math.max(
      STUDIO_DROPDOWN_MIN_LIST_HEIGHT_PX,
      Math.min(naturalPanelHeight, availableVerticalSpace) - chromeHeight
    );
    const panelMaxHeight = listMaxHeight + chromeHeight;

    rootEl.classList.toggle("is-open-upward", openUpward);
    panelEl.style.top = openUpward ? "auto" : `calc(100% + ${STUDIO_DROPDOWN_PANEL_GAP_PX}px)`;
    panelEl.style.bottom = openUpward ? `calc(100% + ${STUDIO_DROPDOWN_PANEL_GAP_PX}px)` : "auto";
    panelEl.style.maxHeight = `${Math.round(panelMaxHeight)}px`;
    listEl.style.maxHeight = `${Math.round(listMaxHeight)}px`;
  };

  const syncOpenPanelPosition = (): void => {
    if (!combobox?.isOpen) return;
    positionPanel();
  };

  const bindViewportListeners = (): void => {
    if (teardownViewportListeners) {
      return;
    }

    const handleViewportChange = (): void => {
      syncOpenPanelPosition();
    };

    ownerWindow.addEventListener("resize", handleViewportChange);
    ownerWindow.addEventListener("scroll", handleViewportChange, true);
    ownerWindow.visualViewport?.addEventListener("resize", handleViewportChange);
    ownerWindow.visualViewport?.addEventListener("scroll", handleViewportChange);

    teardownViewportListeners = () => {
      ownerWindow.removeEventListener("resize", handleViewportChange);
      ownerWindow.removeEventListener("scroll", handleViewportChange, true);
      ownerWindow.visualViewport?.removeEventListener("resize", handleViewportChange);
      ownerWindow.visualViewport?.removeEventListener("scroll", handleViewportChange);
      teardownViewportListeners = null;
    };

    const MutationObserverCtor = (ownerWindow as Window & {
      MutationObserver?: new (callback: MutationCallback) => MutationObserver;
    }).MutationObserver;
    if (typeof MutationObserverCtor === "function" && !lifecycleObserver) {
      lifecycleObserver = new MutationObserverCtor(() => {
        if (!rootEl.isConnected) {
          destroy();
        }
      });
      lifecycleObserver.observe(ownerDocument.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  };

  const unbindViewportListeners = (): void => {
    teardownViewportListeners?.();
    lifecycleObserver?.disconnect();
    lifecycleObserver = null;
  };

  const ensureCurrentValuePresent = (optionsList: StudioNodeConfigSelectOption[]): StudioNodeConfigSelectOption[] => {
    if (!currentValue) {
      return optionsList;
    }
    if (optionsList.some((option) => option.value === currentValue)) {
      return optionsList;
    }
    return [
      ...optionsList,
      {
        value: currentValue,
        label: currentValue,
        description: "Unavailable in current options",
        badge: "Unavailable",
      },
    ];
  };

  const updateTriggerLabel = (): void => {
    const optionsList = loadedOptions ? ensureCurrentValuePresent(loadedOptions) : [];
    const selected = optionsList.find((option) => option.value === currentValue) || null;
    if (selected) {
      const badgePrefix = selected.badge ? `[${selected.badge}] ` : "";
      triggerLabelEl.setText(`${badgePrefix}${selected.label}`);
      triggerEl.title = selected.description || selected.label;
      return;
    }
    const fallback = currentValue || placeholder || "Select option";
    triggerLabelEl.setText(fallback);
    triggerEl.title = fallback;
  };

  const renderEmptyState = (container: HTMLElement, message: string): void => {
    container.createDiv({
      cls: "ss-studio-searchable-select-empty",
      text: message,
    });
  };

  const renderDropdownOption = (option: StudioNodeConfigSelectOption): HTMLElement => {
    const itemEl = listEl.createDiv({
      cls: "ss-studio-searchable-select-item",
    });
    const titleEl = itemEl.createDiv({ cls: "ss-studio-searchable-select-item-title" });
    if (option.badge) {
      titleEl.createSpan({
        cls: "ss-studio-searchable-select-item-badge",
        text: option.badge,
      });
    }
    titleEl.createSpan({
      cls: "ss-studio-searchable-select-item-label",
      text: option.label || option.value,
    });
    if (option.description) {
      itemEl.createDiv({
        cls: "ss-studio-searchable-select-item-description",
        text: option.description,
      });
    }
    return itemEl;
  };

  const ensureOptionsLoaded = async (forceReload: boolean = false): Promise<void> => {
    if (!forceReload && loadedOptions) {
      return;
    }
    if (!loadingPromise) {
      loadingPromise = (async () => {
        try {
          const optionsList = await loadOptions();
          loadedOptions = Array.isArray(optionsList) ? optionsList.slice() : [];
          loadErrorMessage = null;
        } catch (error) {
          loadedOptions = [];
          const message = error instanceof Error ? error.message : String(error);
          loadErrorMessage = `Unable to load options (${message}).`;
        } finally {
          loadingPromise = null;
          updateTriggerLabel();
        }
      })();
    }
    await loadingPromise;
  };

  const openPanel = async (): Promise<void> => {
    const control = combobox;
    if (control?.isOpen || disabled || destroyed || !control) {
      return;
    }
    const generation = ++openGeneration;
    control.setQuery("");
    control.setOpen(true);
    control.setBusy(true);
    control.showState((container) => renderEmptyState(container, "Loading options..."));
    await ensureOptionsLoaded(true);
    if (destroyed || !control.isOpen || generation !== openGeneration || !rootEl.isConnected) {
      return;
    }
    control.setBusy(false);
    if (loadErrorMessage) {
      control.showState((container) => renderEmptyState(container, loadErrorMessage!));
    } else {
      control.setItems(ensureCurrentValuePresent(loadedOptions || []));
    }
    control.focusInput();
  };

  function closePanel(): void {
    if (!combobox?.isOpen) {
      return;
    }
    openGeneration += 1;
    combobox.setBusy(false);
    combobox.setOpen(false);
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    openGeneration += 1;
    combobox?.destroy();
    combobox = null;
    unbindViewportListeners();
    rootEl.remove();
  }

  combobox = new SurfaceCombobox<StudioNodeConfigSelectOption>({
    input: searchEl,
    listbox: listEl,
    listboxLabel: ariaLabel,
    initiallyOpen: false,
    activeMode: "first",
    navigation: "clamp",
    activeClass: "is-active",
    selectedClass: "is-selected",
    getItemKey: (option) => option.value,
    filterItems: (items, query) => rankStudioFuzzyItems({
      items,
      query,
      getSearchText: optionSearchText,
      compareWhenEqual: (left, right) => left.label.localeCompare(right.label),
    }),
    isSelected: (option) => option.value === currentValue,
    renderOption: ({ item }) => renderDropdownOption(item),
    renderEmpty: ({ listbox }) => {
      renderEmptyState(listbox, noResultsText || "No matching options.");
    },
    onCommit: ({ item }) => {
      currentValue = item.value;
      onValueChange(item.value);
      updateTriggerLabel();
      combobox?.refreshSelection();
    },
    optionCommitEvent: "pointerdown",
    closeOnCommit: true,
    focusTargetAfterClose: triggerEl,
    onOpenChange: (nextOpen) => {
      // Restore the stylesheet's flex-column layout when opening. An inline
      // display value would override it and break the list's flex sizing.
      panelEl.setCssStyles({ display: nextOpen ? "" : "none" });
      rootEl.classList.toggle("is-open", nextOpen);
      triggerEl.setAttribute("aria-expanded", String(nextOpen));
      if (nextOpen) {
        bindViewportListeners();
        positionPanel();
      } else {
        rootEl.removeClass("is-open-upward");
        unbindViewportListeners();
      }
    },
    onRender: syncOpenPanelPosition,
  });
  triggerEl.setAttribute("aria-controls", combobox.listboxId);

  triggerEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (combobox?.isOpen) {
      closePanel();
      return;
    }
    void openPanel();
  });

  rootEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  rootEl.addEventListener("focusout", () => {
    ownerWindow.setTimeout(() => {
      const active = ownerDocument.activeElement;
      if (!active || !rootEl.contains(active)) {
        closePanel();
      }
    }, 0);
  });

  updateTriggerLabel();
  void ensureOptionsLoaded();
  return { rootEl, destroy };
}
