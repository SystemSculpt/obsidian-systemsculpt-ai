import type { ManagedMediaDeliveryState } from "./ManagedTypes";

export const MANAGED_MEDIA_DELIVERY_MAX_OFFSET_MS = 7 * 24 * 60 * 60 * 1_000;
export interface ManagedMediaDeliveryClock {
  completedOffsetMs: number;
  completedAtMs: number;
}

/** Use a live monotonic observation, or wall time after restart, without regressing recorded offsets. */
export function managedMediaDeliveryOffset(
  delivery: ManagedMediaDeliveryState,
  clock: ManagedMediaDeliveryClock | undefined,
  observedTimeMs: number,
): number {
  const rawOffset = clock
    ? clock.completedOffsetMs + Math.max(0, observedTimeMs - clock.completedAtMs)
    : observedTimeMs - Date.parse(delivery.downloadStartedAt);
  const floor = delivery.displayedOffsetMs ?? delivery.downloadCompletedOffsetMs;
  return Math.min(MANAGED_MEDIA_DELIVERY_MAX_OFFSET_MS, Math.max(floor, Math.round(rawOffset)));
}
