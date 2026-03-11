import { setIcon } from "obsidian";

export interface ChatCreditsIndicatorRenderResult {
  title: string;
  isLoading: boolean;
  isLow: boolean;
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
