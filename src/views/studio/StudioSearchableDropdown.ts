import type { StudioNodeConfigSelectOption } from "../../studio/types";

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

type RankedOption = {
  option: StudioNodeConfigSelectOption;
  score: number;
  index: number;
};

function normalizeSearchText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isBoundaryChar(char: string): boolean {
  return char === " " || char === "." || char === "_" || char === "-" || char === "/" || char === ":";
}

function fuzzyScore(haystackRaw: string, queryRaw: string): number | null {
  const haystack = normalizeSearchText(haystackRaw);
  const query = normalizeSearchText(queryRaw);
  if (!query) {
    return 0;
  }

  let scanIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  let boundaryBonus = 0;

  for (const queryChar of query) {
    const matchIndex = haystack.indexOf(queryChar, scanIndex);
    if (matchIndex < 0) {
      return null;
    }
    if (firstMatchIndex < 0) {
      firstMatchIndex = matchIndex;
    }
    if (previousMatchIndex >= 0) {
      gapPenalty += Math.max(0, matchIndex - previousMatchIndex - 1);
    }
    if (matchIndex === 0 || isBoundaryChar(haystack.charAt(matchIndex - 1))) {
      boundaryBonus += 0.4;
    }
    previousMatchIndex = matchIndex;
    scanIndex = matchIndex + 1;
  }

  const span = previousMatchIndex - firstMatchIndex + 1;
  let score =
    firstMatchIndex * 1.6 +
    gapPenalty * 1.3 +
    Math.max(0, span - query.length) * 0.8 +
    haystack.length * 0.01;

  if (haystack.startsWith(query)) {
    score -= 5;
  } else {
    const containsIndex = haystack.indexOf(query);
    if (containsIndex >= 0) {
      score -= 3.2 - Math.min(2, containsIndex * 0.1);
    }
  }

  score -= boundaryBonus;
  return score;
}

function optionSearchText(option: StudioNodeConfigSelectOption): string {
  const parts: string[] = [option.label, option.value, option.description || "", option.badge || ""];
  if (Array.isArray(option.keywords)) {
    parts.push(...option.keywords);
  }
  return parts.join(" ");
}

function sortRankedOptions(ranked: RankedOption[]): StudioNodeConfigSelectOption[] {
  return ranked
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.option.label !== right.option.label) {
        return left.option.label.localeCompare(right.option.label);
      }
      return left.index - right.index;
    })
    .map((entry) => entry.option);
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
      placeholder: "Search models...",
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
    const preferredWidth = Math.max(rect.width, 520);
    const cappedPreferredWidth = Math.min(760, preferredWidth);
    const panelWidth = Math.max(rect.width, Math.min(cappedPreferredWidth, availableWidth));

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
        description: "Unavailable in current provider catalog",
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
    const fallback = currentValue || placeholder || "Select model";
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
      renderEmptyState(noResultsText || "No matching models.");
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
      itemEl.addEventListener("mousedown", (event) => {
        // Keep focus within the dropdown while selecting so click is not lost.
        event.preventDefault();
      });
      itemEl.addEventListener("click", (event) => {
        event.preventDefault();
        currentValue = option.value;
        onValueChange(option.value);
        updateTriggerLabel();
        closePanel();
      });
    }
  };

  const applyFilter = (query: string): void => {
    const optionsList = ensureCurrentValuePresent(loadedOptions || []);
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      filteredOptions = optionsList.slice();
      activeIndex = filteredOptions.length > 0 ? 0 : -1;
      renderOptions();
      return;
    }
    const ranked: RankedOption[] = [];
    for (const [index, option] of optionsList.entries()) {
      const score = fuzzyScore(optionSearchText(option), normalizedQuery);
      if (score === null) {
        continue;
      }
      ranked.push({ option, score, index });
    }
    filteredOptions = sortRankedOptions(ranked);
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
          renderEmptyState(`Unable to load models (${message}).`);
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
    renderEmptyState("Loading models...");
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
    if (open) {
      closePanel();
      return;
    }
    void openPanel();
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
