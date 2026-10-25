/** @jest-environment jsdom */

import { AgentChatView } from "../AgentChatView";
import type { AgentWorkspace } from "../AgentWorkspace";
import type { CreditsBalanceSnapshot, SystemSculptService } from "../../../services/SystemSculptService";

type ReadCreditsBalance = SystemSculptService["readCreditsBalance"];
type SyncChrome = AgentChatView["syncChrome"];
type RefreshCreditsBalance = AgentChatView["refreshCreditsBalance"];
type SetPlanOfferVisible = AgentWorkspace["setPlanOfferVisible"];
type SetBanner = AgentWorkspace["setBanner"];

function mockReadCreditsBalance(implementation?: ReadCreditsBalance) {
  return jest.fn<ReturnType<ReadCreditsBalance>, Parameters<ReadCreditsBalance>>(implementation);
}

function createView(readCreditsBalance: jest.Mock<ReturnType<ReadCreditsBalance>, Parameters<ReadCreditsBalance>>) {
  const view: AgentChatView = Object.create(AgentChatView.prototype);
  const workspace = {
    setPlanOfferVisible: jest.fn<ReturnType<SetPlanOfferVisible>, Parameters<SetPlanOfferVisible>>(),
    setBanner: jest.fn<ReturnType<SetBanner>, Parameters<SetBanner>>(),
  };
  Object.assign(view, {
    plugin: { settings: { licenseKey: "test-license" } },
    aiService: { readCreditsBalance },
    workspace,
    creditsPromise: null,
    creditsBalance: null,
  });
  return { view, workspace };
}

describe("AgentChatView shared credits reads", () => {
  const balance: CreditsBalanceSnapshot = {
    usageClass: "customer",
    totalRemaining: 5,
    availableUnreserved: 5,
    includedRemaining: 5,
    addOnRemaining: 0,
    includedPerMonth: 10_000,
    cycleEndsAt: "2026-08-01T00:00:00.000Z",
    cycleStartedAt: "2026-07-01T00:00:00.000Z",
    cycleAnchorAt: "2026-07-01T00:00:00.000Z",
    turnInFlightUntil: null,
    purchaseUrl: null,
  };

  it("refreshes credits only for an account-key change and chrome only for its own settings", async () => {
    const { view } = createView(mockReadCreditsBalance(async () => balance));
    const on = jest.fn();
    const syncChrome = jest.fn<ReturnType<SyncChrome>, Parameters<SyncChrome>>();
    const refreshCreditsBalance = jest.fn<ReturnType<RefreshCreditsBalance>, Parameters<RefreshCreditsBalance>>(async () => undefined);
    Object.assign(view, {
      app: { workspace: { on } },
      registerEvent: jest.fn(),
      syncChrome,
      refreshCreditsBalance,
    });
    view["installWorkspaceBindings"]();
    const listener = on.mock.calls.find(([event]) => event === "systemsculpt:settings-updated")![1];
    const settings = view.plugin.settings;
    for (const key of ["defaultChatTag", "lastValidated", "lastAutomaticBackup", "embeddingsExclusions", "pendingAudioProcessorUploads"]) {
      listener(settings, settings, [key]);
    }
    expect(syncChrome).not.toHaveBeenCalled();
    expect(refreshCreditsBalance).not.toHaveBeenCalled();
    listener(settings, { ...settings, codexModel: "other" }, ["codexModel"]);
    expect(syncChrome).toHaveBeenCalledTimes(1);
    expect(refreshCreditsBalance).not.toHaveBeenCalled();
    listener(settings, { ...settings, licenseKey: "new-account" }, ["licenseKey"]);
    expect(refreshCreditsBalance).toHaveBeenCalledTimes(1);
    listener(settings, { ...settings, licenseKey: "" }, ["licenseKey"]);
    expect(refreshCreditsBalance).toHaveBeenCalledTimes(2);
    listener(settings, { ...settings, licenseKey: ` ${settings.licenseKey} ` }, ["licenseKey"]);
    expect(refreshCreditsBalance).toHaveBeenCalledTimes(2);
  });

  it("reads the shared cached balance for view-open and settings refreshes", async () => {
    const readCreditsBalance = mockReadCreditsBalance(async () => balance);
    const { view } = createView(readCreditsBalance);

    await view.refreshCreditsBalance({ reason: "view_open" });
    await view.refreshCreditsBalance({ reason: "settings_update" });

    expect(readCreditsBalance.mock.calls.map(([options]) => options?.fresh)).toEqual([false, false]);
  });

  it.each([false, true, undefined])("offers plans only for explicit non-entitlement (%s)", async (includedCreditsEntitled) => {
    const { view, workspace } = createView(mockReadCreditsBalance(async () => ({ ...balance, includedCreditsEntitled })));
    await view.refreshCreditsBalance({ reason: "view_open" });
    expect(workspace.setPlanOfferVisible).toHaveBeenLastCalledWith(includedCreditsEntitled === false);
  });

  it("clears the previous account's offer when the license changes", async () => {
    const read = mockReadCreditsBalance().mockResolvedValueOnce({ ...balance, includedCreditsEntitled: false });
    const { view, workspace } = createView(read);
    await view.refreshCreditsBalance();
    expect(workspace.setPlanOfferVisible).toHaveBeenLastCalledWith(true);
    view.plugin.settings.licenseKey = "paid-license";
    read.mockResolvedValueOnce({ ...balance, includedCreditsEntitled: true });
    const pending = view.refreshCreditsBalance();
    expect(workspace.setPlanOfferVisible).toHaveBeenLastCalledWith(false);
    await pending;
    expect(workspace.setPlanOfferVisible).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true, undefined])("presents a billing banner for entitlement %s", async (includedCreditsEntitled) => {
    const { view, workspace } = createView(mockReadCreditsBalance(async () => balance));
    view.creditsBalance = { ...balance, includedCreditsEntitled };
    view.refreshCreditsBalance = jest.fn(async () => undefined);
    await view.handleError({ code: "out_of_credits", message: "private server detail" });
    if (includedCreditsEntitled === false) {
      expect(workspace.setBanner).toHaveBeenCalledWith(
        "Monthly is $9 and includes 10,000 credits every month. You can also add a credit pack.", "error", true,
      );
    } else {
      expect(workspace.setBanner).toHaveBeenCalledWith("You have no credits left. Add credits to continue using Chat.", "error");
    }
  });

  it("reads fresh after a billed turn or a billing failure", async () => {
    const readCreditsBalance = mockReadCreditsBalance(async () => balance);
    const { view } = createView(readCreditsBalance);

    await view.refreshCreditsBalance({ requireFresh: true, reason: "post_terminal" });
    await view.refreshCreditsBalance({ reason: "billing_failure" });

    expect(readCreditsBalance.mock.calls.map(([options]) => options?.fresh)).toEqual([true, true]);
  });
});
