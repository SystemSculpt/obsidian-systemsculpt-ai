import { CreditsBalanceModal } from "../CreditsBalanceModal";
import { JSDOM } from "jsdom";
import { LICENSE_URL } from "../../types";

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

describe("CreditsBalanceModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    (window as any).open = jest.fn();
  });

  it("renders credit details and supports buy/setup actions", async () => {
    const loadBalance = jest.fn().mockResolvedValue({
      includedRemaining: 2200,
      addOnRemaining: 300,
      totalRemaining: 2500,
      includedPerMonth: 3000,
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
      cycleStartedAt: "2026-02-01T00:00:00.000Z",
      cycleAnchorAt: "2026-02-01T00:00:00.000Z",
      turnInFlightUntil: null,
      purchaseUrl: "https://systemsculpt.com/buy-credits",
    });
    const onOpenSetup = jest.fn();

    const modal = new CreditsBalanceModal({} as any, {
      initialBalance: {
        includedRemaining: 2000,
        addOnRemaining: 500,
        totalRemaining: 2500,
        includedPerMonth: 3000,
        cycleEndsAt: "2026-03-01T00:00:00.000Z",
        cycleStartedAt: "2026-02-01T00:00:00.000Z",
        cycleAnchorAt: "2026-02-01T00:00:00.000Z",
        turnInFlightUntil: null,
        purchaseUrl: "https://systemsculpt.com/buy-credits",
      },
      loadBalance,
      onOpenSetup,
    });

    modal.onOpen();
    await flushPromises();

    expect(modal.modalEl.textContent).toContain("Credits & Usage");
    expect(modal.modalEl.textContent).toContain("Total remaining");
    expect(modal.modalEl.textContent).toContain("Included left");
    expect(modal.modalEl.textContent).toContain("Included remaining this cycle");

    const meterFill = modal.modalEl.querySelector(".ss-credits-balance__meter-fill") as HTMLElement | null;
    expect(meterFill).not.toBeNull();
    // 2200 / 3000 = 73.333... -> conservative floor to 73.3%
    expect(meterFill?.style.width).toBe("73.3%");

    findButtonByText(modal.modalEl, "Buy Credits").click();
    expect((window as any).open).toHaveBeenCalledWith("https://systemsculpt.com/buy-credits", "_blank");

    findButtonByText(modal.modalEl, "Open Setup").click();
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });

  it("falls back to LICENSE_URL when purchase_url is unavailable and refreshes on demand", async () => {
    const refreshedBalance = {
      includedRemaining: 1000,
      addOnRemaining: 0,
      totalRemaining: 1000,
      includedPerMonth: 3000,
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
      cycleStartedAt: "2026-02-01T00:00:00.000Z",
      cycleAnchorAt: "2026-02-01T00:00:00.000Z",
      turnInFlightUntil: "2026-02-10T10:00:00.000Z",
      purchaseUrl: null,
    };

    const loadBalance = jest.fn().mockResolvedValue(refreshedBalance);
    const modal = new CreditsBalanceModal({} as any, {
      initialBalance: null,
      fallbackPurchaseUrl: null,
      loadBalance,
      onOpenSetup: jest.fn(),
    });

    modal.onOpen();
    await flushPromises();
    expect(loadBalance).toHaveBeenCalledTimes(1);
    expect(modal.modalEl.textContent).toContain("Request lock until");

    findButtonByText(modal.modalEl, "Refresh").click();
    await flushPromises();
    expect(loadBalance).toHaveBeenCalledTimes(2);

    findButtonByText(modal.modalEl, "Buy Credits").click();
    expect((window as any).open).toHaveBeenCalledWith(LICENSE_URL, "_blank");
  });

  it("uses conservative totals when reported and derived balances disagree", async () => {
    const loadBalance = jest.fn().mockResolvedValue({
      includedRemaining: 2000,
      addOnRemaining: 500,
      totalRemaining: 2900,
      includedPerMonth: 3000,
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
      cycleStartedAt: "2026-02-01T00:00:00.000Z",
      cycleAnchorAt: "2026-02-01T00:00:00.000Z",
      turnInFlightUntil: null,
      purchaseUrl: null,
    });

    const modal = new CreditsBalanceModal({} as any, {
      initialBalance: {
        includedRemaining: 2000,
        addOnRemaining: 500,
        totalRemaining: 2900,
        includedPerMonth: 3000,
        cycleEndsAt: "2026-03-01T00:00:00.000Z",
        cycleStartedAt: "2026-02-01T00:00:00.000Z",
        cycleAnchorAt: "2026-02-01T00:00:00.000Z",
        turnInFlightUntil: null,
        purchaseUrl: null,
      },
      loadBalance,
      onOpenSetup: jest.fn(),
    });

    modal.onOpen();
    await flushPromises();

    // Conservative total should show the lower derived amount (2,500), not reported 2,900.
    expect(modal.modalEl.textContent).toContain("2,500 credits");
    expect(modal.modalEl.textContent).toContain("Balance sources disagree");
  });
});
