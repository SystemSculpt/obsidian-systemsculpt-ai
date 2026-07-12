import { requestUrl } from "obsidian";
import { SystemSculptSettings } from "../types";
import {
  SystemSculptError,
  ERROR_CODES,
} from "../utils/errors";
import SystemSculptPlugin from "../main";

import { PlatformContext } from "./PlatformContext";
import { SystemSculptEnvironment } from "./api/SystemSculptEnvironment";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";
import { SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";

import { StreamingErrorHandler } from "./StreamingErrorHandler";
import { LicenseService } from "./LicenseService";
import { ContextFileService } from "./ContextFileService";
import { ChatRequestPreparationService, type ManagedChatPreparationInput } from "./chat/ChatRequestPreparationService";
import type { AcceptedChatRequestSnapshot } from "./chat/AcceptedChatRequestSnapshot";
import type { AcceptedChatOperation } from "./managed/ManagedTypes";
import { MCPService } from "../mcp/MCPService";
import type { ToolCall, ToolCallRequest, ToolCallResult } from "../types/toolCalls";

export type CreditsBalanceSnapshot = {
  includedRemaining: number;
  addOnRemaining: number;
  totalRemaining: number;
  includedPerMonth: number;
  cycleEndsAt: string;
  cycleStartedAt: string;
  cycleAnchorAt: string;
  turnInFlightUntil: string | null;
  purchaseUrl: string | null;
  billingCycle?: "monthly" | "annual" | "unknown";
  annualUpgradeOffer?: {
    amountSavedCents: number;
    percentSaved: number;
    annualPriceCents: number;
    monthlyEquivalentAnnualCents: number;
    checkoutUrl: string;
  } | null;
};

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

const creditsCheckoutUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (!normalized.startsWith("/")) return null;
  try {
    return new URL(normalized, SYSTEMSCULPT_WEBSITE.BASE_URL).toString();
  } catch {
    return null;
  }
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
    const checkoutUrl = creditsCheckoutUrl(candidate.checkout_path);
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
    includedPerMonth,
    cycleEndsAt,
    cycleStartedAt,
    cycleAnchorAt,
    turnInFlightUntil,
    purchaseUrl: creditsCheckoutUrl(value.purchase_url),
    billingCycle,
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
    | "youtube_transcript"
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
 * Main service facade that delegates to specialized services
 */
export class SystemSculptService {
  private settings: SystemSculptSettings;
  private static instance: SystemSculptService | null = null;
  public baseUrl: string;
  private plugin: SystemSculptPlugin;
  private licenseService: LicenseService;
  private contextFileService: ContextFileService;
  private mcpService: MCPService;
  private acceptedChatPreparation = new ChatRequestPreparationService();

  private managedPreparationDependencies() {
    return {
      contextFileService: this.contextFileService,
      getAvailableTools: () => this.mcpService.getAvailableTools(),
    };
  }

  public prepareAcceptedChatRequest(
    operation: AcceptedChatOperation,
    options: ManagedChatPreparationInput,
  ): Promise<AcceptedChatRequestSnapshot> {
    this.refreshSettings();
    return this.acceptedChatPreparation.prepare(
      operation,
      options,
      this.managedPreparationDependencies(),
    );
  }

  public releaseAcceptedChatRequest(operation: AcceptedChatOperation): void {
    this.acceptedChatPreparation.release(operation);
  }

  private constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = plugin.settings;
    
    // The endpoint is injected at build time; settings never own network routing.
    this.baseUrl = this.getValidServerUrl();

    this.licenseService = new LicenseService(plugin, this.baseUrl);
    this.contextFileService = new ContextFileService(plugin.app);
    this.mcpService = new MCPService(plugin, plugin.app);
  }

  /**
   * Get the singleton instance - use this instead of creating new instances
   */
  public static getInstance(plugin: SystemSculptPlugin): SystemSculptService {
    if (!SystemSculptService.instance) {
      SystemSculptService.instance = new SystemSculptService(plugin);
    } else {
      // Update settings if instance exists
      SystemSculptService.instance.updateSettings(plugin.settings);
    }
    return SystemSculptService.instance;
  }

  /**
   * Clear singleton instance for cleanup
   */
  public static clearInstance(): void {
    SystemSculptService.instance = null;
  }

  /**
   * Update settings on existing instance
   */
  public updateSettings(settings: SystemSculptSettings): void {
    this.settings = settings;
    this.refreshSettings();
  }

  private getValidServerUrl(): string {
    return SystemSculptEnvironment.resolveBaseUrl();
  }

  private refreshSettings(): void {
    this.settings = this.plugin.settings;
    this.baseUrl = this.getValidServerUrl();
    this.licenseService.updateBaseUrl(this.baseUrl);
  }

  // DELEGATE TO LICENSE SERVICE
  async validateLicense(forceCheck = false): Promise<boolean> {
    this.refreshSettings(); // Ensure settings are current before validation
    return this.licenseService.validateLicense(forceCheck);
  }

  public async getCreditsBalance(): Promise<CreditsBalanceSnapshot> {
    this.refreshSettings();

    const licenseKey = (this.settings.licenseKey || "").trim();
    if (!licenseKey) {
      throw new SystemSculptError(
        "License key required to fetch credits balance.",
        ERROR_CODES.INVALID_LICENSE,
        401,
        // Route missing credentials through the managed Account recovery flow.
        { licenseFailure: true }
      );
    }

    const url = `${this.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.CREDITS.BALANCE}`;
    const platform = PlatformContext.get();
    const transport = platform.preferredTransport({ endpoint: url });

    const headers: Record<string, string> = {
      ...SystemSculptEnvironment.buildHeaders(licenseKey),
      Accept: "application/json",
    };

    let response: Response;
    if (transport === "fetch" && typeof fetch === "function") {
      response = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
      } as RequestInit);
    } else {
      const result = await requestUrl({
        url,
        method: "GET",
        headers,
        throw: false,
      });

      const status = result.status || 500;
      const textBody =
        typeof result.text === "string"
          ? result.text
          : JSON.stringify(result.json || {});

      response = new Response(textBody, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

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

  public async getCreditsUsage(params?: {
    limit?: number;
    before?: string;
    endpoints?: string[];
  }): Promise<CreditsUsageHistoryPage> {
    this.refreshSettings();

    const licenseKey = (this.settings.licenseKey || "").trim();
    if (!licenseKey) {
      throw new SystemSculptError(
        "License key required to fetch credits usage.",
        ERROR_CODES.INVALID_LICENSE,
        401
      );
    }

    const requestUrlValue = new URL(
      `${this.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.CREDITS.USAGE}`
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

    const platform = PlatformContext.get();
    const transport = platform.preferredTransport({ endpoint: requestUrlValue.toString() });

    const headers: Record<string, string> = {
      ...SystemSculptEnvironment.buildHeaders(licenseKey),
      Accept: "application/json",
    };

    let response: Response;
    if (transport === "fetch" && typeof fetch === "function") {
      response = await fetch(requestUrlValue.toString(), {
        method: "GET",
        headers,
        cache: "no-store",
      } as RequestInit);
    } else {
      const result = await requestUrl({
        url: requestUrlValue.toString(),
        method: "GET",
        headers,
        throw: false,
      });

      const status = result.status || 500;
      const textBody =
        typeof result.text === "string"
          ? result.text
          : JSON.stringify(result.json || {});

      response = new Response(textBody, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!response.ok) {
      await StreamingErrorHandler.handleResponseError(response, {
        endpoint: requestUrlValue.toString(),
      });
    }

    const payload = (await response.json()) as any;
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
        raw === "youtube_transcript" ||
        raw === "agent_turn" ||
        raw === "request"
      ) {
        return raw;
      }
      return "request";
    };

    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const items: CreditsUsageSnapshot[] = rawItems.map((item: any) => ({
      id: asString(item?.id),
      createdAt: asString(item?.created_at),
      transactionType: "agent_turn",
      endpoint: asNullableString(item?.endpoint),
      usageKind: asUsageKind(item?.usage_kind),
      durationSeconds: asNumber(item?.duration_seconds),
      totalTokens: asNumber(item?.total_tokens),
      inputTokens: asNumber(item?.input_tokens),
      outputTokens: asNumber(item?.output_tokens),
      cacheReadTokens: asNumber(item?.cache_read_tokens),
      cacheWriteTokens: asNumber(item?.cache_write_tokens),
      pageCount: asNumber(item?.page_count),
      creditsCharged: asNumber(item?.credits_charged),
      includedDelta: asNumber(item?.included_delta),
      addOnDelta: asNumber(item?.add_on_delta),
      totalDelta: asNumber(item?.total_delta),
      includedBefore: asNumber(item?.included_before),
      includedAfter: asNumber(item?.included_after),
      addOnBefore: asNumber(item?.add_on_before),
      addOnAfter: asNumber(item?.add_on_after),
      totalBefore: asNumber(item?.total_before),
      totalAfter: asNumber(item?.total_after),
      rawUsd: asNumber(item?.raw_usd),
      fileSizeBytes:
        item?.file_size_bytes === null || item?.file_size_bytes === undefined
          ? null
          : asNumber(item?.file_size_bytes),
      fileFormat: asNullableString(item?.file_format),
      billingFormulaVersion: asNullableString(item?.billing_formula_version),
      billingCreditsPerUsd:
        item?.billing_credits_per_usd === null || item?.billing_credits_per_usd === undefined
          ? null
          : asNumber(item?.billing_credits_per_usd),
      billingMarkupMultiplier:
        item?.billing_markup_multiplier === null || item?.billing_markup_multiplier === undefined
          ? null
          : asNumber(item?.billing_markup_multiplier),
      billingCreditsExact:
        item?.billing_credits_exact === null || item?.billing_credits_exact === undefined
          ? null
          : asNumber(item?.billing_credits_exact),
    }));

    return {
      items,
      nextBefore: asNullableString(payload?.next_before),
    };
  }
  public async executeHostedToolCall(options: {
    toolCall: ToolCall | ToolCallRequest;
    chatView?: any;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ToolCallResult> {
    const request = ((options.toolCall as ToolCall)?.request || options.toolCall || {}) as ToolCallRequest;
    if (options.signal?.aborted) {
      return {
        success: false,
        error: {
          code: 'TOOL_CANCELLED_BEFORE_START',
          message: 'Tool execution was cancelled before it started.',
        },
      };
    }
    const functionName = String(request?.function?.name || "").trim();
    if (!functionName) {
      return {
        success: false,
        error: {
          code: "INVALID_TOOL_CALL",
          message: "Tool call is missing a function name.",
        },
      };
    }

    const rawArguments = request?.function?.arguments;
    let parsedArgs: any = {};
    if (typeof rawArguments === "string" && rawArguments.trim().length > 0) {
      try {
        parsedArgs = JSON.parse(rawArguments);
      } catch (error) {
        return {
          success: false,
          error: {
            code: "INVALID_TOOL_ARGUMENTS",
            message: `Tool call arguments for ${functionName} were not valid JSON.`,
            details: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    try {
      const data = await this.mcpService.executeTool(functionName, parsedArgs, options.chatView, {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      return {
        success: true,
        data,
      };
    } catch (error) {
      const executionCode = (error as { code?: unknown })?.code;
      return {
        success: false,
        error: {
          code: executionCode === 'TOOL_CANCELLED_BEFORE_START'
            || executionCode === 'TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN'
            ? executionCode
            : "TOOL_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : `Tool execution failed for ${functionName}.`,
          details: error,
        },
      };
    }
  }

}
