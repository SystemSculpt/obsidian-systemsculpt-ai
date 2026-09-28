/**
 * @jest-environment node
 */
import { SystemSculptService } from "../SystemSculptService";
import { ERROR_CODES } from "../../utils/errors";

jest.mock("../../tools/FirstPartyToolService", () => ({
  FirstPartyToolService: jest.fn(),
}));

const creditsBalancePayload = {
  included_remaining: 5,
  add_on_remaining: 0,
  total_remaining: 5,
  held_in_flight: 0,
  available_unreserved: 5,
  included_per_month: 5,
  usage_class: "customer",
  cycle_anchor_at: "2026-07-01T00:00:00.000Z",
  cycle_started_at: "2026-07-01T00:00:00.000Z",
  cycle_ends_at: "2026-08-01T00:00:00.000Z",
  turn_in_flight_until: null,
  purchase_url: null,
};

describe("SystemSculptService settings", () => {
  afterEach(() => {
    SystemSculptService.clearInstance();
  });

  it("reads the license key from the settings object each save installs", async () => {
    const plugin = { app: {}, settings: { licenseKey: "" } } as any;
    const service = SystemSculptService.getInstance(plugin);
    const request = jest.fn(async () => new Response(JSON.stringify(creditsBalancePayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    (service as any).requestClient = { request };

    await expect(service.getCreditsBalance()).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_LICENSE,
    });
    expect(request).not.toHaveBeenCalled();

    // SettingsManager replaces the whole object rather than mutating it.
    plugin.settings = { ...plugin.settings, licenseKey: " license_after_save " };

    await expect(service.getCreditsBalance()).resolves.toMatchObject({ totalRemaining: 5 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((request.mock.calls[0] as unknown[])[0])).toContain("license_after_save");
    expect(SystemSculptService.getInstance(plugin)).toBe(service);
  });
});
