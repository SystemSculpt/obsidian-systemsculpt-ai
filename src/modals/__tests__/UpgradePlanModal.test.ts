import { JSDOM } from "jsdom";
import { UpgradePlanModal, hasActivePlan, requireActivePlan } from "../UpgradePlanModal";
import { PLAN_REQUIRED_MESSAGE } from "../../utils/errors";
import { hasHostCapability } from "../../platform/hostCapabilities";
import { preferredLocalAgent } from "../../services/codex/LocalAgentLaunch";

jest.mock("../../platform/hostCapabilities", () => ({
  ...jest.requireActual("../../platform/hostCapabilities"),
  hasHostCapability: jest.fn(() => true),
}));
jest.mock("../../services/codex/LocalAgentLaunch", () => ({ preferredLocalAgent: jest.fn(async () => "claude") }));

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
    UpgradePlanModal.closeCurrent();
    document.body.innerHTML = "";
    jest.clearAllMocks();
  });

  it("leads a signed-out vault with free starter credits and sign-up", async () => {
    const plugin = createPlugin();
    const modal = new UpgradePlanModal(plugin, { feature: "Chat" });
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("Unlock SystemSculpt AI");
    expect(modal.modalEl.textContent).toContain("Create a free SystemSculpt account to get 500 starter credits. No card needed.");
    expect(findButtonByText(modal.modalEl, "Sign in")).toBeTruthy();
    const start = modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="upgrade-plan.create-account"]')!;
    expect(start.textContent).toContain("Start free");
    expect(start.classList.contains("ss-button--primary")).toBe(true);
    start.click();
    await flushPromises();
    expect(plugin.begin).toHaveBeenCalledWith("sign-up", expect.anything());
    modal.onClose();
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

  it("offers lifetime and monthly purchases to a signed-in account without a plan", () => {
    const plugin = createPlugin({ userEmail: "user@example.com" });
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("Signed in as user@example.com.");
    expect(modal.modalEl.textContent).toContain("Create a free account for 500 starter credits, or choose a plan.");
    expect(findButtonByText(modal.modalEl, "Get lifetime license")).toBeTruthy();
    expect(findButtonByText(modal.modalEl, "Subscribe monthly")).toBeTruthy();
    modal.onClose();
  });

  it("opens checkout with attribution and guides back to license sync after purchase", () => {
    const { hrefs, spy } = spyOnAnchorClicks();
    const plugin = createPlugin({ userEmail: "user@example.com" });
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    findButtonByText(modal.modalEl, "Get lifetime license").click();

    expect(hrefs).toEqual([
      "https://systemsculpt.com/lifetime?utm_source=obsidian-plugin&utm_medium=modal&utm_campaign=upgrade",
    ]);
    expect(modal.modalEl.textContent).toContain("Finish your purchase in the browser");
    expect(findButtonByText(modal.modalEl, "I've purchased — Sync license")).toBeTruthy();
    spy.mockRestore();
    modal.onClose();
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
    expect(modal.modalEl.textContent).toContain("finishes automatically");
    const codeInput = modal.modalEl.querySelector<HTMLInputElement>("[data-testid='upgrade-plan.code']");
    expect(codeInput).not.toBeNull();

    codeInput!.value = "  code-123  ";
    findButtonByText(modal.modalEl, "Complete sign-in").click();
    await flushPromises();

    expect(plugin.submitManualCode).toHaveBeenCalledWith("code-123");
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

  it("keeps sign-in polling when the modal closes for a completed sign-in or a pasted code", async () => {
    const plugin = createPlugin();
    const completed = UpgradePlanModal.openOnce(plugin);
    findButtonByText(completed.modalEl, "Sign in").click();
    await flushPromises();
    UpgradePlanModal.closeCurrent();
    completed.onClose();

    const pasted = new UpgradePlanModal(plugin);
    pasted.onOpen();
    findButtonByText(pasted.modalEl, "Sign in").click();
    await flushPromises();
    const codeInput = pasted.modalEl.querySelector<HTMLInputElement>("[data-testid='upgrade-plan.code']");
    codeInput!.value = "code-123";
    findButtonByText(pasted.modalEl, "Complete sign-in").click();
    await flushPromises();
    pasted.onClose();

    expect(plugin.pollInBackground).not.toHaveBeenCalled();
  });

  it("leads onboarding with Start free and retains sign-in, explore, and plans", async () => {
    const { hrefs, spy } = spyOnAnchorClicks();
    const plugin = createPlugin();
    const modal = new UpgradePlanModal(plugin, { context: "onboarding" });
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("Welcome to SystemSculpt AI");
    expect(modal.modalEl.textContent).not.toContain(PLAN_REQUIRED_MESSAGE);
    expect(modal.modalEl.textContent).toContain("Create a free account to get 500 starter credits for hosted AI. No card needed. Paid plans start at $9/month.");
    expect(modal.modalEl.textContent).toContain("Already use Claude Code or Codex? Chat with your vault through your own install. No account needed.");
    const actions = Array.from(modal.footerEl.querySelectorAll<HTMLButtonElement>("button"));
    expect(actions.map((button) => button.textContent)).toEqual(["Start free", "Sign in", "Use my Claude Code or Codex", "Explore on my own"]);
    expect(actions.map((button) => button.dataset.testid)).toEqual([
      "upgrade-plan.create-account",
      "upgrade-plan.sign-in",
      "upgrade-plan.use-local-agent",
      "upgrade-plan.explore",
    ]);
    expect(actions[0].classList.contains("ss-button--primary")).toBe(true);
    expect(actions.slice(1).some((button) => button.classList.contains("ss-button--primary"))).toBe(false);
    findButtonByText(modal.modalEl, "View plans").click();
    expect(new URL(hrefs[0]).pathname).toBe("/pricing");
    expect(new URL(hrefs[0]).searchParams.get("utm_source")).toBe("obsidian-plugin");
    actions[0].click();
    await flushPromises();
    expect(plugin.begin).toHaveBeenCalledWith("sign-up", expect.anything());
    findButtonByText(modal.modalEl, "Back").click();
    const close = jest.spyOn(modal, "close");
    findButtonByText(modal.modalEl, "Explore on my own").click();
    expect(close).toHaveBeenCalled();
    spy.mockRestore();
    modal.onClose();
  });

  it.each(["claude", "codex"] as const)("opens a chat on the user's own %s from the desktop welcome", async (agent) => {
    jest.mocked(preferredLocalAgent).mockResolvedValueOnce(agent);
    const plugin = createPlugin();
    const closeSettings = jest.fn();
    plugin.app.setting = { close: closeSettings };
    const modal = new UpgradePlanModal(plugin, { context: "onboarding" });
    modal.onOpen();
    const close = jest.spyOn(modal, "close");

    modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="upgrade-plan.use-local-agent"]')!.click();
    await flushPromises();

    expect(close).toHaveBeenCalled();
    expect(closeSettings).toHaveBeenCalledTimes(1);
    expect(plugin.updateSettings).toHaveBeenCalledWith({ textExecutionBackend: agent });
    expect(plugin.openNewChat).toHaveBeenCalledTimes(1);
    expect(plugin.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(plugin.openNewChat.mock.invocationCallOrder[0]);
    expect(plugin.begin).not.toHaveBeenCalled();
    modal.onClose();
  });

  it("still opens chat when the provider choice cannot be saved", async () => {
    const plugin = createPlugin();
    plugin.updateSettings.mockRejectedValueOnce(new Error("disk full"));
    const modal = new UpgradePlanModal(plugin, { context: "onboarding" });
    modal.onOpen();

    modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="upgrade-plan.use-local-agent"]')!.click();
    await flushPromises();

    expect(plugin.openNewChat).toHaveBeenCalledTimes(1);
    modal.onClose();
  });

  it("keeps the mobile welcome on the account path", () => {
    jest.mocked(hasHostCapability).mockReturnValue(false);
    try {
      const plugin = createPlugin();
      const modal = new UpgradePlanModal(plugin, { context: "onboarding" });
      modal.onOpen();

      expect(modal.modalEl.textContent).not.toContain("Claude Code");
      expect(Array.from(modal.footerEl.querySelectorAll("button")).map((button) => button.textContent))
        .toEqual(["Start free", "Sign in", "Explore on my own"]);
      expect(modal.modalEl.querySelector('[data-testid="upgrade-plan.use-local-agent"]')).toBeNull();
      modal.onClose();
    } finally {
      jest.mocked(hasHostCapability).mockReturnValue(true);
    }
  });

  it("does not offer on-machine agents outside the welcome", () => {
    const plugin = createPlugin();
    const modal = new UpgradePlanModal(plugin, { feature: "Chat" });
    modal.onOpen();
    expect(modal.modalEl.querySelector('[data-testid="upgrade-plan.use-local-agent"]')).toBeNull();
    expect(modal.modalEl.textContent).not.toContain("Claude Code");
    modal.onClose();
  });

  it("opens at most one instance at a time via openOnce", () => {
    const plugin = createPlugin();
    const first = UpgradePlanModal.openOnce(plugin);
    const second = UpgradePlanModal.openOnce(plugin);
    expect(second).toBe(first);
    UpgradePlanModal.closeCurrent();
    const third = UpgradePlanModal.openOnce(plugin);
    expect(third).not.toBe(first);
  });
});

describe("plan gate helpers", () => {
  afterEach(() => {
    UpgradePlanModal.closeCurrent();
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
    expect(document.body.textContent).toContain("Unlock SystemSculpt AI");
    UpgradePlanModal.closeCurrent();

    expect(requireActivePlan(createPlugin({ licenseKey: "skss-1" }), "Chat")).toBe(true);
  });
});
