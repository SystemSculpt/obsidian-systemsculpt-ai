import type { StudioPiProviderAuthRecord } from "./piAuth/StudioPiAuthStorage";
import {
  hasAuthenticatedStudioPiProvider,
  normalizeStudioPiProviderId,
} from "./piAuth/StudioPiProviderAuthUtils";
import type { StudioNodeConfigSelectOption } from "./types";

type StudioLocalTextModelProviderAuthRecord = Pick<
  StudioPiProviderAuthRecord,
  "provider" | "displayName" | "hasStoredCredential" | "credentialType"
>;

function trimText(value: unknown): string {
  return String(value || "").trim();
}

export function resolveStudioLocalTextModelProviderId(
  option: Pick<StudioNodeConfigSelectOption, "value" | "badge">
): string {
  const fromBadge = normalizeStudioPiProviderId(option.badge);
  if (fromBadge) {
    return fromBadge;
  }
  const value = trimText(option.value);
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0) {
    return "";
  }
  return normalizeStudioPiProviderId(value.slice(0, slashIndex));
}

function toProviderAuthMap(
  records: StudioLocalTextModelProviderAuthRecord[]
): Map<string, StudioLocalTextModelProviderAuthRecord> {
  const byProvider = new Map<string, StudioLocalTextModelProviderAuthRecord>();
  for (const record of records) {
    const providerId = normalizeStudioPiProviderId(record.provider);
    if (!providerId) {
      continue;
    }
    byProvider.set(providerId, record);
  }
  return byProvider;
}

function toAuthenticatedBadge(baseBadge: string, authenticated: boolean): string {
  if (!baseBadge) {
    return "";
  }
  return authenticated ? `${baseBadge} ✓` : baseBadge;
}

function withAuthenticatedKeywords(option: StudioNodeConfigSelectOption, authenticated: boolean): string[] | undefined {
  if (!authenticated) {
    return Array.isArray(option.keywords) ? option.keywords.slice() : option.keywords;
  }
  const keywords = new Set<string>();
  for (const keyword of option.keywords || []) {
    const next = trimText(keyword);
    if (next) {
      keywords.add(next);
    }
  }
  keywords.add("authenticated");
  keywords.add("oauth");
  keywords.add("api key");
  return Array.from(keywords.values());
}

export function decorateStudioLocalTextModelOptionsWithAuth(
  options: StudioNodeConfigSelectOption[],
  records: StudioLocalTextModelProviderAuthRecord[]
): StudioNodeConfigSelectOption[] {
  const authByProvider = toProviderAuthMap(records);

  return options
    .map((option) => {
      const providerId = resolveStudioLocalTextModelProviderId(option);
      const authRecord = providerId ? authByProvider.get(providerId) : null;
      const providerAuthenticated = hasAuthenticatedStudioPiProvider(authRecord);
      const baseBadge =
        trimText(authRecord?.displayName) ||
        trimText(option.badge) ||
        providerId;

      return {
        value: option.value,
        label: option.label,
        description: option.description,
        badge: toAuthenticatedBadge(baseBadge, providerAuthenticated) || undefined,
        keywords: withAuthenticatedKeywords(option, providerAuthenticated),
        providerAuthenticated,
      } satisfies StudioNodeConfigSelectOption;
    })
    .sort((left, right) => {
      const leftAuthenticated = left.providerAuthenticated ? 1 : 0;
      const rightAuthenticated = right.providerAuthenticated ? 1 : 0;
      if (leftAuthenticated !== rightAuthenticated) {
        return rightAuthenticated - leftAuthenticated;
      }

      const badgeCompare = trimText(left.badge).localeCompare(trimText(right.badge));
      if (badgeCompare !== 0) {
        return badgeCompare;
      }

      return trimText(left.label || left.value).localeCompare(trimText(right.label || right.value));
    });
}
