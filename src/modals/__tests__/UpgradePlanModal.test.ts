import { JSDOM } from "jsdom";
import { Notice, requireApiVersion } from "obsidian";
import { UpgradePlanModal, hasActivePlan, presentAccountConnectOutcome, requireActivePlan } from "../UpgradePlanModal";

jest.mock("../../platform/hostCapabilities", () => ({
  ...jest.requireActual("../../platform/hostCapabilities"),
  hasHostCapability: jest.fn(() => true),
}));
jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  Notice: jest.fn(),
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

const ensureDomHelpers = () => {
  const proto = (global as any).window.HTMLElement?.prototype;
  if (!proto) return;
  if (!proto.addClass) {
    proto.addClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
        });
      return this;
    };
  }
  if (!proto.removeClass) {
    proto.removeClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`.split(/\s+/).filter(Boolean).forEach((c) => this.classList.remove(c));
        });
      return this;
    };
  }
  if (!proto.setText) {
    proto.setText = function (text: string) {
      this.textContent = text ?? "";
      return this;
    };
  }
  if (!proto.setAttr) {
    proto.setAttr = function (name: string, value: any) {
      if (value === null || value === undefined || value === false) {
        this.removeAttribute(name);
      } else if (value === true) {
        this.setAttribute(name, "");
      } else {
        this.setAttribute(name, `${value}`);
      }
      return this;
    };
  }
  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
      return this;
    };
  }
  if (!proto.createEl) {
    proto.createEl = function (tag: string, options?: any) {
      const normalized = typeof options === "string" ? { cls: options } : options ?? {};
      const el = (this.ownerDocument ?? document).createElement(tag);
      if (normalized.cls) {
        `${normalized.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
      }
      if (normalized.text !== undefined) {
        el.textContent = `${normalized.text}`;
      }
      if (normalized.attr) {
        Object.entries(normalized.attr).forEach(([key, value]) => {
          (el as any).setAttr?.(key, value);
        });
      }
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.createDiv) {
    proto.createDiv = function (options?: any) {
      return this.createEl("div", options);
    };
  }
  if (!proto.createSpan) {
    proto.createSpan = function (options?: any) {
      return this.createEl("span", options);
    };
  }
};

ensureDomHelpers();

const flushPromises = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Closes whichever instance is open, as the host would on navigation. */
const closeOpenModal = (): void => {
  (UpgradePlanModal as unknown as { current: UpgradePlanModal | null }).current?.close();
};

const findButtonByText = (root: HTMLElement, text: string): HTMLButtonElement => {
  const button = Array.from(root.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button as HTMLButtonElement;
};

function createPlugin(settings: Record<string, unknown> = {}) {
  const begin = jest.fn().mockResolvedValue(true);
  const reopen = jest.fn().mockResolvedValue(true);
  const submitManualCode = jest.fn().mockResolvedValue({ kind: "error", reason: "expired" });
  const pollInBackground = jest.fn();
  const hasPendingRequest = jest.fn(() => true);
  const updateSettings = jest.fn().mockResolvedValue(undefined);
  return {
    app: {},
    settings: { licenseKey: "", licenseValid: false, userEmail: "", ...settings },
    getAccountConnectService: () => ({ begin, reopen, submitManualCode, pollInBackground, hasPendingRequest }),
    getSettingsManager: () => ({ updateSettings }),
    openNewChat: jest.fn(),
    startHostedChat: jest.fn().mockResolvedValue(undefined),
    readyPrompt: jest.fn((): string | null => null),
    openSettingsTab: jest.fn(),
    begin,
    reopen,
    submitManualCode,
    pollInBackground,
    hasPendingRequest,
    updateSettings,
  } as any;
}

/** Captures external opens: the no-Electron path clicks a synthetic anchor. */
function spyOnAnchorClicks() {
  const hrefs: string[] = [];
  const spy = jest
    .spyOn((window as any).HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.getAttribute("href") ?? "");
    });
  return { hrefs, spy };
}

