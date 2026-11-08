import { ERROR_CODES, SystemSculptError } from "../../utils/errors";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../../constants/api";
import { SYSTEMSCULPT_WEBSITE } from "../../constants/externalServices";
import { parseBoundedServerTiming } from "../../utils/serverTiming";
import type { PlatformRequestClient, PlatformTransport } from "../PlatformRequestClient";
import { SystemSculptEnvironment } from "../api/SystemSculptEnvironment";
import { StreamingErrorHandler } from "../StreamingErrorHandler";
import { CreditsBalanceCache, type CreditsBalanceReadOptions } from "./CreditsBalanceCache";

export type CreditsBalanceSnapshot = {
  includedRemaining: number;
  addOnRemaining: number;
  totalRemaining: number;
  heldInFlight?: number;
  availableUnreserved?: number;
  includedPerMonth: number;
  /** Undefined when an older server does not report plan entitlement. */
  includedCreditsEntitled?: boolean;
  usageClass?: "customer" | "master_auth";
  cycleEndsAt: string;
  cycleStartedAt: string;
  cycleAnchorAt: string;
  turnInFlightUntil: string | null;
  purchaseUrl: string | null;
  billingCycle?: "monthly" | "annual" | "unknown";
  /** The account has used the iOS app. False when an older server doesn't say. */
  iosAppLinked?: boolean;
  /**
   * The plan subscription that can still bill (T-5348); null with none.
   * Undefined when an older server does not say. past_due and unpaid mean a
   * failed renewal: the card needs fixing in the billing portal.
   */
  subscriptionStatus?: "active" | "trialing" | "past_due" | "unpaid" | null;
  annualUpgradeOffer?: {
    amountSavedCents: number;
    percentSaved: number;
    annualPriceCents: number;
    monthlyEquivalentAnnualCents: number;
    checkoutUrl: string;
  } | null;
};

export type CreditsBalanceServerTiming = Readonly<{
  authMs?: number;
  rateLimitMs?: number;
  balanceStoreMs?: number;
  totalMs?: number;
}>;

export type CreditsBalanceObservation = Readonly<{
  transport?: PlatformTransport;
  status?: number;
  serverTiming?: CreditsBalanceServerTiming;
}>;

const CREDITS_SERVER_TIMING_NAMES = Object.freeze({
  auth: "authMs",
  "rate-limit": "rateLimitMs",
  "balance-store": "balanceStoreMs",
  total: "totalMs",
} as const);
const MAX_CREDITS_SERVER_TIMING_HEADER_LENGTH = 1_024;

/** Parse only the bounded phase durations owned by the credits-balance route. */
function parseCreditsBalanceServerTiming(
  header: string | null,
): CreditsBalanceServerTiming | undefined {
  const timing = parseBoundedServerTiming(header, {
    fields: CREDITS_SERVER_TIMING_NAMES,
    maximumHeaderLength: MAX_CREDITS_SERVER_TIMING_HEADER_LENGTH,
    maximumEntries: 16,
  });
  return timing ? Object.freeze(timing as CreditsBalanceServerTiming) : undefined;
}

const invalidCreditsBalance = (): never => {
  throw new SystemSculptError(
    "Unable to read credits balance.",
    ERROR_CODES.INVALID_RESPONSE,
    502,
  );
};

const creditsInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidCreditsBalance();
  }
  return value;
};

const creditsTimestamp = (value: unknown): string => {
  if (typeof value !== "string") return invalidCreditsBalance();
  const normalized = value.trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) return invalidCreditsBalance();
  return normalized;
};

const SYSTEMSCULPT_WEBSITE_HOST = new URL(SYSTEMSCULPT_WEBSITE.BASE_URL).hostname.toLowerCase();
const SYSTEMSCULPT_WEBSITE_ALLOWED_HOSTS = new Set(
  [SYSTEMSCULPT_WEBSITE_HOST, `www.${SYSTEMSCULPT_WEBSITE_HOST}`]
);

const normalizeCreditsCheckoutUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;

  if (normalized.startsWith("//")) return null;

  let parsed: URL;
  try {
    parsed = normalized.startsWith("/")
      ? new URL(normalized, SYSTEMSCULPT_WEBSITE.BASE_URL)
      : new URL(normalized);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port) return null;
  if (!SYSTEMSCULPT_WEBSITE_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null;
  }

  return parsed.toString();
};

