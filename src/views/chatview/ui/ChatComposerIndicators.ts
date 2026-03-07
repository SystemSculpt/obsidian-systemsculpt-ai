import { setIcon } from "obsidian";
import { ensureCanonicalId, getDisplayName, getModelLabelWithProvider } from "../../../utils/modelUtils";
import { normalizeDesktopPromptSelectionType } from "../../../services/SystemPromptService";

export interface ChatModelIndicatorRenderResult {
  ariaLabel: string;
  title: string;
  currentModelName: string;
  isEmpty: boolean;
}

export interface ChatPromptIndicatorRenderResult {
  ariaLabel: string;
  title: string;
  promptLabel: string;
}

export interface ChatCreditsIndicatorRenderResult {
  title: string;
  isLoading: boolean;
  isLow: boolean;
}

const appendIndicatorArrow = (target: HTMLElement) => {
  const arrowSpan = target.createSpan({ cls: "systemsculpt-model-indicator-arrow" });
  setIcon(arrowSpan, "chevron-down");
};

export function renderChatModelIndicator(
  target: HTMLElement,
  options: {
    selectedModelId?: string | null;
    labelOverride?: string;
  }
): ChatModelIndicatorRenderResult {
  target.empty();
  target.classList.add("systemsculpt-model-indicator", "systemsculpt-chip");

  const labelOverride = options.labelOverride?.trim();
  const selectedModelId = options.selectedModelId?.trim();

  if (!labelOverride && (!selectedModelId || selectedModelId === "unknown" || selectedModelId.includes("unknown"))) {
    const iconSpan = target.createSpan({ cls: "systemsculpt-model-indicator-icon" });
    setIcon(iconSpan, "bot");
    target.createSpan({ text: "No model selected" });
    target.classList.add("systemsculpt-no-model");
    return {
      ariaLabel: "No model selected, click to choose one",
      title: "No model selected",
      currentModelName: "No model selected",
      isEmpty: true,
    };
  }

  target.classList.remove("systemsculpt-no-model");

  const iconSpan = target.createSpan({ cls: "systemsculpt-model-indicator-icon" });
  setIcon(iconSpan, "bot");

  let labelText = labelOverride ?? "";
  let currentModelName = labelText;
  if (!labelText && selectedModelId) {
    const canonicalId = ensureCanonicalId(selectedModelId);
    currentModelName = getDisplayName(canonicalId);
    labelText = getModelLabelWithProvider(canonicalId);
  }

  target.createSpan({ text: labelText });
  appendIndicatorArrow(target);

  const title = `Current model: ${labelText}`;
  return {
    ariaLabel: `${title}. Click to change.`,
    title,
    currentModelName,
    isEmpty: false,
  };
}

export function renderChatPromptIndicator(
  target: HTMLElement,
  options: {
    promptType?: string | null;
    promptPath?: string | null;
    labelOverride?: string;
  }
): ChatPromptIndicatorRenderResult {
  target.empty();
  target.classList.add("systemsculpt-model-indicator", "systemsculpt-chip");

  let promptLabel = options.labelOverride?.trim() ?? "";
  if (!promptLabel) {
    switch (normalizeDesktopPromptSelectionType(options.promptType ?? undefined)) {
      case "general-use":
        promptLabel = "General Use";
        break;
      case "concise":
        promptLabel = "Concise";
        break;
      case "custom": {
        const filename = options.promptPath?.split("/").pop() || "Custom";
        promptLabel = filename.replace(/\.md$/i, "") || "Custom";
        break;
      }
      default:
        promptLabel = "System Prompt";
        break;
    }
  }

  const iconSpan = target.createSpan({ cls: "systemsculpt-model-indicator-icon" });
  setIcon(iconSpan, options.promptType === "custom" ? "file-text" : "sparkles");
  target.createSpan({ text: promptLabel });
  appendIndicatorArrow(target);

  const title = `Current system prompt: ${promptLabel}. Click to change.`;
  return {
    ariaLabel: title,
    title,
    promptLabel,
  };
}

const formatCredits = (value: number): string => {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(value);
  }
};

const formatCycleDate = (iso?: string): string => {
  if (!iso) {
    return "unknown";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

export function renderChatCreditsIndicator(
  target: HTMLElement,
  options: {
    balance?: {
      totalRemaining: number;
      includedRemaining: number;
      includedPerMonth: number;
      addOnRemaining: number;
      cycleEndsAt?: string;
    } | null;
    titleOverride?: string;
  }
): ChatCreditsIndicatorRenderResult {
  target.empty();

  const iconSpan = target.createSpan({ cls: "systemsculpt-model-indicator-icon" });
  setIcon(iconSpan, "coins");

  const balance = options.balance;
  const title =
    options.titleOverride ??
    (balance
      ? `Credits remaining: ${formatCredits(balance.totalRemaining)} (Included ${formatCredits(balance.includedRemaining)}/${formatCredits(balance.includedPerMonth)}, Add-on ${formatCredits(balance.addOnRemaining)}). Resets ${formatCycleDate(balance.cycleEndsAt)}.`
      : "Credits balance (click to view)");

  const lowCreditsThreshold = 1000;
  return {
    title,
    isLoading: !balance,
    isLow: !!balance && balance.totalRemaining <= lowCreditsThreshold,
  };
}