describe("UpgradePlanModal", () => {
  afterEach(() => {
    closeOpenModal();
    document.body.innerHTML = "";
    jest.clearAllMocks();
  });

  it.each([{}, { userEmail: "user@example.test" }, { userEmail: "user@example.test", licenseKey: "lapsed-key" }])(
    "keeps Patreon support external, attributed and separate from plan activation: %j",
    (settings) => {
      const plugin = createPlugin(settings);
      const before = { ...plugin.settings };
      const modal = new UpgradePlanModal(plugin);
      modal.onOpen();
      const { hrefs, spy } = spyOnAnchorClicks();
      try {
        const link = modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="upgrade-plan.patreon"]')!;
        expect(link.textContent).toBe("Support us on Patreon");
        link.click();
        expect(hrefs).toEqual([
          "https://www.patreon.com/SystemSculpt?utm_source=plugin_upgrade_modal&utm_campaign=patreon_everywhere",
        ]);
        expect(plugin.settings).toEqual(before);
        expect(plugin.begin).not.toHaveBeenCalled();
        expect(plugin.updateSettings).not.toHaveBeenCalled();
        expect(modal.modalEl.textContent).not.toContain("Finish your purchase");
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("leads a signed-out vault with free own AI and the Pro feature set", async () => {
    const plugin = createPlugin();
    const modal = new UpgradePlanModal(plugin, { feature: "Chat" });
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("SystemSculpt\u00a0Pro: AI images and video in your vault");
    expect(modal.modalEl.textContent).toContain("Plus smart search and Studio. $9 a month.");
    expect(modal.modalEl.textContent).toContain("Claude Code and Codex stay free on desktop.");
    expect(findButtonByText(modal.modalEl, "Sign in")).toBeTruthy();
    const start = modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="upgrade-plan.create-account"]')!;
    expect(start.textContent).toContain("Start free");
    expect(start.classList.contains("ss-button--primary")).toBe(true);
    start.click();
    await flushPromises();
    expect(plugin.begin).toHaveBeenCalledWith("sign-up", expect.anything());
    modal.onClose();
  });

  it("shows a vault's copy-test arm and tags the links it opens with that arm (T-5852)", async () => {
    const plugin = createPlugin({ userEmail: "user@example.com" });
    const store: Record<string, unknown> = { "systemsculpt-experiment-unit": "0123456789abcdef" };
    plugin.app = { loadLocalStorage: (key: string) => store[key] ?? null, saveLocalStorage: jest.fn() };
    const hostVersionCheck = jest.mocked(requireApiVersion).getMockImplementation()!;
    jest.mocked(requireApiVersion).mockImplementation(() => true);
    const { hrefs, spy } = spyOnAnchorClicks();
    try {
      const modal = new UpgradePlanModal(plugin);
      modal.onOpen();
      expect(modal.modalEl.textContent).toContain("Get SystemSculpt\u00a0Pro, AI for your vault");
      expect(modal.modalEl.textContent).toContain("Image and video generation, smart search and Studio for $9 a month.");
      expect(modal.modalEl.textContent).not.toContain("SystemSculpt\u00a0Pro: AI images and video in your vault");
      findButtonByText(modal.modalEl, "Compare plans").click();
      findButtonByText(modal.modalEl, "Subscribe yearly").click();
      const tags = hrefs.map((href) => {
        const url = new URL(href);
        return [url.pathname, url.searchParams.get("utm_campaign"), url.searchParams.get("utm_content")];
      });
      expect(tags).toEqual([
        ["/pricing", "ss-plugin-upgrade-pro-2026-11", "b"],
        ["/checkout", "ss-plugin-upgrade-pro-2026-11", "b"],
      ]);
      findButtonByText(modal.modalEl, "Back").click();
      findButtonByText(modal.modalEl, "Already paid? Sync").click();
      await flushPromises();
      expect(plugin.begin).toHaveBeenCalledWith("sign-in", expect.anything(), { experiment: "ss-plugin-upgrade-pro-2026-11", variant: "b" });
      modal.onClose();
    } finally {
      spy.mockRestore();
      jest.mocked(requireApiVersion).mockImplementation(hostVersionCheck);
    }
  });

  it("opens Account settings for an existing license key", () => {
    const plugin = createPlugin();
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();
    const close = jest.spyOn(modal, "close");

    findButtonByText(modal.modalEl, "I have a license key").click();

    expect(close).toHaveBeenCalled();
    expect(plugin.openSettingsTab).toHaveBeenCalledWith("account");
  });

  it("offers yearly and monthly purchases to a signed-in account without a plan", () => {
    const plugin = createPlugin({ userEmail: "user@example.com" });
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("Signed in as user@example.com.");
    expect(modal.modalEl.textContent).toContain("Plus smart search and Studio. $9 a month.");
    expect(modal.modalEl.textContent).toContain("Claude Code and Codex stay free on desktop.");
    expect(findButtonByText(modal.modalEl, "Subscribe yearly")).toBeTruthy();
    expect(findButtonByText(modal.modalEl, "Subscribe monthly")).toBeTruthy();
    modal.onClose();
  });

  it("opens checkout with attribution and guides back to license sync after purchase", () => {
    const { hrefs, spy } = spyOnAnchorClicks();
    const plugin = createPlugin({ userEmail: "user@example.com" });
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    findButtonByText(modal.modalEl, "Subscribe yearly").click();

    expect(hrefs).toEqual([
      "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8&ref=plugin_modal_annual&utm_source=obsidian-plugin&utm_medium=modal&utm_campaign=upgrade",
    ]);
    expect(modal.modalEl.textContent).toContain("Finish your purchase in the browser");
    expect(findButtonByText(modal.modalEl, "I've purchased — Sync license")).toBeTruthy();
    spy.mockRestore();
    modal.onClose();
  });

  it("opens monthly checkout and starts license sync rather than granting access after purchase", async () => {
    const { hrefs, spy } = spyOnAnchorClicks();
    try {
      const plugin = createPlugin({ userEmail: "user@example.com", licenseKey: "expired-key" });
      const modal = new UpgradePlanModal(plugin);
      modal.onOpen();
      expect(modal.modalEl.textContent).toContain("Your license isn't active.");
      findButtonByText(modal.modalEl, "Subscribe monthly").click();
      const checkout = new URL(hrefs[0]);
      expect(checkout.origin).toBe("https://systemsculpt.com");
      expect(checkout.pathname).toBe("/subscribe");
      expect(checkout.searchParams.get("ref")).toBe("plugin_modal_monthly");
      expect(checkout.searchParams.get("utm_source")).toBe("obsidian-plugin");
      expect(checkout.searchParams.get("utm_medium")).toBe("modal");
      expect(plugin.updateSettings).not.toHaveBeenCalled();
      findButtonByText(modal.modalEl, "I've purchased — Sync license").click();
      await flushPromises();
      expect(plugin.begin).toHaveBeenCalledWith("sign-in", expect.anything());
      expect(plugin.updateSettings).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("leads a rejected key with Billing, where a failed card is fixed (T-5348)", () => {
    const { hrefs, spy } = spyOnAnchorClicks();
    try {
      const modal = new UpgradePlanModal(createPlugin({ userEmail: "user@example.com", licenseKey: "expired-key" }));
      modal.onOpen();
      expect(modal.modalEl.textContent).toContain("If a payment failed, update your card in Billing");
      findButtonByText(modal.modalEl, "Open billing").click();
      expect(new URL(hrefs[0]).pathname).toBe("/dashboard/billing");
    } finally {
      spy.mockRestore();
    }
  });

  it("shows no Billing button to an account without a key", () => {
    const modal = new UpgradePlanModal(createPlugin({ userEmail: "user@example.com" }));
    modal.onOpen();
    expect(modal.modalEl.textContent).not.toContain("Open billing");
  });

  it.each([{}, { userEmail: "account@example.com" }])("opens comparison pricing without changing access (%j)", (settings) => {
    const { hrefs, spy } = spyOnAnchorClicks();
    try {
      const plugin = createPlugin(settings);
      const modal = new UpgradePlanModal(plugin);
      modal.onOpen();
      findButtonByText(modal.modalEl, "Compare plans").click();
      const url = new URL(hrefs[0]);
      expect(url.origin).toBe("https://systemsculpt.com");
      expect(url.pathname).toBe("/pricing");
      expect(plugin.updateSettings).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("switches to the browser handoff with a manual connection-code fallback", async () => {
    const plugin = createPlugin();
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    findButtonByText(modal.modalEl, "Sign in").click();
    await flushPromises();

    expect(plugin.begin).toHaveBeenCalledWith("sign-in", expect.anything());
    expect(modal.modalEl.textContent).toContain("Continue in your browser");
    expect(modal.modalEl.textContent).toContain("Waiting for you to finish in the browser");
    expect(modal.modalEl.textContent).toContain("Paste the code from your browser");
    const codeInput = modal.modalEl.querySelector<HTMLInputElement>("[data-testid='upgrade-plan.code']");
    expect(codeInput).not.toBeNull();

    codeInput!.value = "  code-123  ";
    findButtonByText(modal.modalEl, "Complete sign-in").click();
    await flushPromises();

    expect(plugin.submitManualCode).toHaveBeenCalledWith("code-123");
  });

  it("opens straight into the same sign-up handoff for the chat's Start free", async () => {
    const plugin = createPlugin();
    const modal = UpgradePlanModal.openConnect(plugin, "sign-up", { feature: "Chat" });
    await flushPromises();
    expect(plugin.begin).toHaveBeenCalledWith("sign-up", expect.anything());
    expect(modal.modalEl.textContent).toContain("Create your free account.");
    // A second press while the handoff is open reuses it.
    expect(UpgradePlanModal.openConnect(plugin, "sign-in")).toBe(modal);
  });

  it("lets the user reopen the sign-in page from the browser handoff", async () => {
    const plugin = createPlugin();
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    findButtonByText(modal.modalEl, "Sign in").click();
    await flushPromises();
    expect(plugin.begin).toHaveBeenCalledTimes(1);

    const reopenLink = modal.modalEl.querySelector<HTMLButtonElement>(
      "[data-testid='upgrade-plan.reopen']",
    );
    expect(reopenLink).not.toBeNull();

    reopenLink!.click();
    await flushPromises();
    expect(plugin.reopen).toHaveBeenCalledTimes(1);
    expect(plugin.begin).toHaveBeenCalledTimes(1);

    plugin.reopen.mockResolvedValue(false);
    reopenLink!.click();
    await flushPromises();
    expect(plugin.begin).toHaveBeenCalledTimes(1);

    plugin.hasPendingRequest.mockReturnValue(false);
    reopenLink!.click();
    await flushPromises();
    expect(plugin.begin).toHaveBeenCalledTimes(2);
    expect(plugin.begin).toHaveBeenLastCalledWith("sign-in", expect.anything());
    modal.onClose();
  });

  it("shows the manual path when the browser could not be opened", async () => {
    const plugin = createPlugin();
    plugin.begin.mockResolvedValue(false);
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    findButtonByText(modal.modalEl, "Sign in").click();
    await flushPromises();

    expect(modal.modalEl.textContent).toContain("Couldn't open your browser.");
    modal.onClose();
  });

  it("stops sign-in polling when the user leaves the browser handoff", async () => {
    const plugin = createPlugin();
    const dismissed = new UpgradePlanModal(plugin);
    dismissed.onOpen();
    findButtonByText(dismissed.modalEl, "Sign in").click();
    await flushPromises();
    dismissed.onClose();
    expect(plugin.pollInBackground).toHaveBeenCalledTimes(1);

    const backedOut = new UpgradePlanModal(plugin);
    backedOut.onOpen();
    findButtonByText(backedOut.modalEl, "Sign in").click();
    await flushPromises();
    findButtonByText(backedOut.modalEl, "Back").click();
    expect(plugin.pollInBackground).toHaveBeenCalledTimes(2);
    backedOut.onClose();
    expect(plugin.pollInBackground).toHaveBeenCalledTimes(2);
  });

  it("shows a completed sign-in in place, once, and leaves without backgrounding it", async () => {
    const plugin = createPlugin();
    const modal = UpgradePlanModal.openOnce(plugin, { feature: "Chat" });
    findButtonByText(modal.modalEl, "Sign in").click();
    await flushPromises();
    plugin.hasPendingRequest.mockReturnValue(false);

    expect(UpgradePlanModal.showConnectOutcome({
      kind: "signed-in", name: "Test User", email: "user@example.test", licenseValid: true,
    })).toBe(true);

    expect(document.querySelectorAll(".ss-upgrade-plan-modal")).toHaveLength(1);
    expect(modal.modalEl.textContent).toContain("You're in");
    expect(modal.modalEl.textContent).toContain("Signed in as user@example.test.");
    expect(modal.modalEl.textContent).not.toContain("credits ready");
    expect(modal.modalEl.textContent).not.toContain("license is being confirmed");
    expect(Array.from(modal["footerEl"].querySelectorAll("button")).map((button) => button.textContent))
      .toEqual(["Start a chat", "Done"]);
    findButtonByText(modal.modalEl, "Done").click();
    modal.onClose();
    expect(plugin.pollInBackground).not.toHaveBeenCalled();
    expect(plugin.startHostedChat).not.toHaveBeenCalled();
  });

  it("goes from a starter sign-in straight to a hosted chat", () => {
    const plugin = createPlugin();
    const modal = UpgradePlanModal.openOnce(plugin);
    UpgradePlanModal.showConnectOutcome({
      kind: "signed-in", name: null, email: "user@example.test", licenseValid: true, starterCredits: 500,
    });
    expect(modal.modalEl.textContent).toContain("You're in");
    expect(modal.modalEl.textContent).toContain("500 credits ready.");
    expect(modal.modalEl.textContent).not.toContain("Signed in as");
    // One tight block: the check leads the title and no empty body band remains.
    expect(modal["headerEl"].querySelector(".ss-modal__title-container > .ss-upgrade-plan__title-icon + .ss-modal__title"))
      .not.toBeNull();
    expect(modal.contentEl.childElementCount).toBe(0);
    expect(modal.modalEl.classList.contains("is-compact")).toBe(true);
    findButtonByText(modal.modalEl, "Start a chat").click();
    expect(plugin.startHostedChat).toHaveBeenCalledTimes(1);
    expect(plugin.startHostedChat).toHaveBeenCalledWith({});
    expect(document.querySelector(".ss-upgrade-plan-modal")).toBeNull();
  });

  it("runs the ready prompt on the latest note in one tap after sign-in (T-5302)", () => {
    const plugin = createPlugin();
    plugin.readyPrompt.mockReturnValue("Summarize [[Trip plan]]");
    const modal = UpgradePlanModal.openOnce(plugin);
    UpgradePlanModal.showConnectOutcome({
      kind: "signed-in", name: null, email: "user@example.test", licenseValid: true, starterCredits: 500,
    });
    expect(Array.from(modal["footerEl"].querySelectorAll("button")).map((button) => button.textContent))
      .toEqual(["Summarize my latest note", "Done"]);
    findButtonByText(modal.modalEl, "Summarize my latest note").click();
    expect(plugin.startHostedChat).toHaveBeenCalledWith({ prompt: "Summarize [[Trip plan]]" });
    expect(document.querySelector(".ss-upgrade-plan-modal")).toBeNull();
  });

  it("keeps account and license validation apart in the signed-in result", async () => {
    const plugin = createPlugin();
    const modal = UpgradePlanModal.openOnce(plugin);
    UpgradePlanModal.showConnectOutcome({ kind: "signed-in", name: null, email: null, licenseValid: false });
    expect(modal.modalEl.textContent).toContain("You're signed in");
    expect(modal.modalEl.textContent).toContain("Signed in to SystemSculpt.");
    expect(modal.modalEl.textContent).toContain("Confirming your license…");
    expect(Array.from(modal["footerEl"].querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Done"]);
    modal.onClose();
  });

  it("continues a plan-less account to the plan choice in the same modal", async () => {
    const plugin = createPlugin();
    const modal = UpgradePlanModal.openOnce(plugin, { feature: "Chat" });
    findButtonByText(modal.modalEl, "Sign in").click();
    await flushPromises();
    plugin.settings.userEmail = "user@example.test";
    plugin.hasPendingRequest.mockReturnValue(false);

    UpgradePlanModal.showConnectOutcome({ kind: "no-license", name: null, email: "user@example.test" });

    expect(modal.modalEl.textContent).toContain("Signed in as user@example.test.");
    expect(modal.modalEl.textContent).toContain("Plus smart search and Studio. $9 a month.");
    expect(modal.modalEl.textContent).toContain("Claude Code and Codex stay free on desktop.");
    expect(findButtonByText(modal.modalEl, "Subscribe yearly")).toBeTruthy();
    modal.onClose();
    expect(plugin.pollInBackground).not.toHaveBeenCalled();
  });

  it("shows a failed save as a failure with a fresh sign-in, never a success", async () => {
    const plugin = createPlugin();
    const modal = UpgradePlanModal.openOnce(plugin);
    findButtonByText(modal.modalEl, "Start free").click();
    await flushPromises();
    plugin.hasPendingRequest.mockReturnValue(false);

    UpgradePlanModal.showConnectOutcome({ kind: "error", reason: "unavailable" });

    expect(modal.modalEl.textContent).toContain("Sign-in didn't finish");
    expect(modal.modalEl.textContent).toContain("Sign-in is down. Try again soon.");
    expect(modal.modalEl.textContent).not.toContain("signed in");
    findButtonByText(modal.modalEl, "Start sign-in again").click();
    await flushPromises();
    expect(plugin.begin).toHaveBeenLastCalledWith("sign-up", expect.anything());
    expect(modal.modalEl.textContent).toContain("Waiting for you to finish in the browser");
    modal.onClose();
  });

  it("lets a code that could not reach SystemSculpt be entered again for the same sign-in", async () => {
    const plugin = createPlugin();
    const modal = UpgradePlanModal.openOnce(plugin);
    findButtonByText(modal.modalEl, "Sign in").click();
    await flushPromises();

    UpgradePlanModal.showConnectOutcome({ kind: "error", reason: "network" });
    expect(modal.modalEl.textContent).toContain("Can't reach SystemSculpt.");
    findButtonByText(modal.modalEl, "Enter the code again").click();
    expect(modal.modalEl.querySelector("[data-testid='upgrade-plan.code']")).not.toBeNull();
    expect(plugin.begin).toHaveBeenCalledTimes(1);

    // Leaving the still-open sign-in backgrounds it, as leaving the handoff does.
    UpgradePlanModal.showConnectOutcome({ kind: "error", reason: "network" });
    modal.onClose();
    expect(plugin.pollInBackground).toHaveBeenCalledTimes(1);
  });

  it("exchanges a pasted code in place and waits for its result", async () => {
    const plugin = createPlugin();
    const modal = UpgradePlanModal.openOnce(plugin);
    findButtonByText(modal.modalEl, "Sign in").click();
    await flushPromises();
    const codeInput = modal.modalEl.querySelector<HTMLInputElement>("[data-testid='upgrade-plan.code']");
    codeInput!.value = "  code-123  ";
    findButtonByText(modal.modalEl, "Complete sign-in").click();
    await flushPromises();

    expect(plugin.submitManualCode).toHaveBeenCalledWith("code-123");
    expect(document.querySelectorAll(".ss-upgrade-plan-modal")).toHaveLength(1);
    expect(modal.modalEl.textContent).toContain("Signing you in…");
    modal.onClose();
  });

  it("presents each outcome in exactly one place: the modal, else Account settings, else a notice", () => {
    const outcome = { kind: "signed-in", name: null, email: "user@example.test", licenseValid: true } as const;
    const plugin = createPlugin();
    const showAccountConnectOutcome = jest.fn(() => true);
    plugin.settingsTab = { showAccountConnectOutcome };
    jest.spyOn(document, "hasFocus").mockReturnValue(true);

    const modal = UpgradePlanModal.openOnce(plugin);
    presentAccountConnectOutcome(plugin, outcome);
    expect(modal.modalEl.textContent).toContain("Signed in as user@example.test.");
    expect(showAccountConnectOutcome).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    modal.close();

    presentAccountConnectOutcome(plugin, outcome);
    expect(showAccountConnectOutcome).toHaveBeenCalledWith(outcome);
    expect(Notice).not.toHaveBeenCalled();

    showAccountConnectOutcome.mockReturnValue(false);
    presentAccountConnectOutcome(plugin, { kind: "error", reason: "expired" });
    presentAccountConnectOutcome(plugin, { kind: "no-license", name: null, email: "user@example.test" });
    expect(Notice).toHaveBeenNthCalledWith(1,
      "Sign-in expired. Try again.", 10_000);
    expect(Notice).toHaveBeenNthCalledWith(2,
      "Signed in to SystemSculpt as user@example.test. No active plan. Choose one to start.", 6_000);
    expect(document.querySelector(".ss-upgrade-plan-modal")).toBeNull();
    jest.restoreAllMocks();
  });

  it("keeps the result notice up while the person is away from Obsidian, then times it from their return", () => {
    jest.useFakeTimers();
    const hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(false);
    const setTimeoutSpy = jest.spyOn(window, "setTimeout").mockImplementation(((callback: () => void, ms: number) =>
      setTimeout(callback, ms)) as never);
    const hide = jest.fn();
    (Notice as unknown as jest.Mock).mockImplementationOnce(() => ({ hide }));
    try {
      presentAccountConnectOutcome(createPlugin(), { kind: "signed-in", name: null, email: "user@example.test", licenseValid: true });
      const [fragment, duration] = (Notice as unknown as jest.Mock).mock.calls[0] as [DocumentFragment, number];
      expect(fragment.textContent).toContain("Signed in to SystemSculpt as user@example.test.");
      expect(fragment.querySelector('[data-testid="notice.action"]')?.textContent).toBe("Start a chat");
      expect(duration).toBe(0);

      jest.advanceTimersByTime(60_000);
      expect(hide).not.toHaveBeenCalled();

      window.dispatchEvent(new window.Event("focus"));
      jest.advanceTimersByTime(9_999);
      expect(hide).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(hide).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      hasFocus.mockRestore();
      jest.useRealTimers();
    }
  });

  it("keeps an error notice until the person returns to Obsidian", () => {
    jest.useFakeTimers();
    const hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(false);
    const setTimeoutSpy = jest.spyOn(window, "setTimeout").mockImplementation(((callback: () => void, ms: number) =>
      setTimeout(callback, ms)) as never);
    const hide = jest.fn();
    (Notice as unknown as jest.Mock).mockImplementationOnce(() => ({ hide }));
    try {
      presentAccountConnectOutcome(createPlugin(), { kind: "error", reason: "expired" });
      expect(Notice).toHaveBeenCalledWith("Sign-in expired. Try again.", 0);
      jest.advanceTimersByTime(60_000);
      expect(hide).not.toHaveBeenCalled();
      window.dispatchEvent(new window.Event("focus"));
      jest.advanceTimersByTime(10_000);
      expect(hide).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      hasFocus.mockRestore();
      jest.useRealTimers();
    }
  });

  it("offers Start a chat in the notice when no account surface is open", () => {
    jest.spyOn(document, "hasFocus").mockReturnValue(true);
    const plugin = createPlugin();
    plugin.settingsTab = { showAccountConnectOutcome: jest.fn(() => false) };
    (Notice as unknown as jest.Mock).mockImplementationOnce(() => ({ hide: jest.fn() }));
    presentAccountConnectOutcome(plugin, {
      kind: "signed-in", name: null, email: "user@example.test", licenseValid: true, starterCredits: 500,
    });
    const fragment = (Notice as unknown as jest.Mock).mock.calls[0][0] as DocumentFragment;
    expect(fragment.textContent).toContain("Signed in to SystemSculpt as user@example.test. 500 credits ready.");
    const action = fragment.querySelector<HTMLButtonElement>('[data-testid="notice.action"]');
    expect(action?.textContent).toBe("Start a chat");
    action?.click();
    expect(plugin.startHostedChat).toHaveBeenCalledTimes(1);
    expect((Notice as unknown as jest.Mock).mock.calls[0][1]).toBe(10_000);
    jest.restoreAllMocks();
  });

  it("opens at most one instance at a time via openOnce", () => {
    const plugin = createPlugin();
    const first = UpgradePlanModal.openOnce(plugin);
    const second = UpgradePlanModal.openOnce(plugin);
    expect(second).toBe(first);
    closeOpenModal();
    const third = UpgradePlanModal.openOnce(plugin);
    expect(third).not.toBe(first);
  });
});

describe("plan gate helpers", () => {
  afterEach(() => {
    closeOpenModal();
    document.body.innerHTML = "";
  });

  it("hasActivePlan reflects a non-empty license key", () => {
    expect(hasActivePlan(createPlugin())).toBe(false);
    expect(hasActivePlan(createPlugin({ licenseKey: "  " }))).toBe(false);
    expect(hasActivePlan(createPlugin({ licenseKey: "skss-1" }))).toBe(true);
  });

  it("requireActivePlan opens the modal and blocks when no plan is active", () => {
    const plugin = createPlugin();
    expect(requireActivePlan(plugin, "Chat")).toBe(false);
    expect(document.body.textContent).toContain("SystemSculpt\u00a0Pro: AI images and video in your vault");
    closeOpenModal();

    expect(requireActivePlan(createPlugin({ licenseKey: "skss-1" }), "Chat")).toBe(true);
  });
});