function decodeCreditsBalance(payload: unknown): CreditsBalanceSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return invalidCreditsBalance();
  }
  const value = payload as Record<string, unknown>;
  const includedRemaining = creditsInteger(value.included_remaining);
  const addOnRemaining = creditsInteger(value.add_on_remaining);
  const totalRemaining = creditsInteger(value.total_remaining);
  const includedPerMonth = creditsInteger(value.included_per_month);
  if (!Number.isSafeInteger(includedRemaining + addOnRemaining) || totalRemaining !== includedRemaining + addOnRemaining) {
    return invalidCreditsBalance();
  }
  const hasHeldInFlight = Object.prototype.hasOwnProperty.call(value, "held_in_flight");
  const hasAvailableUnreserved = Object.prototype.hasOwnProperty.call(value, "available_unreserved");
  if (hasHeldInFlight !== hasAvailableUnreserved) return invalidCreditsBalance();
  const heldInFlight = hasHeldInFlight ? creditsInteger(value.held_in_flight) : 0;
  const availableUnreserved = hasAvailableUnreserved
    ? creditsInteger(value.available_unreserved)
    : totalRemaining;
  if (availableUnreserved !== Math.max(0, totalRemaining - heldInFlight)) {
    return invalidCreditsBalance();
  }
  const usageClass = value.usage_class;
  if (usageClass !== "customer" && usageClass !== "master_auth") {
    return invalidCreditsBalance();
  }

  const cycleAnchorAt = creditsTimestamp(value.cycle_anchor_at);
  const cycleStartedAt = creditsTimestamp(value.cycle_started_at);
  const cycleEndsAt = creditsTimestamp(value.cycle_ends_at);
  const turnInFlightUntil = value.turn_in_flight_until === null
    ? null
    : creditsTimestamp(value.turn_in_flight_until);

  const billingCycleValue = typeof value.billing_cycle === "string"
    ? value.billing_cycle.trim().toLowerCase()
    : "";
  const billingCycle: "monthly" | "annual" | "unknown" =
    billingCycleValue === "monthly" || billingCycleValue === "annual"
      ? billingCycleValue
      : "unknown";

  let annualUpgradeOffer: CreditsBalanceSnapshot["annualUpgradeOffer"] = null;
  const offer = value.annual_upgrade_offer;
  if (offer && typeof offer === "object" && !Array.isArray(offer)) {
    const candidate = offer as Record<string, unknown>;
    const amountSavedCents = candidate.amount_saved_cents;
    const percentSaved = candidate.percent_saved;
    const annualPriceCents = candidate.annual_price_cents;
    const monthlyEquivalentAnnualCents = candidate.monthly_equivalent_annual_cents;
    const checkoutUrl = normalizeCreditsCheckoutUrl(candidate.checkout_path);
    if (
      typeof amountSavedCents === "number" && Number.isSafeInteger(amountSavedCents) && amountSavedCents > 0 &&
      typeof percentSaved === "number" && Number.isSafeInteger(percentSaved) && percentSaved > 0 &&
      typeof annualPriceCents === "number" && Number.isSafeInteger(annualPriceCents) && annualPriceCents > 0 &&
      typeof monthlyEquivalentAnnualCents === "number" && Number.isSafeInteger(monthlyEquivalentAnnualCents) &&
      monthlyEquivalentAnnualCents > annualPriceCents && checkoutUrl
    ) {
      annualUpgradeOffer = {
        amountSavedCents,
        percentSaved,
        annualPriceCents,
        monthlyEquivalentAnnualCents,
        checkoutUrl,
      };
    }
  }

  return {
    includedRemaining,
    addOnRemaining,
    totalRemaining,
    heldInFlight,
    availableUnreserved,
    includedPerMonth,
    ...(typeof value.included_credits_entitled === "boolean"
      ? { includedCreditsEntitled: value.included_credits_entitled }
      : {}),
    usageClass,
    cycleEndsAt,
    cycleStartedAt,
    cycleAnchorAt,
    turnInFlightUntil,
    purchaseUrl: normalizeCreditsCheckoutUrl(value.purchase_url),
    billingCycle,
    iosAppLinked: value.ios_app_linked === true,
    ...(value.subscription_status === null
      || value.subscription_status === "active" || value.subscription_status === "trialing"
      || value.subscription_status === "past_due" || value.subscription_status === "unpaid"
      ? { subscriptionStatus: value.subscription_status }
      : {}),
    annualUpgradeOffer,
  };
}

