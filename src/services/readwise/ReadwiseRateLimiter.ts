/**
 * Readwise Rate Limiter
 * Manages API request rate limiting to stay within Readwise's limits
 *
 * Readwise limits:
 * - Base rate: 240 requests per minute
 * - Export endpoint: 20 requests per minute
 *
 * We use a conservative limit of 18 requests per minute for the export endpoint.
 */

import { READWISE_RATE_LIMIT_PER_MINUTE } from "../../types/readwise";

export class ReadwiseRateLimiter {
  private requestTimestamps: number[] = [];
  private pausedUntil: number = 0;
  private readonly windowMs = 60000; // 1 minute window
  private readonly maxRequests: number;

  constructor(maxRequestsPerMinute: number = READWISE_RATE_LIMIT_PER_MINUTE) {
    this.maxRequests = maxRequestsPerMinute;
  }

  /**
   * Wait for an available request slot
   * Returns a promise that resolves when it's safe to make a request
   */
  async waitForSlot(): Promise<void> {
    const now = Date.now();

    // Check if we're in a forced pause from Retry-After header
    if (this.pausedUntil > now) {
      const waitTime = this.pausedUntil - now;
      await this.sleep(waitTime);
    }

    // Clean old timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => t > now - this.windowMs
    );

    // If we're at capacity, wait for the oldest request to expire
    if (this.requestTimestamps.length >= this.maxRequests) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = oldestTimestamp + this.windowMs - now + 100; // Add 100ms buffer
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }

    // Record this request
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Handle a 429 Retry-After response
   * @param seconds Number of seconds to wait before retrying
   */
  handleRetryAfter(seconds: number): void {
    this.pausedUntil = Date.now() + seconds * 1000;
    // Clear request timestamps since we're being rate limited anyway
    this.requestTimestamps = [];
  }

  /**
   * Get the current wait time before a request can be made
   * Returns 0 if a slot is immediately available
   */
  getWaitTimeMs(): number {
    const now = Date.now();

    // Check forced pause
    if (this.pausedUntil > now) {
      return this.pausedUntil - now;
    }

    // Clean old timestamps
    const recentRequests = this.requestTimestamps.filter(
      (t) => t > now - this.windowMs
    );

    if (recentRequests.length >= this.maxRequests) {
      const oldestTimestamp = recentRequests[0];
      return Math.max(0, oldestTimestamp + this.windowMs - now + 100);
    }

    return 0;
  }

  /**
   * Reset the rate limiter state
   */
  reset(): void {
    this.requestTimestamps = [];
    this.pausedUntil = 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
