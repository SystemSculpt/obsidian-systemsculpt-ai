import { uiSetup } from "../uiSetup";
import { JSDOM } from "jsdom";

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
  if (!proto.setAttrs) {
    proto.setAttrs = function (attrs: Record<string, any>) {
      if (!attrs || typeof attrs !== "object") {
        return this;
      }
      Object.entries(attrs).forEach(([name, value]) => {
        this.setAttr(name, value);
      });
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
      const el = (this.ownerDocument ?? document).createElement(tag);
      if (options?.cls) {
        `${options.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
      }
      if (options?.text !== undefined) {
        el.textContent = `${options.text}`;
      }
      if (options?.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          (el as any).setAttr?.(key, value as any);
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

const createMockChatView = () => {
  const root = document.createElement("div");
  root.createDiv();
  const content = root.createDiv();
  const composer = content.createDiv({ cls: "systemsculpt-chat-composer" });
  const toolbar = composer.createDiv({ cls: "systemsculpt-chat-composer-toolbar" });
  toolbar.createDiv({ cls: "systemsculpt-model-indicator-section inline systemsculpt-chat-composer-chips" });
  const rightGroup = toolbar.createDiv({ cls: "systemsculpt-chat-composer-toolbar-group mod-right" });
  const settingsButton = rightGroup.createEl("button", {
    cls: "clickable-icon systemsculpt-chat-composer-button systemsculpt-chat-settings-button",
    attr: {
      type: "button",
      "aria-label": "Chat settings",
    },
  });

  const openCreditsBalanceModal = jest.fn();
  const chatView: any = {
    containerEl: root,
    plugin: {
      settings: {
        licenseValid: true,
        licenseKey: "sk-test-license",
      },
    },
    creditsBalance: {
      totalRemaining: 1234,
      includedRemaining: 1000,
      includedPerMonth: 2000,
      addOnRemaining: 234,
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
    },
    registerDomEvent: (el: HTMLElement, type: string, callback: (event: Event) => void) => {
      el.addEventListener(type as keyof HTMLElementEventMap, callback as EventListener);
    },
    openCreditsBalanceModal,
  };

  return {
    chatView,
    rightGroup,
    settingsButton,
    openCreditsBalanceModal,
  };
};

describe("uiSetup.updateCreditsIndicator", () => {
  it("places the credits control in the right composer group before settings", async () => {
    const { chatView, rightGroup, settingsButton, openCreditsBalanceModal } = createMockChatView();

    await uiSetup.updateCreditsIndicator(chatView);

    const creditsButton = chatView.creditsIndicator as HTMLElement;
    expect(creditsButton).toBeTruthy();
    expect(creditsButton.tagName).toBe("BUTTON");
    expect(creditsButton.parentElement).toBe(rightGroup);
    expect(rightGroup.firstElementChild).toBe(creditsButton);
    expect(rightGroup.lastElementChild).toBe(settingsButton);
    expect(rightGroup.querySelectorAll(".systemsculpt-credits-indicator")).toHaveLength(1);
    expect(creditsButton.textContent?.trim()).toBe("");
    expect(creditsButton.getAttribute("title")).toContain("Credits remaining:");

    creditsButton.click();
    expect(openCreditsBalanceModal).toHaveBeenCalledTimes(1);
  });

  it("hides the credits control when pro is inactive", async () => {
    const { chatView } = createMockChatView();

    await uiSetup.updateCreditsIndicator(chatView);
    expect(chatView.creditsIndicator.style.display).toBe("");

    chatView.plugin.settings.licenseValid = false;
    await uiSetup.updateCreditsIndicator(chatView);
    expect(chatView.creditsIndicator.style.display).toBe("none");
  });
});