export type CreditsUsageSnapshot = {
  id: string;
  createdAt: string;
  transactionType: "agent_turn";
  endpoint: string | null;
  usageKind:
    | "audio_transcription"
    | "embeddings"
    | "document_processing"
    | "agent_turn"
    | "request";
  durationSeconds: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  pageCount: number;
  creditsCharged: number;
  includedDelta: number;
  addOnDelta: number;
  totalDelta: number;
  includedBefore: number;
  includedAfter: number;
  addOnBefore: number;
  addOnAfter: number;
  totalBefore: number;
  totalAfter: number;
  rawUsd?: number;
  fileSizeBytes: number | null;
  fileFormat: string | null;
  billingFormulaVersion?: string | null;
  billingCreditsPerUsd?: number | null;
  billingMarkupMultiplier?: number | null;
  billingCreditsExact?: number | null;
};

export type CreditsUsageHistoryPage = {
  items: CreditsUsageSnapshot[];
  nextBefore: string | null;
};

/**
 * Hosted credits access: credentialed requests, wire validation and shared balance
 * freshness belong here. Callers receive snapshots, never billing authority.
 * The license getter stays live across settings replacement and account changes.
 */
export class HostedCreditsClient {
  private readonly balances: CreditsBalanceCache;

  constructor(private readonly options: Readonly<{
    baseUrl: string;
    licenseKey: () => string;
    requestClient: Pick<PlatformRequestClient, "request">;
  }>) {
    this.balances = new CreditsBalanceCache({
      fetch: (request) => this.fetchBalance(request),
      licenseKey: options.licenseKey,
    });
  }

  /**
   * Shared display/preflight read. Pass fresh after a billed turn, billing failure
   * or purchase. Cancelling one caller never cancels another caller's read.
   */
  public readBalance(options: CreditsBalanceReadOptions = {}): Promise<CreditsBalanceSnapshot> {
    return this.balances.read(options);
  }

  /** Hear each newly published balance for the current account, e.g. after a top-up. */
  public subscribe(listener: (balance: CreditsBalanceSnapshot) => void): () => void {
    return this.balances.subscribe(listener);
  }

  private async fetchBalance(options: Readonly<{
    onObservation?: (observation: CreditsBalanceObservation) => void;
  }>): Promise<CreditsBalanceSnapshot> {
    const licenseKey = this.options.licenseKey().trim();
    if (!licenseKey) {
      throw new SystemSculptError(
        "License key required to fetch credits balance.",
        ERROR_CODES.INVALID_LICENSE,
        401,
        // Route missing credentials through the managed Account recovery flow.
        { licenseFailure: true }
      );
    }

    const url = `${this.options.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.CREDITS.BALANCE}`;
    const headers: Record<string, string> = {
      ...SystemSculptEnvironment.buildHeaders(licenseKey),
      Accept: "application/json",
    };
    let transport: PlatformTransport | undefined;
    let response: Response;
    try {
      response = await this.options.requestClient.request({
        url,
        method: "GET",
        headers,
        onTransportSelected: (selected) => { transport = selected; },
      });
    } catch (error) {
      this.observeCreditsBalanceRequest(options.onObservation, { transport });
      throw error;
    }
    const serverTiming = parseCreditsBalanceServerTiming(response.headers.get("server-timing"));
    this.observeCreditsBalanceRequest(options.onObservation, {
      transport,
      status: response.status,
      ...(serverTiming ? { serverTiming } : {}),
    });

    if (!response.ok) {
      await StreamingErrorHandler.handleResponseError(response, {
        endpoint: url,
      });
    }

    try {
      return decodeCreditsBalance(await response.json());
    } catch (error) {
      if (error instanceof SystemSculptError && error.code === ERROR_CODES.INVALID_RESPONSE) {
        throw error;
      }
      return invalidCreditsBalance();
    }
  }

  private observeCreditsBalanceRequest(
    observer: ((observation: CreditsBalanceObservation) => void) | undefined,
    observation: CreditsBalanceObservation,
  ): void {
    try {
      observer?.(observation);
    } catch {
      // Diagnostics must never alter balance retrieval.
    }
  }

