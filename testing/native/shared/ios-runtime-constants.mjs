/**
 * Shared constants for iOS WebKit Runtime.enable settle-and-retry logic.
 *
 * The WebKit adapter can report an inspectable target before the Runtime
 * domain is actually ready. The settle delay gives the runtime time to
 * finish initialising before we send Runtime.enable.
 */

/** Milliseconds to wait before each Runtime.enable attempt. */
export const IOS_RUNTIME_READY_DELAY_MS = 8000;

/** Maximum number of Runtime.enable attempts before giving up. */
export const IOS_RUNTIME_ENABLE_ATTEMPTS = 3;
