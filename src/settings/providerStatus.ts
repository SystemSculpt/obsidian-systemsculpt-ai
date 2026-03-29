import type {
  StudioPiOAuthProvider,
  StudioPiProviderAuthRecord,
} from "../studio/piAuth/StudioPiAuthInventory";
import type SystemSculptPlugin from "../main";
import type { CustomProvider } from "../types/llm";
import {
  getStudioPiAuthMethodRestriction,
  isStudioPiLocalProvider,
  resolveProviderLabel,
} from "../studio/piAuth/StudioPiProviderRegistry";

export type ProviderDisplayState = {
  blocked: boolean;
  connected: boolean;
  ready: boolean;
  tone: "connected" | "blocked" | "disconnected";
  statusLabel: string;
  summary: string;
  inlineReason: string | null;
  hoverDetails: string | null;
};

export type ProviderStatusInventory = {
  records: StudioPiProviderAuthRecord[];
  localProviderIds: Set<string>;
  oauthProvidersById: Map<string, StudioPiOAuthProvider>;
};

export const PROVIDER_STATUS_LOAD_TIMEOUT_MS = 5_000;

async function loadStudioPiAuthInventoryModule(): Promise<
  typeof import("../studio/piAuth/StudioPiAuthInventory")
> {
  return await import("../studio/piAuth/StudioPiAuthInventory");
}

async function loadPiTextModelsModule(): Promise<
  typeof import("../services/pi/PiTextModels")
> {
  return await import("../services/pi/PiTextModels");
}

export function normalizeProviderId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function getProviderLabel(
  providerId: string,
  oauthProviders?: Map<string, StudioPiOAuthProvider>,
): string {
  return resolveProviderLabel(providerId, oauthProviders);
}

export function hasConfiguredLocalProvider(
  providerId: string,
  localProviderIds: ReadonlySet<string>,
): boolean {
  return localProviderIds.has(normalizeProviderId(providerId));
}

export function getStoredAuthRestriction(
  record: StudioPiProviderAuthRecord,
): ReturnType<typeof getStudioPiAuthMethodRestriction> | null {
  if (record.source !== "oauth") {
    return null;
  }
  const restriction = getStudioPiAuthMethodRestriction(record.provider, "oauth");
  return restriction.disabled ? restriction : null;
}

export function getProviderDisplayState(
  record: StudioPiProviderAuthRecord,
  localProviderIds: ReadonlySet<string>,
): ProviderDisplayState {
  const localConfigured = hasConfiguredLocalProvider(record.provider, localProviderIds);
  if (isStudioPiLocalProvider(record.provider)) {
    return {
      blocked: false,
      connected: false,
      ready: localConfigured,
      tone: localConfigured ? "connected" : "disconnected",
      statusLabel: localConfigured ? "Configured locally" : "Not configured locally",
      summary: localConfigured
        ? "Configured locally via Pi models.json"
        : "Set up locally via Pi models.json",
      inlineReason: null,
      hoverDetails: null,
    };
  }

  const storedAuthRestriction = getStoredAuthRestriction(record);
  if (storedAuthRestriction) {
    return {
      blocked: true,
      connected: false,
      ready: false,
      tone: "blocked",
      statusLabel: "Subscription login disabled",
      summary: "Subscription login disabled. Use API key instead.",
      inlineReason: storedAuthRestriction.inlineReason || null,
      hoverDetails: storedAuthRestriction.hoverDetails || null,
    };
  }

  if (!record.hasAnyAuth) {
    return {
      blocked: false,
      connected: false,
      ready: false,
      tone: "disconnected",
      statusLabel: "Not connected",
      summary: "Not connected",
      inlineReason: null,
      hoverDetails: null,
    };
  }

  let summary = "Connected";
  switch (record.source) {
    case "oauth":
      summary = "Connected via subscription";
      break;
    case "api_key":
      summary = "Connected via API key";
      break;
    case "environment_or_fallback":
      summary = "Connected from environment";
      break;
    default:
      summary = "Connected";
      break;
  }

  return {
    blocked: false,
    connected: true,
    ready: true,
    tone: "connected",
    statusLabel: "Connected",
    summary,
    inlineReason: null,
    hoverDetails: null,
  };
}

export function formatProviderStatusSummary(
  records: StudioPiProviderAuthRecord[],
  localProviderIds: ReadonlySet<string>,
): string {
  const readyCount = records.filter((record) =>
    getProviderDisplayState(record, localProviderIds).ready,
  ).length;
  const blockedCount = records.filter((record) =>
    getProviderDisplayState(record, localProviderIds).blocked,
  ).length;

  if (blockedCount > 0) {
    return `${readyCount} ready, ${blockedCount} needs attention`;
  }

  return `${readyCount} ready`;
}

export function sortProviderAuthRecords(
  records: StudioPiProviderAuthRecord[],
  localProviderIds: ReadonlySet<string>,
  oauthProvidersById: Map<string, StudioPiOAuthProvider>,
): StudioPiProviderAuthRecord[] {
  return [...records].sort((left, right) => {
    const displayLeft = getProviderDisplayState(left, localProviderIds);
    const displayRight = getProviderDisplayState(right, localProviderIds);
    const rankLeft = displayLeft.ready ? 0 : displayLeft.blocked ? 1 : 2;
    const rankRight = displayRight.ready ? 0 : displayRight.blocked ? 1 : 2;
    if (rankLeft !== rankRight) {
      return rankLeft - rankRight;
    }

    const labelLeft = getProviderLabel(left.provider, oauthProvidersById);
    const labelRight = getProviderLabel(right.provider, oauthProvidersById);
    return labelLeft.localeCompare(labelRight);
  });
}

export async function loadProviderStatusInventory(
  plugin: SystemSculptPlugin,
): Promise<ProviderStatusInventory> {
  const [
    { listStudioPiOAuthProviders, listStudioPiProviderAuthRecords },
    { collectSharedPiProviderHints, listLocalPiProviderIds },
  ] = await Promise.all([
    loadStudioPiAuthInventoryModule(),
    loadPiTextModelsModule(),
  ]);

  const oauthProviders = await listStudioPiOAuthProviders({ plugin });
  const oauthProvidersById = new Map(
    oauthProviders.map((provider) => [normalizeProviderId(provider.id), provider]),
  );

  const customProviders = Array.isArray(plugin?.settings?.customProviders)
    ? (plugin.settings.customProviders as CustomProvider[])
    : [];
  const hints = collectSharedPiProviderHints(customProviders);
  const [records, localProviderIds] = await Promise.all([
    listStudioPiProviderAuthRecords({ providerHints: hints, plugin }),
    listLocalPiProviderIds(plugin).catch(() => []),
  ]);
  const normalizedLocalProviderIds = new Set(
    localProviderIds.map((providerId) => normalizeProviderId(providerId)).filter(Boolean),
  );

  return {
    records: sortProviderAuthRecords(records, normalizedLocalProviderIds, oauthProvidersById),
    localProviderIds: normalizedLocalProviderIds,
    oauthProvidersById,
  };
}

export async function loadProviderStatusInventoryWithTimeout(
  plugin: SystemSculptPlugin,
  options: {
    timeoutMs?: number;
    label?: string;
  } = {},
): Promise<ProviderStatusInventory> {
  const timeoutMs = Math.max(
    250,
    Number(options.timeoutMs) || PROVIDER_STATUS_LOAD_TIMEOUT_MS,
  );
  const label = String(options.label || "provider status").trim() || "provider status";

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      loadProviderStatusInventory(plugin),
      new Promise<ProviderStatusInventory>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out while loading ${label}.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
