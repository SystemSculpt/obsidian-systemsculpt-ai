/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { DEFAULT_SETTINGS } from "../types";

var capturedCreditsModalOptions: any;
var creditsModalOpenMock: jest.Mock;

jest.mock("../modals/CreditsBalanceModal", () => {
  capturedCreditsModalOptions = null;
  creditsModalOpenMock = jest.fn();

  class MockCreditsBalanceModal {
    constructor(_app: unknown, options: unknown) {
      capturedCreditsModalOptions = options;
    }

    open(): void {
      creditsModalOpenMock();
    }
  }

  return {
    CreditsBalanceModal: MockCreditsBalanceModal,
  };
});

describe("SystemSculptPlugin.openCreditsBalanceModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedCreditsModalOptions = null;
  });

  it("preserves the latest known balance when a refresh fails", async () => {
    const app = new App();
    const plugin = new SystemSculptPlugin(app, {
      id: "systemsculpt",
      version: "1.0.0",
    } as any);

    plugin._internal_settings_systemsculpt_plugin = { ...DEFAULT_SETTINGS };

    const initialBalance = {
      includedRemaining: 2000,
      addOnRemaining: 500,
      totalRemaining: 2500,
      includedPerMonth: 3000,
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
      cycleStartedAt: "2026-02-01T00:00:00.000Z",
      cycleAnchorAt: "2026-02-01T00:00:00.000Z",
      turnInFlightUntil: null,
      purchaseUrl: null,
    };

    const refreshedBalance = {
      includedRemaining: 1800,
      addOnRemaining: 500,
      totalRemaining: 2300,
      includedPerMonth: 3000,
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
      cycleStartedAt: "2026-02-01T00:00:00.000Z",
      cycleAnchorAt: "2026-02-01T00:00:00.000Z",
      turnInFlightUntil: null,
      purchaseUrl: null,
    };

    const getCreditsBalanceMock = jest
      .fn()
      .mockResolvedValueOnce(refreshedBalance)
      .mockRejectedValueOnce(new Error("Transient network failure"));

    (plugin as any)._aiService = {
      getCreditsBalance: getCreditsBalanceMock,
      getCreditsUsage: jest.fn(),
    };

    const onBalanceUpdated = jest.fn().mockResolvedValue(undefined);

    await plugin.openCreditsBalanceModal({
      initialBalance,
      onBalanceUpdated,
    });

    expect(creditsModalOpenMock).toHaveBeenCalledTimes(1);
    expect(capturedCreditsModalOptions).toBeTruthy();
    expect(typeof capturedCreditsModalOptions.loadBalance).toBe("function");

    const firstLoad = await capturedCreditsModalOptions.loadBalance();
    expect(firstLoad).toEqual(refreshedBalance);
    expect(onBalanceUpdated).toHaveBeenCalledWith(refreshedBalance);

    const secondLoad = await capturedCreditsModalOptions.loadBalance();
    expect(secondLoad).toEqual(refreshedBalance);
    expect(onBalanceUpdated).toHaveBeenCalledTimes(1);
    expect(onBalanceUpdated).not.toHaveBeenCalledWith(null);
  });
});