  public async readUsage(params?: {
    limit?: number;
    before?: string;
    endpoints?: string[];
    signal?: AbortSignal;
  }): Promise<CreditsUsageHistoryPage> {
    const licenseKey = this.options.licenseKey().trim();
    if (!licenseKey) {
      throw new SystemSculptError(
        "License key required to fetch credits usage.",
        ERROR_CODES.INVALID_LICENSE,
        401
      );
    }

    const requestUrlValue = new URL(
      `${this.options.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.CREDITS.USAGE}`
    );
    if (typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
      requestUrlValue.searchParams.set("limit", String(Math.floor(params.limit)));
    }
    if (typeof params?.before === "string" && params.before.trim().length > 0) {
      requestUrlValue.searchParams.set("before", params.before.trim());
    }
    if (Array.isArray(params?.endpoints)) {
      for (const endpoint of params.endpoints) {
        if (typeof endpoint !== "string") continue;
        const trimmed = endpoint.trim();
        if (!trimmed) continue;
        requestUrlValue.searchParams.append("endpoint", trimmed);
      }
    }

    const headers: Record<string, string> = {
      ...SystemSculptEnvironment.buildHeaders(licenseKey),
      Accept: "application/json",
    };
    const response = await this.options.requestClient.request({
      url: requestUrlValue.toString(),
      method: "GET",
      headers,
      signal: params?.signal,
    });

    if (!response.ok) {
      await StreamingErrorHandler.handleResponseError(response, {
        endpoint: requestUrlValue.toString(),
      });
    }

    const payloadValue: unknown = await response.json();
    const payload: Record<string, unknown> = payloadValue
      && typeof payloadValue === "object"
      && !Array.isArray(payloadValue)
      ? payloadValue as Record<string, unknown>
      : {};
    const asNumber = (value: unknown): number => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return 0;
    };
    const asString = (value: unknown): string => (typeof value === "string" ? value : "");
    const asNullableString = (value: unknown): string | null => {
      const str = asString(value).trim();
      return str.length > 0 ? str : null;
    };
    const asUsageKind = (value: unknown): CreditsUsageSnapshot["usageKind"] => {
      const raw = asString(value);
      if (
        raw === "audio_transcription" ||
        raw === "embeddings" ||
        raw === "document_processing" ||
        raw === "agent_turn" ||
        raw === "request"
      ) {
        return raw;
      }
      return "request";
    };

    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const items: CreditsUsageSnapshot[] = rawItems.map((itemValue: unknown) => {
      const item: Record<string, unknown> = itemValue
        && typeof itemValue === "object"
        && !Array.isArray(itemValue)
        ? itemValue as Record<string, unknown>
        : {};
      return {
        id: asString(item.id),
        createdAt: asString(item.created_at),
        transactionType: "agent_turn",
        endpoint: asNullableString(item.endpoint),
        usageKind: asUsageKind(item.usage_kind),
        durationSeconds: asNumber(item.duration_seconds),
        totalTokens: asNumber(item.total_tokens),
        inputTokens: asNumber(item.input_tokens),
        outputTokens: asNumber(item.output_tokens),
        cacheReadTokens: asNumber(item.cache_read_tokens),
        cacheWriteTokens: asNumber(item.cache_write_tokens),
        pageCount: asNumber(item.page_count),
        creditsCharged: asNumber(item.credits_charged),
        includedDelta: asNumber(item.included_delta),
        addOnDelta: asNumber(item.add_on_delta),
        totalDelta: asNumber(item.total_delta),
        includedBefore: asNumber(item.included_before),
        includedAfter: asNumber(item.included_after),
        addOnBefore: asNumber(item.add_on_before),
        addOnAfter: asNumber(item.add_on_after),
        totalBefore: asNumber(item.total_before),
        totalAfter: asNumber(item.total_after),
        rawUsd: asNumber(item.raw_usd),
        fileSizeBytes:
          item.file_size_bytes === null || item.file_size_bytes === undefined
            ? null
            : asNumber(item.file_size_bytes),
        fileFormat: asNullableString(item.file_format),
        billingFormulaVersion: asNullableString(item.billing_formula_version),
        billingCreditsPerUsd:
          item.billing_credits_per_usd === null || item.billing_credits_per_usd === undefined
            ? null
            : asNumber(item.billing_credits_per_usd),
        billingMarkupMultiplier:
          item.billing_markup_multiplier === null || item.billing_markup_multiplier === undefined
            ? null
            : asNumber(item.billing_markup_multiplier),
        billingCreditsExact:
          item.billing_credits_exact === null || item.billing_credits_exact === undefined
            ? null
            : asNumber(item.billing_credits_exact),
      };
    });

    return {
      items,
      nextBefore: asNullableString(payload.next_before),
    };
  }
}
