import type { StudioNodeConfigSelectOption } from "../../studio/types";
import { rankStudioFuzzyItems } from "./StudioFuzzySearch";

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

export function renderStudioSearchableDropdown(options: StudioSearchableDropdownOptions): void {
  const {
    containerEl,
    ariaLabel,
    disabled,
    placeholder,
    noResultsText,
    loadOptions,
    onValueChange,
  } = options;

  let currentValue = String(options.value || "").trim();
  let loadedOptions: StudioNodeConfigSelectOption[] | null = null;
  let filteredOptions: StudioNodeConfigSelectOption[] = [];
  let activeIndex = -1;
  let open = false;
  let loadingPromise: Promise<void> | null = null;
  let teardownViewportListeners: (() => void) | null = null;

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
  panelEl.style.display = "none";
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
    attr: { role: "listbox" },
  });

  const positionPanel = (): void => {
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    if (!viewportWidth) {
      panelEl.style.left = "0px";
      panelEl.style.right = "auto";
      panelEl.style.width = "100%";
    } else {
      const rect = rootEl.getBoundingClientRect();
      const viewportMargin = STUDIO_DROPDOWN_VIEWPORT_MARGIN_PX;
      const availableWidth = Math.max(rect.width, viewportWidth - viewportMargin * 2);
      const optionsForSizing = loadedOptions ? ensureCurrentValuePresent(loadedOptions) : [];
      const estimatedContentWidth = estimatePreferredPanelWidth(optionsForSizing);
      const minPanelWidth = Math.min(
        availableWidth,
        Math.max(rect.width, STUDIO_DROPDOWN_MIN_PANEL_WIDTH_PX)
      );
      const preferredWidth = Math.max(minPanelWidth, Math.max(rect.width, estimatedContentWidth));
      const cappedPreferredWidth = Math.min(STUDIO_DROPDOWN_MAX_PANEL_WIDTH_PX, preferredWidth);
      const panelWidth = Math.min(availableWidth, cappedPreferredWidth);

      let leftOffset = 0;
      const rightOverflow = rect.left + panelWidth - (viewportWidth - viewportMargin);
      if (rightOverflow > 0) {
        leftOffset -= rightOverflow;
      }
      const leftOverflow = viewportMargin - (rect.left + leftOffset);
      if (leftOverflow > 0) {
        leftOffset += leftOverflow;
      }

      panelEl.style.left = `${Math.round(leftOffset)}px`;
      panelEl.style.right = "auto";
      panelEl.style.width = `${Math.round(panelWidth)}px`;
    }

    if (!viewportHeight) {
      rootEl.classList.remove("is-open-upward");
      panelEl.style.top = `calc(100% + ${STUDIO_DROPDOWN_PANEL_GAP_PX}px)`;
      panelEl.style.bottom = "auto";
      panelEl.style.maxHeight = "";
      listEl.style.maxHeight = "";
      return;
    }

    const rect = rootEl.getBoundingClientRect();
    const viewportMargin = STUDIO_DROPDOWN_VIEWPORT_MARGIN_PX;
    const availableBelow = Math.max(
      0,
      viewportHeight - rect.bottom - viewportMargin - STUDIO_DROPDOWN_PANEL_GAP_PX
    );
    const availableAbove = Math.max(
      0,
      rect.top - viewportMargin - STUDIO_DROPDOWN_PANEL_GAP_PX
    );
    const panelRect = panelEl.getBoundingClientRect();
    const naturalPanelHeight = Math.max(
      panelEl.scrollHeight || 0,
      panelRect.height || 0,
      STUDIO_DROPDOWN_FALLBACK_PANEL_HEIGHT_PX
    );
    const listRect = listEl.getBoundingClientRect();
    const estimatedChromeHeight = Math.max(
      STUDIO_DROPDOWN_FALLBACK_PANEL_CHROME_PX,
      naturalPanelHeight - (listRect.height || 0)
    );
    const openUpward = availableBelow < naturalPanelHeight && availableAbove > availableBelow;
    const availableVerticalSpace = openUpward ? availableAbove : availableBelow;
    const panelMaxHeight = Math.max(0, Math.min(naturalPanelHeight, availableVerticalSpace));
    const listMaxHeight = Math.max(
      0,
      Math.min(
        panelMaxHeight - estimatedChromeHeight,
        Math.max(STUDIO_DROPDOWN_MIN_LIST_HEIGHT_PX, availableVerticalSpace - estimatedChromeHeight)
      )
    );

    rootEl.classList.toggle("is-open-upward", openUpward);
    panelEl.style.top = openUpward ? "auto" : `calc(100% + ${STUDIO_DROPDOWN_PANEL_GAP_PX}px)`;
    panelEl.style.bottom = openUpward ? `calc(100% + ${STUDIO_DROPDOWN_PANEL_GAP_PX}px)` : "auto";
    panelEl.style.maxHeight = `${Math.round(panelMaxHeight)}px`;
    listEl.style.maxHeight = `${Math.round(listMaxHeight)}px`;
  };

  const syncOpenPanelPosition = (): void => {
    if (!open) return;
    positionPanel();
  };

  const bindViewportListeners = (): void => {
    if (teardownViewportListeners) {
      return;
    }

    const handleViewportChange = (): void => {
      syncOpenPanelPosition();
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);

    teardownViewportListeners = () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
      teardownViewportListeners = null;
    };
  };

  const unbindViewportListeners = (): void => {
    teardownViewportListeners?.();
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

  const setTriggerAuthState = (authenticated: boolean): void => {
    rootEl.classList.toggle("is-provider-authenticated", authenticated);
    triggerEl.classList.toggle("is-provider-authenticated", authenticated);
  };

  const updateTriggerLabel = (): void => {
    const optionsList = loadedOptions ? ensureCurrentValuePresent(loadedOptions) : [];
    const selected = optionsList.find((option) => option.value === currentValue) || null;
    if (selected) {
      setTriggerAuthState(Boolean(selected.providerAuthenticated));
      const badgePrefix = selected.badge ? `[${selected.badge}] ` : "";
      triggerLabelEl.setText(`${badgePrefix}${selected.label}`);
      triggerEl.title = selected.description || selected.label;
      return;
    }
    setTriggerAuthState(false);
    const fallback = currentValue || placeholder || "Select option";
    triggerLabelEl.setText(fallback);
    triggerEl.title = fallback;
  };

  const renderEmptyState = (message: string): void => {
    listEl.empty();
    listEl.createDiv({
      cls: "ss-studio-searchable-select-empty",
      text: message,
    });
  };

  const renderOptions = (): void => {
    listEl.empty();
    if (filteredOptions.length === 0) {
      renderEmptyState(noResultsText || "No matching options.");
      syncOpenPanelPosition();
      return;
    }

    for (const [index, option] of filteredOptions.entries()) {
      const itemEl = listEl.createDiv({
        cls: "ss-studio-searchable-select-item",
      });
      const providerAuthenticated = option.providerAuthenticated === true;
      itemEl.setAttribute("role", "option");
      itemEl.setAttribute("aria-selected", option.value === currentValue ? "true" : "false");
      itemEl.classList.toggle("is-active", index === activeIndex);
      itemEl.classList.toggle("is-selected", option.value === currentValue);
      itemEl.classList.toggle("is-provider-authenticated", providerAuthenticated);

      const titleEl = itemEl.createDiv({ cls: "ss-studio-searchable-select-item-title" });
      if (option.badge) {
        const badgeEl = titleEl.createSpan({
          cls: "ss-studio-searchable-select-item-badge",
          text: option.badge,
        });
        badgeEl.classList.toggle("is-provider-authenticated", providerAuthenticated);
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

      itemEl.addEventListener("pointermove", () => {
        activeIndex = index;
        for (const child of Array.from(listEl.children)) {
          child.classList.remove("is-active");
        }
        itemEl.addClass("is-active");
      });
      itemEl.addEventListener("pointerdown", (event) => {
        // Prevent node-card drag/select handlers from stealing the interaction.
        event.preventDefault();
        event.stopPropagation();
        currentValue = option.value;
        onValueChange(option.value);
        updateTriggerLabel();
        closePanel();
      });
      itemEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    syncOpenPanelPosition();
  };

  const applyFilter = (query: string): void => {
    const optionsList = ensureCurrentValuePresent(loadedOptions || []);
    filteredOptions = rankStudioFuzzyItems({
      items: optionsList,
      query,
      getSearchText: optionSearchText,
      compareWhenEqual: (left, right) => left.label.localeCompare(right.label),
    });
    activeIndex = filteredOptions.length > 0 ? 0 : -1;
    renderOptions();
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
        } catch (error) {
          loadedOptions = [];
          const message = error instanceof Error ? error.message : String(error);
          renderEmptyState(`Unable to load options (${message}).`);
        } finally {
          loadingPromise = null;
          updateTriggerLabel();
        }
      })();
    }
    await loadingPromise;
  };

  const openPanel = async (): Promise<void> => {
    if (open || disabled) {
      return;
    }
    open = true;
    panelEl.style.display = "grid";
    bindViewportListeners();
    positionPanel();
    rootEl.addClass("is-open");
    triggerEl.setAttribute("aria-expanded", "true");
    renderEmptyState("Loading options...");
    await ensureOptionsLoaded(true);
    applyFilter("");
    searchEl.value = "";
    searchEl.focus();
  };

  function closePanel(): void {
    if (!open) {
      return;
    }
    open = false;
    panelEl.style.display = "none";
    rootEl.removeClass("is-open");
    rootEl.removeClass("is-open-upward");
    triggerEl.setAttribute("aria-expanded", "false");
    unbindViewportListeners();
  }

  triggerEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (open) {
      closePanel();
      return;
    }
    void openPanel();
  });

  rootEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  rootEl.addEventListener("focusout", () => {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || !rootEl.contains(active)) {
        closePanel();
      }
    }, 0);
  });

  searchEl.addEventListener("input", () => {
    applyFilter(searchEl.value);
  });

  searchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
      triggerEl.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredOptions.length === 0) {
        return;
      }
      activeIndex = Math.min(filteredOptions.length - 1, activeIndex + 1);
      renderOptions();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredOptions.length === 0) {
        return;
      }
      activeIndex = Math.max(0, activeIndex - 1);
      renderOptions();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex < 0 || activeIndex >= filteredOptions.length) {
        return;
      }
      const selected = filteredOptions[activeIndex];
      currentValue = selected.value;
      onValueChange(selected.value);
      updateTriggerLabel();
      closePanel();
      triggerEl.focus();
    }
  });

  updateTriggerLabel();
  void ensureOptionsLoaded();
}
