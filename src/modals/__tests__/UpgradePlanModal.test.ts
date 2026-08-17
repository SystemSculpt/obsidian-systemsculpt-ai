import { JSDOM } from "jsdom";
import { UpgradePlanModal, hasActivePlan, requireActivePlan } from "../UpgradePlanModal";
import { PLAN_REQUIRED_MESSAGE } from "../../utils/errors";

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
  const submitManualCode = jest.fn().mockResolvedValue({ kind: "error", reason: "expired" });
  return {
    app: {},
    settings: { licenseKey: "", licenseValid: false, userEmail: "", ...settings },
    getAccountConnectService: () => ({ begin, submitManualCode }),
    openNewChat: jest.fn(),
    begin,
    submitManualCode,
  } as any;
}

describe("UpgradePlanModal", () => {
  afterEach(() => {
    UpgradePlanModal.closeCurrent();
    document.body.innerHTML = "";
    jest.clearAllMocks();
  });

  it("asks a signed-out vault to sign in and explains the plan requirement", () => {
    const modal = new UpgradePlanModal(createPlugin(), { feature: "Chat" });
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("Unlock SystemSculpt AI");
    expect(modal.modalEl.textContent).toContain("Chat needs an active SystemSculpt plan.");
    expect(modal.modalEl.textContent).toContain(PLAN_REQUIRED_MESSAGE);
    expect(findButtonByText(modal.modalEl, "Sign in")).toBeTruthy();
    expect(findButtonByText(modal.modalEl, "Create free account")).toBeTruthy();
    modal.onClose();
  });

  it("offers lifetime and monthly purchases to a signed-in account without a plan", () => {
    const plugin = createPlugin({ userEmail: "user@example.com" });
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("Signed in as user@example.com.");
    expect(findButtonByText(modal.modalEl, "Get lifetime license")).toBeTruthy();
    expect(findButtonByText(modal.modalEl, "Subscribe monthly")).toBeTruthy();
    modal.onClose();
  });

  it("opens checkout with attribution and guides back to license sync after purchase", () => {
    const openSpy = jest.fn();
    (window as any).open = openSpy;
    const plugin = createPlugin({ userEmail: "user@example.com" });
    const modal = new UpgradePlanModal(plugin);
    modal.onOpen();

    findButtonByText(modal.modalEl, "Get lifetime license").click();

    expect(openSpy).toHaveBeenCalledWith(
      "https://systemsculpt.com/lifetime?utm_source=obsidian-plugin&utm_medium=modal&utm_campaign=upgrade",
      "_blank",
      "noopener,noreferrer",
    );
    expect(modal.modalEl.textContent).toContain("Finish your purchase in the browser");
    expect(findButtonByText(modal.modalEl, "I've purchased — Sync license")).toBeTruthy();
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
    const codeInput = modal.modalEl.querySelector<HTMLInputElement>("[data-testid='upgrade-plan.code']");
    expect(codeInput).not.toBeNull();

    codeInput!.value = "  code-123  ";
    findButtonByText(modal.modalEl, "Complete sign-in").click();
    await flushPromises();

    expect(plugin.submitManualCode).toHaveBeenCalledWith("code-123");
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

  it("renders the soft onboarding welcome with an explore escape hatch", () => {
    const modal = new UpgradePlanModal(createPlugin(), { context: "onboarding" });
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain("Welcome to SystemSculpt AI");
    expect(modal.modalEl.textContent).not.toContain(PLAN_REQUIRED_MESSAGE);
    expect(findButtonByText(modal.modalEl, "Explore on my own")).toBeTruthy();
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
