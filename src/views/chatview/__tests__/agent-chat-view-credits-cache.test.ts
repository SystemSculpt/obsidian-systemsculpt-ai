/** @jest-environment jsdom */

import { AgentChatView } from "../AgentChatView";

function createView(readCreditsBalance: jest.Mock): AgentChatView & Record<string, any> {
  const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
  Object.assign(view, {
    plugin: { settings: { licenseKey: "test-license" } },
    aiService: { readCreditsBalance },
    workspace: { setPlanOfferVisible: jest.fn(), setCreditsBalance: jest.fn() },
    creditsPromise: null,
    creditsBalance: null,
  });
  return view;
}

describe("AgentChatView shared credits reads", () => {
  const balance = { usageClass: "customer", totalRemaining: 5, availableUnreserved: 5 };

  it("refreshes credits only for an account-key change and chrome only for its own settings", async () => {
    const view = createView(jest.fn(async () => balance));
    const on = jest.fn();
    Object.assign(view, {
      app: { workspace: { on } },
      registerEvent: jest.fn(),
      syncChrome: jest.fn(),
      refreshCreditsBalance: jest.fn(async () => undefined),
    });
    view.installWorkspaceBindings();
    const listener = on.mock.calls.find(([event]) => event === "systemsculpt:settings-updated")![1];
    const settings = view.plugin.settings;
    for (const key of ["defaultChatTag", "lastValidated", "lastAutomaticBackup", "embeddingsExclusions", "pendingAudioProcessorUploads"]) {
      listener(settings, settings, [key]);
    }
    expect(view.syncChrome).not.toHaveBeenCalled();
    expect(view.refreshCreditsBalance).not.toHaveBeenCalled();
    listener(settings, { ...settings, codexModel: "other" }, ["codexModel"]);
    expect(view.syncChrome).toHaveBeenCalledTimes(1);
    expect(view.refreshCreditsBalance).not.toHaveBeenCalled();
    listener(settings, { ...settings, licenseKey: "new-account" }, ["licenseKey"]);
    expect(view.refreshCreditsBalance).toHaveBeenCalledTimes(1);
    listener(settings, { ...settings, licenseKey: "" }, ["licenseKey"]);
    expect(view.refreshCreditsBalance).toHaveBeenCalledTimes(2);
    listener(settings, { ...settings, licenseKey: ` ${settings.licenseKey} ` }, ["licenseKey"]);
    expect(view.refreshCreditsBalance).toHaveBeenCalledTimes(2);
  });

  it("reads the shared cached balance for view-open and settings refreshes", async () => {
    const readCreditsBalance = jest.fn(async () => balance);
    const view = createView(readCreditsBalance);

    await view.refreshCreditsBalance({ reason: "view_open" });
    await view.refreshCreditsBalance({ reason: "settings_update" });

    expect(readCreditsBalance.mock.calls.map(([options]) => options.fresh)).toEqual([false, false]);
  });

  it.each([false, true, undefined])("offers plans only for explicit non-entitlement (%s)", async (includedCreditsEntitled) => {
    const view = createView(jest.fn(async () => ({ ...balance, includedCreditsEntitled })));
    await view.refreshCreditsBalance({ reason: "view_open" });
    expect(view.workspace.setPlanOfferVisible).toHaveBeenLastCalledWith(includedCreditsEntitled === false);
  });

  it("clears the previous account's offer when the license changes", async () => {
    const read = jest.fn().mockResolvedValueOnce({ ...balance, includedCreditsEntitled: false });
    const view = createView(read);
    await view.refreshCreditsBalance();
    expect(view.workspace.setPlanOfferVisible).toHaveBeenLastCalledWith(true);
    view.plugin.settings.licenseKey = "paid-license";
    read.mockResolvedValueOnce({ ...balance, includedCreditsEntitled: true });
    const pending = view.refreshCreditsBalance();
    expect(view.workspace.setPlanOfferVisible).toHaveBeenLastCalledWith(false);
    await pending;
    expect(view.workspace.setPlanOfferVisible).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true, undefined])("presents a billing banner for entitlement %s", async (includedCreditsEntitled) => {
    const view = createView(jest.fn(async () => balance));
    view.creditsBalance = { ...balance, includedCreditsEntitled } as any;
    view.refreshCreditsBalance = jest.fn(async () => undefined);
    view.workspace.setBanner = jest.fn();
    await view.handleError({ code: "out_of_credits", message: "private server detail" });
    if (includedCreditsEntitled === false) {
      expect(view.workspace.setBanner).toHaveBeenCalledWith(
        "Monthly is $9 and includes 10,000 credits every month. You can also add a credit pack.", "error", true,
      );
    } else {
      expect(view.workspace.setBanner).toHaveBeenCalledWith("You have no credits left. Add credits to continue using Chat.", "error");
    }
  });

  it("reads fresh after a billed turn or a billing failure", async () => {
    const readCreditsBalance = jest.fn(async () => balance);
    const view = createView(readCreditsBalance);

    await view.refreshCreditsBalance({ requireFresh: true, reason: "post_terminal" });
    await view.refreshCreditsBalance({ reason: "billing_failure" });

    expect(readCreditsBalance.mock.calls.map(([options]) => options.fresh)).toEqual([true, true]);
  });
});
