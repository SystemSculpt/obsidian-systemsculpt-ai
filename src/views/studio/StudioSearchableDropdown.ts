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
    if (!viewportWidth) {
      panelEl.style.left = "0px";
      panelEl.style.right = "auto";
      panelEl.style.width = "100%";
      return;
    }

    const rect = rootEl.getBoundingClientRect();
    const viewportMargin = 12;
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
      return;
    }

    for (const [index, option] of filteredOptions.entries()) {
      const itemEl = listEl.createDiv({
        cls: "ss-studio-searchable-select-item",
      });
      itemEl.setAttribute("role", "option");
      itemEl.setAttribute("aria-selected", option.value === currentValue ? "true" : "false");
      itemEl.classList.toggle("is-active", index === activeIndex);
      itemEl.classList.toggle("is-selected", option.value === currentValue);

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
    positionPanel();
    rootEl.addClass("is-open");
    triggerEl.setAttribute("aria-expanded", "true");
    renderEmptyState("Loading options...");
    await ensureOptionsLoaded(true);
    positionPanel();
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
    triggerEl.setAttribute("aria-expanded", "false");
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
}
