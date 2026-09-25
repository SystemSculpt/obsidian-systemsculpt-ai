/** @jest-environment jsdom */

import { AgentChatView } from "../AgentChatView";

function createView(readCreditsBalance: jest.Mock): AgentChatView & Record<string, any> {
  const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
  Object.assign(view, {
    plugin: { settings: { licenseKey: "test-license" } },
    aiService: { readCreditsBalance },
    workspace: { setCreditsBalance: jest.fn() },
    creditsPromise: null,
    creditsBalance: null,
  });
  return view;
}

describe("AgentChatView shared credits reads", () => {
  const balance = { usageClass: "customer", totalRemaining: 5, availableUnreserved: 5 };

  it("reads the shared cached balance for view-open and settings refreshes", async () => {
    const readCreditsBalance = jest.fn(async () => balance);
    const view = createView(readCreditsBalance);

    await view.refreshCreditsBalance({ reason: "view_open" });
    await view.refreshCreditsBalance({ reason: "settings_update" });

    expect(readCreditsBalance.mock.calls.map(([options]) => options.fresh)).toEqual([false, false]);
  });

  it("reads fresh after a billed turn or a billing failure", async () => {
    const readCreditsBalance = jest.fn(async () => balance);
    const view = createView(readCreditsBalance);

    await view.refreshCreditsBalance({ requireFresh: true, reason: "post_terminal" });
    await view.refreshCreditsBalance({ reason: "billing_failure" });

    expect(readCreditsBalance.mock.calls.map(([options]) => options.fresh)).toEqual([true, true]);
  });
});
