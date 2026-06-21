jest.mock("../../../utils/modelUtils", () => ({
  createCanonicalId: jest.fn((p: string, m: string) => `${p}@@${m}`),
  ensureCanonicalId: jest.fn((id: string) => id || ""),
  getModelLabelWithProvider: jest.fn((id: string) => id || ""),
  getDisplayName: jest.fn((id: string) => id || ""),
  getImageCompatibilityInfo: jest.fn(),
}));

import { JSDOM } from "jsdom";
import { uiSetup } from "../uiSetup";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

// Minimal Obsidian HTMLElement extensions used by the banner code.
const proto = (global as any).window.HTMLElement.prototype;
if (!proto.empty) {
  proto.empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
    return this;
  };
}

const createChatView = () => {
  const root = document.createElement("div");
  root.appendChild(document.createElement("div")); // children[0]
  const content = document.createElement("div"); // children[1]
  root.appendChild(content);
  const composer = document.createElement("div");
  composer.className = "systemsculpt-chat-composer";
  content.appendChild(composer);
  return { chatView: { containerEl: root } as any, content };
};

const bannerOf = (content: HTMLElement) =>
  content.querySelector(".systemsculpt-license-banner") as HTMLElement | null;

describe("uiSetup license banner (#249)", () => {
  it("renders a dismissible, actionable banner above the composer for an expired subscription", () => {
    const { chatView, content } = createChatView();

    uiSetup.showLicenseBanner(chatView, { expired: true, renewUrl: "https://systemsculpt.com/renew" });

    const banner = bannerOf(content);
    expect(banner).not.toBeNull();
    expect(banner!.style.display).toBe("flex");
    expect(banner!.querySelector(".systemsculpt-license-banner-text")?.textContent).toMatch(/expired/i);
    // Inserted before the composer (so it sits at the bottom of the message area).
    expect(banner!.nextElementSibling?.className).toBe("systemsculpt-chat-composer");

    const renewBtn = banner!.querySelector(".systemsculpt-license-banner-renew") as HTMLElement;
    expect(renewBtn).not.toBeNull();
    const openSpy = jest.spyOn(dom.window as any, "open").mockImplementation(() => null);
    renewBtn.dispatchEvent(new dom.window.Event("click"));
    // Opened safely: scheme-validated, in a new tab, with opener/referrer stripped.
    expect(openSpy).toHaveBeenCalledWith("https://systemsculpt.com/renew", "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("uses invalid-key copy when the license is invalid (not expired)", () => {
    const { chatView, content } = createChatView();
    uiSetup.showLicenseBanner(chatView, { expired: false, renewUrl: "https://x" });
    expect(bannerOf(content)!.querySelector(".systemsculpt-license-banner-text")?.textContent).toMatch(/invalid/i);
  });

  it("is idempotent — repeated shows reuse one banner element", () => {
    const { chatView, content } = createChatView();
    uiSetup.showLicenseBanner(chatView, { expired: true, renewUrl: "https://x" });
    uiSetup.showLicenseBanner(chatView, { expired: true, renewUrl: "https://x" });
    expect(content.querySelectorAll(".systemsculpt-license-banner")).toHaveLength(1);
  });

  it("hideLicenseBanner hides an existing banner", () => {
    const { chatView, content } = createChatView();
    uiSetup.showLicenseBanner(chatView, { expired: true, renewUrl: "https://x" });
    uiSetup.hideLicenseBanner(chatView);
    expect(bannerOf(content)!.style.display).toBe("none");
  });

  it("the dismiss button hides the banner", () => {
    const { chatView, content } = createChatView();
    uiSetup.showLicenseBanner(chatView, { expired: true, renewUrl: "https://x" });
    const dismiss = bannerOf(content)!.querySelector(".systemsculpt-license-banner-dismiss") as HTMLElement;
    dismiss.dispatchEvent(new dom.window.Event("click"));
    expect(bannerOf(content)!.style.display).toBe("none");
  });
});
