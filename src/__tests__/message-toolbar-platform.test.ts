import type { ChatRole } from "../types";

jest.mock("../services/PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(),
  },
}));

const { PlatformContext } = require("../services/PlatformContext");
const { attachMessageToolbar } = require("../views/chatview/ui/MessageToolbar") as typeof import("../views/chatview/ui/MessageToolbar");
const obsidian = require("obsidian");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).HTMLElement = dom.window.HTMLElement;
(global as any).Node = dom.window.Node;
(global as any).CustomEvent = dom.window.CustomEvent;
(global as any).requestAnimationFrame = (callback: any) => {
  return setTimeout(() => callback(Date.now()), 0) as unknown as number;
};

const setIconSpy = jest.spyOn(obsidian, "setIcon").mockImplementation(() => {});

describe("MessageToolbar platform variant tagging", () => {
  const createMessageEl = () => {
    const wrapper = document.createElement("div");
    wrapper.classList.add("systemsculpt-message", "systemsculpt-user-message");
    wrapper.dataset.messageId = "msg-1";
    const content = document.createElement("div");
    content.className = "systemsculpt-message-content";
    content.textContent = "Hello";
    wrapper.appendChild(content);
    return wrapper;
  };

  afterEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
  });

  afterAll(() => {
    setIconSpy.mockRestore();
  });

  it("adds platform-ui-mobile class when context reports mobile", () => {
    (PlatformContext.get as jest.Mock).mockReturnValue({
      uiVariant: () => "mobile",
    });

    const messageEl = createMessageEl();
    attachMessageToolbar({
      app: {} as any,
      messageEl,
      role: "user" as ChatRole,
      messageId: "msg-1",
    });
    const toolbar = messageEl.querySelector(".systemsculpt-message-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.classList.contains("platform-ui-mobile")).toBe(true);
    expect(toolbar?.classList.contains("is-mobile")).toBe(true);
  });

  it("adds platform-ui-desktop class when context reports desktop", () => {
    (PlatformContext.get as jest.Mock).mockReturnValue({
      uiVariant: () => "desktop",
    });

    const messageEl = createMessageEl();
    attachMessageToolbar({
      app: {} as any,
      messageEl,
      role: "assistant" as ChatRole,
      messageId: "msg-2",
    });
    const toolbar = messageEl.querySelector(".systemsculpt-message-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.classList.contains("platform-ui-desktop")).toBe(true);
    expect(toolbar?.classList.contains("is-mobile")).toBe(false);
  });
});
/**
 * @jest-environment jsdom
 */
/**
 * @jest-environment jsdom
 */
