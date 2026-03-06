import { setIcon } from "obsidian";
import type { ModelSelectionProviderAccessState, ModelSelectionProviderSummarySnapshot } from "./ModelSelectionProviderAuth";

type ModelSelectionSummaryBarOptions = {
  onOpenSetup: () => void;
  onRefresh: () => Promise<void> | void;
};

export type ModelSelectionSummaryBarHandle = {
  favoritesContainerEl: HTMLElement;
  update: (summary: ModelSelectionProviderSummarySnapshot, state?: { loading?: boolean }) => void;
};

function getAccessLabel(state: ModelSelectionProviderAccessState): string {
  if (state === "pi-auth") {
    return "Connected";
  }
  if (state === "local") {
    return "Local";
  }
  return "Needs Pi";
}

function getTitle(summary: ModelSelectionProviderSummarySnapshot): string {
  if (summary.totalModels === 0) {
    if (summary.piReadyProviders > 0) {
      return `${summary.piReadyProviders} provider${summary.piReadyProviders === 1 ? "" : "s"} authenticated`;
    }
    if (summary.localProviders > 0) {
      return `${summary.localProviders} local provider${summary.localProviders === 1 ? "" : "s"} ready`;
    }
    return "No models available yet";
  }
  if (summary.localProviders > 0) {
    return `${summary.localProviders} local provider${summary.localProviders === 1 ? "" : "s"} available`;
  }
  if (summary.piReadyProviders > 0) {
    return `${summary.piReadyProviders} provider${summary.piReadyProviders === 1 ? "" : "s"} connected`;
  }
  if (summary.unavailableProviders > 0) {
    return `${summary.unavailableProviders} provider${summary.unavailableProviders === 1 ? "" : "s"} need Pi auth`;
  }
  return `${summary.totalProviders} provider${summary.totalProviders === 1 ? "" : "s"} available`;
}

function getStats(summary: ModelSelectionProviderSummarySnapshot): string {
  if (summary.totalModels === 0) {
    if (summary.totalProviders > 0) {
      return `${summary.totalProviders} connected provider${summary.totalProviders === 1 ? "" : "s"} found. Refresh after adding or fixing local model access.`;
    }
    return "Open Setup to connect Pi providers or refresh local Pi model availability.";
  }

  const parts = [`${summary.totalModels} models`, `${summary.totalProviders} providers`];
  if (summary.localProviders > 0) {
    parts.push(`${summary.localProviders} local`);
  } else if (summary.piReadyProviders > 0) {
    parts.push(`${summary.piReadyProviders} connected`);
  } else if (summary.unavailableProviders > 0) {
    parts.push(`${summary.unavailableProviders} need auth`);
  }
  return parts.join(" • ");
}

export function renderModelSelectionSummaryBar(
  containerEl: HTMLElement,
  options: ModelSelectionSummaryBarOptions
): ModelSelectionSummaryBarHandle {
  const summaryEl = containerEl.createDiv("ss-model-provider-summary");
  const topEl = summaryEl.createDiv("ss-model-provider-summary__top");
  const glanceEl = topEl.createDiv("ss-model-provider-summary__glance");
  glanceEl.createDiv({ cls: "ss-model-provider-summary__eyebrow", text: "Provider Access" });
  const titleEl = glanceEl.createDiv("ss-model-provider-summary__title");
  const statsEl = glanceEl.createDiv("ss-model-provider-summary__stats");
  const controlsEl = topEl.createDiv("ss-model-provider-summary__controls");
  const favoritesContainerEl = controlsEl.createDiv("ss-favorites-button");
  const setupButton = controlsEl.createEl("button", {
    cls: "ss-model-setup-button",
    text: "Open Setup",
  });
  const refreshButton = controlsEl.createEl("button", {
    cls: "ss-model-refresh-button",
  });
  const chipsEl = summaryEl.createDiv("ss-model-provider-summary__chips");

  setupButton.addEventListener("click", () => {
    options.onOpenSetup();
  });

  const refreshIcon = refreshButton.createSpan();
  setIcon(refreshIcon, "refresh-cw");
  const refreshText = refreshButton.createSpan({ text: "Refresh" });

  refreshButton.addEventListener("click", async () => {
    if (refreshButton.disabled) {
      return;
    }
    refreshButton.disabled = true;
    refreshIcon.addClass("ss-spin");
    refreshText.textContent = "Refreshing…";
    try {
      await options.onRefresh();
    } finally {
      refreshButton.disabled = false;
      refreshIcon.removeClass("ss-spin");
      refreshText.textContent = "Refresh";
    }
  });

  const update = (
    summary: ModelSelectionProviderSummarySnapshot,
    state?: { loading?: boolean }
  ): void => {
    chipsEl.empty();

    if (state?.loading) {
      titleEl.textContent = "Loading providers and models…";
      statsEl.textContent = "Checking connected providers and refreshing model availability.";
      return;
    }

    titleEl.textContent = getTitle(summary);
    statsEl.textContent = getStats(summary);

    const providerPreview = summary.providers.slice(0, 4);
    for (const provider of providerPreview) {
      const chipEl = chipsEl.createDiv("ss-model-provider-chip");
      chipEl.addClass(`is-${provider.accessState}`);
      if (provider.isCurrentProvider) {
        chipEl.addClass("is-current");
      }

      chipEl.createSpan({
        cls: "ss-model-provider-chip__name",
        text: provider.providerName,
      });
      chipEl.createSpan({
        cls: "ss-model-provider-chip__count",
        text: `${provider.modelCount}`,
      });
      chipEl.createSpan({
        cls: "ss-model-provider-chip__state",
        text: getAccessLabel(provider.accessState),
      });
    }

    if (summary.providers.length > providerPreview.length) {
      chipsEl.createDiv({
        cls: "ss-model-provider-chip is-overflow",
        text: `+${summary.providers.length - providerPreview.length} more`,
      });
    }
  };

  update(
    {
      totalModels: 0,
      totalProviders: 0,
      managedProviders: 0,
      piReadyProviders: 0,
      localProviders: 0,
      unavailableProviders: 0,
      providers: [],
    },
    { loading: true }
  );

  return {
    favoritesContainerEl,
    update,
  };
}
