import { managedMediaDeliveryOffset, MANAGED_MEDIA_DELIVERY_MAX_OFFSET_MS } from "../ManagedMediaDeliveryTiming";

const delivery = { downloadStartedAt: "2026-01-01T00:00:00.000Z", downloadCompletedOffsetMs: 100 };
const clock = { completedOffsetMs: 100, completedAtMs: 1_000 };

describe("managed media delivery offset policy", () => {
  it("uses monotonic elapsed time for live delivery and rounds to milliseconds", () => {
    expect(managedMediaDeliveryOffset(delivery, clock, 1_249.6)).toBe(350);
  });

  it("does not regress when a live clock moves backwards", () => {
    expect(managedMediaDeliveryOffset(delivery, clock, 900)).toBe(100);
  });

  it("uses the saved wall-clock start after restart", () => {
    expect(managedMediaDeliveryOffset(delivery, undefined, Date.parse(delivery.downloadStartedAt) + 200)).toBe(200);
  });

  it("preserves the last displayed offset with live and restarted clocks", () => {
    const displayed = { ...delivery, displayedOffsetMs: 400 };
    expect(managedMediaDeliveryOffset(displayed, clock, 1_200)).toBe(400);
    expect(managedMediaDeliveryOffset(displayed, undefined, 0)).toBe(400);
  });

  it("caps both timing paths at the wire contract's seven-day limit", () => {
    expect(managedMediaDeliveryOffset(delivery, clock, Number.MAX_SAFE_INTEGER)).toBe(MANAGED_MEDIA_DELIVERY_MAX_OFFSET_MS);
    expect(managedMediaDeliveryOffset(delivery, undefined, Number.MAX_SAFE_INTEGER)).toBe(MANAGED_MEDIA_DELIVERY_MAX_OFFSET_MS);
  });
});
