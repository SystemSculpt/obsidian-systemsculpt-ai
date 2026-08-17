import { JSDOM } from "jsdom";
import { AccountConnectModal } from "../AccountConnectModal";
import type { ConnectOutcome } from "../../services/AccountConnectService";

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

/** Captures external opens: the no-Electron path clicks a synthetic anchor. */
const spyOnAnchorClicks = () => {
  const hrefs: string[] = [];
  const spy = jest
    .spyOn((window as any).HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.getAttribute("href") ?? "");
    });
  return { hrefs, spy };
};

describe("AccountConnectModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    (window as any).open = jest.fn();
  });

  it("shows Authenticating… while exchanging, then the welcome state", async () => {
    let resolveOutcome!: (outcome: ConnectOutcome) => void;
    const runExchange = jest.fn(
      () => new Promise<ConnectOutcome>((resolve) => { resolveOutcome = resolve; })
    );
    const modal = new AccountConnectModal({} as any, runExchange);

    modal.onOpen();

    expect(runExchange).toHaveBeenCalledTimes(1);
    expect(modal.modalEl.textContent).toContain("Signing you in");
    expect(modal.modalEl.textContent).toContain("Authenticating…");
    expect(modal.modalEl.querySelector(".ss-account-connect__spinner")).not.toBeNull();

    resolveOutcome({
      kind: "signed-in",
      name: "Michael Roberts",
      email: "user@example.com",
      licenseValid: true,
    });
    await flushPromises();

    expect(modal.modalEl.textContent).toContain("Welcome, Michael!");
    expect(modal.modalEl.textContent).toContain("You're now signed in to SystemSculpt.");
    expect(modal.modalEl.textContent).toContain("Signed in as user@example.com.");
    expect(modal.modalEl.textContent).toContain("Your license is active");
    expect(modal.modalEl.textContent).not.toContain("Authenticating…");
    expect(findButtonByText(modal.modalEl, "Get started")).toBeTruthy();
  });

  it("falls back to the email in the welcome title when the account has no name", async () => {
    const modal = new AccountConnectModal({} as any, async () => ({
      kind: "signed-in" as const,
      name: null,
      email: "user@example.com",
      licenseValid: false,
    }));

    modal.onOpen();
    await flushPromises();

    expect(modal.modalEl.textContent).toContain("Welcome, user@example.com!");
    expect(modal.modalEl.textContent).toContain("Your license is being confirmed.");
  });

  it("falls back to the pricing page when no choose-plan action is provided", async () => {
    const modal = new AccountConnectModal({} as any, async () => ({
      kind: "no-license" as const,
      name: "User",
      email: "user@example.com",
    }));

    modal.onOpen();
    await flushPromises();

    expect(modal.modalEl.textContent).toContain("Welcome, User!");
    expect(modal.modalEl.textContent).toContain("no active plan yet");

    const { hrefs, spy } = spyOnAnchorClicks();
    findButtonByText(modal.modalEl, "Choose a plan").click();
    expect(hrefs).toEqual(["https://systemsculpt.com/pricing"]);
    spy.mockRestore();
  });

  it("routes the plan-needed account into the caller's upgrade flow", async () => {
    const onChoosePlan = jest.fn();
    const modal = new AccountConnectModal(
      {} as any,
      async () => ({ kind: "no-license" as const, name: "User", email: "user@example.com" }),
      { onChoosePlan },
    );

    modal.onOpen();
    await flushPromises();

    const { hrefs, spy } = spyOnAnchorClicks();
    findButtonByText(modal.modalEl, "Choose a plan").click();
    expect(onChoosePlan).toHaveBeenCalledTimes(1);
    expect(hrefs).toEqual([]);
    expect((window as any).open).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("replaces an already-open instance instead of stacking outcomes", async () => {
    const outcome = {
      kind: "signed-in" as const,
      name: "User",
      email: "user@example.com",
      licenseValid: true,
    };
    const first = new AccountConnectModal({} as any, async () => outcome);
    first.onOpen();
    const closeSpy = jest.spyOn(first, "close");

    const second = new AccountConnectModal({} as any, async () => outcome);
    second.onOpen();
    await flushPromises();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(second.modalEl.textContent).toContain("Welcome, User!");
    second.onClose();
  });

  it("runs the get-started action after a successful sign-in", async () => {
    const onGetStarted = jest.fn();
    const modal = new AccountConnectModal(
      {} as any,
      async () => ({
        kind: "signed-in" as const,
        name: "User",
        email: "user@example.com",
        licenseValid: true,
      }),
      { onGetStarted },
    );

    modal.onOpen();
    await flushPromises();

    findButtonByText(modal.modalEl, "Get started").click();
    expect(onGetStarted).toHaveBeenCalledTimes(1);
  });

  it("offers a one-tap restart for recoverable sign-in errors", async () => {
    const onRetrySignIn = jest.fn();
    const modal = new AccountConnectModal(
      {} as any,
      async () => ({ kind: "error" as const, reason: "expired" as const }),
      { onRetrySignIn },
    );

    modal.onOpen();
    await flushPromises();

    findButtonByText(modal.modalEl, "Start sign-in again").click();
    expect(onRetrySignIn).toHaveBeenCalledTimes(1);
  });

  it("shows the error state for a failed exchange", async () => {
    const modal = new AccountConnectModal({} as any, async () => ({
      kind: "error" as const,
      reason: "invalid-code" as const,
    }));

    modal.onOpen();
    await flushPromises();

    expect(modal.modalEl.textContent).toContain("Sign-in didn't finish");
    expect(modal.modalEl.textContent).toContain("The connection code was invalid or expired.");
    expect(findButtonByText(modal.modalEl, "Close")).toBeTruthy();
  });

  it("treats a rejected exchange as temporarily unavailable", async () => {
    const modal = new AccountConnectModal({} as any, async () => {
      throw new Error("boom");
    });

    modal.onOpen();
    await flushPromises();

    expect(modal.modalEl.textContent).toContain("Sign-in didn't finish");
    expect(modal.modalEl.textContent).toContain("Sign-in is temporarily unavailable.");
  });

  it("does not render an outcome after the modal was closed", async () => {
    let resolveOutcome!: (outcome: ConnectOutcome) => void;
    const modal = new AccountConnectModal(
      {} as any,
      () => new Promise<ConnectOutcome>((resolve) => { resolveOutcome = resolve; }),
    );

    modal.onOpen();
    modal.onClose();
    resolveOutcome({ kind: "signed-in", name: "User", email: null, licenseValid: true });
    await flushPromises();

    expect(modal.modalEl.textContent).not.toContain("Welcome");
  });
});
