import SystemSculptPlugin from "../../main";
import { EmbeddingsProviderError } from "./providers/ProviderError";

export interface EmbeddingsHealthSnapshot {
  consecutiveFailures: number;
  lastError?: {
    code: string;
    message: string;
    at: number;
    retryInMs?: number;
    status?: number;
  };
}

export class EmbeddingsHealthMonitor {
  private consecutiveFailures = 0;
  private lastError: EmbeddingsHealthSnapshot["lastError"] | undefined;
  private lastNoticeAt = 0;

  constructor(private plugin: SystemSculptPlugin) {}

  getSnapshot(): EmbeddingsHealthSnapshot {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  recordSuccess(scope: "vault" | "file" | "query"): void {
    if (this.consecutiveFailures > 0) {
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      try {
        this.plugin.emitter?.emit("embeddings:recovered", { scope, timestamp: Date.now() });
      } catch {}
    }
  }

  async recordFailure(
    scope: "vault" | "file" | "query",
    error: EmbeddingsProviderError,
    context?: { attempt?: number }
  ): Promise<void> {
    this.consecutiveFailures += 1;
    this.lastError = {
      code: error.code,
      message: error.message,
      at: Date.now(),
      retryInMs: error.retryInMs,
      status: error.status,
    };

    try {
      this.plugin.emitter?.emit("embeddings:error", {
        scope,
        error: {
          code: error.code,
          message: error.message,
          retryInMs: error.retryInMs,
          status: error.status,
          transient: error.transient,
          licenseRelated: error.licenseRelated,
          details: error.details,
        },
        failures: this.consecutiveFailures,
        timestamp: this.lastError.at,
        attempt: context?.attempt ?? 0,
      });
    } catch {}

    const now = Date.now();
    const shouldNotify = now - this.lastNoticeAt > 120000; // 2 minute cooldown
    if (shouldNotify) {
      this.lastNoticeAt = now;
      try {
        const { showNoticeWhenReady } = await import("../../core/ui/notifications");
        const retryHint = error.retryInMs
          ? ` The plugin will retry automatically in ${Math.round(error.retryInMs / 1000)} seconds.`
          : "";
        showNoticeWhenReady(
          this.plugin.app,
          `Embeddings error: ${error.message}.${retryHint}`,
          { type: "error", duration: 8000 }
        );
      } catch {}
    }
  }
}
