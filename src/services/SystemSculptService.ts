import {
  SystemSculptError,
  ERROR_CODES,
} from "../utils/errors";
import SystemSculptPlugin from "../main";

import { PlatformRequestClient } from "./PlatformRequestClient";
import { SystemSculptEnvironment } from "./api/SystemSculptEnvironment";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";

import { StreamingErrorHandler } from "./StreamingErrorHandler";
import { LicenseService, type LicenseValidationResult } from "./LicenseService";
import { FirstPartyToolService } from "../tools/FirstPartyToolService";
import type { ToolCall, ToolCallRequest, ToolCallResult } from "../types/toolCalls";
import type { FirstPartyToolChatTarget } from "../tools/types";
import {
  analyzeLocalToolOutcome,
  localToolFailureMessage,
  localToolOutcomeSchema,
} from "../tools/LocalToolOutcome";
import { HostedCreditsClient } from "./credits/HostedCreditsClient";

/**
 * First-party tools often return an honest structured result instead of throwing.
 * Translate those resolved failures into the same ToolCallResult failure channel
 * used for thrown errors, while retaining the full result for agent recovery.
 * @internal Unit-tested directly.
 */
export function normalizeLocalToolOutcome(
  data: unknown,
  canonicalName?: string,
): ToolCallResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { success: true, data };
  }

  const record = data as Record<string, unknown>;
  const schema = canonicalName ? localToolOutcomeSchema(canonicalName) : undefined;
  const analysis = analyzeLocalToolOutcome(data, schema ?? undefined);
  const failures = analysis.failures;

  const topLevelFailure = record.success === false || localToolFailureMessage(record) !== null;
  if (!topLevelFailure && failures.length === 0) {
    return { success: true, data };
  }

  const appliedFiles = typeof record.appliedFiles === "number" ? record.appliedFiles : 0;
  const partial = appliedFiles > 0 || analysis.completed > 0;
  const firstFailure = failures[0]?.message
    ?? (typeof record.error === "string" && record.error.trim() ? record.error.trim() : null)
    ?? "Tool operation reported failure.";

  return {
    success: false,
    data,
    error: {
      code: partial ? "TOOL_PARTIAL_FAILURE" : "TOOL_OPERATION_FAILED",
      message: partial ? `Tool operation partially failed: ${firstFailure}` : firstFailure,
      details: {
        failures,
        result: data,
      },
    },
  };
}

/**
 * Main service facade that delegates to specialized services.
 *
 * Settings are read from `plugin.settings` where they are used: the
 * SettingsManager installs a new settings object on every save.
 */
export class SystemSculptService {
  private static instance: SystemSculptService | null = null;
  public readonly baseUrl: string;
  public readonly credits: HostedCreditsClient;
  private plugin: SystemSculptPlugin;
  private licenseService: LicenseService;
  private toolService: FirstPartyToolService;
  private readonly requestClient = new PlatformRequestClient();

  private constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;

    // The endpoint is injected at build time; settings never own network routing.
    this.baseUrl = SystemSculptEnvironment.resolveBaseUrl();
    this.credits = new HostedCreditsClient({
      baseUrl: this.baseUrl,
      requestClient: this.requestClient,
      licenseKey: () => this.plugin.settings?.licenseKey || "",
    });

    this.licenseService = new LicenseService(plugin);
    this.toolService = new FirstPartyToolService(plugin, plugin.app);
  }

  /**
   * Get the singleton instance - use this instead of creating new instances
   */
  public static getInstance(plugin: SystemSculptPlugin): SystemSculptService {
    SystemSculptService.instance ??= new SystemSculptService(plugin);
    return SystemSculptService.instance;
  }

  /**
   * Clear singleton instance for cleanup
   */
  public static clearInstance(): void {
    SystemSculptService.instance = null;
  }

  // DELEGATE TO LICENSE SERVICE
  async validateLicenseDetailed(signal?: AbortSignal): Promise<LicenseValidationResult> {
    return this.licenseService.validateLicenseDetailed(signal);
  }

  public async executeLocalVaultToolCall(options: {
    toolCall: ToolCall | ToolCallRequest;
    chatView?: FirstPartyToolChatTarget;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ToolCallResult> {
    const request = ((options.toolCall as ToolCall)?.request || options.toolCall || {});
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
    let parsedArgs: unknown = {};
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
      const data = await this.toolService.executeTool(functionName, parsedArgs, {
        timeoutMs: options.timeoutMs,
        ...(typeof request?.id === "string" && request.id ? { callId: request.id } : {}),
        signal: options.signal,
        chatView: options.chatView,
      });
      return normalizeLocalToolOutcome(data, functionName);
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
          details: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * A Stripe billing portal link for this license key's account (T-5348), so
   * a subscriber whose renewal failed can fix their card. The URL is a
   * credential for the customer's billing: open it, never log or store it.
   */
  public async createBillingPortalLink(): Promise<string> {
    const licenseKey = (this.plugin.settings.licenseKey || "").trim();
    if (!licenseKey) {
      throw new SystemSculptError("License key required to open billing.", ERROR_CODES.INVALID_LICENSE, 401);
    }
    const url = `${this.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.BILLING.PORTAL}`;
    const response = await this.requestClient.request({
      url,
      method: "POST",
      headers: { ...SystemSculptEnvironment.buildHeaders(licenseKey), Accept: "application/json" },
    });
    if (!response.ok) {
      await StreamingErrorHandler.handleResponseError(response, { endpoint: url });
    }
    const body = await response.json().catch(() => null) as { url?: unknown } | null;
    const link = typeof body?.url === "string" ? body.url.trim() : "";
    if (!link.startsWith("https://")) {
      throw new SystemSculptError("The billing portal did not return a link.", ERROR_CODES.INVALID_RESPONSE, 502);
    }
    return link;
  }
}
