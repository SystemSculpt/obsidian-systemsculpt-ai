import { JSDOM } from "jsdom";
import { ChatFavoriteToggle } from "../ChatFavoriteToggle";
import { ChatFavoritesService } from "../ChatFavoritesService";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).CustomEvent = dom.window.CustomEvent;

const ensureDomHelpers = () => {
  const proto = (global as any).window.HTMLElement?.prototype;
  if (!proto) return;
  if (!proto.addClass) {
    proto.addClass = function (cls: string) {
      this.classList.add(cls);
      return this;
    };
  }
  if (!proto.removeClass) {
    proto.removeClass = function (cls: string) {
      this.classList.remove(cls);
      return this;
    };
  }
  if (!proto.createDiv) {
    proto.createDiv = function (options?: any) {
      const el = (this.ownerDocument ?? document).createElement("div");
      if (options?.cls) el.className = options.cls;
      if (options?.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          if (value === true) el.setAttribute(key, "");
          else if (value !== false && value != null) el.setAttribute(key, `${value}`);
        });
      }
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.createSpan) {
    proto.createSpan = function (options?: any) {
      const el = (this.ownerDocument ?? document).createElement("span");
      if (options?.cls) el.className = options.cls;
      if (options?.text !== undefined) el.textContent = `${options.text}`;
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      return this;
    };
  }
};

ensureDomHelpers();

describe("ChatFavoriteToggle", () => {
  afterEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    (ChatFavoritesService as any).instance = null;
  });

  it("toggles favorite state and updates UI", async () => {
    const updateSettings = jest.fn(async (next: any) => {
      plugin.settings = { ...plugin.settings, ...next };
    });

    const plugin: any = {
      settings: { favoriteChats: [] },
      getSettingsManager: () => ({ updateSettings }),
    };

    const service = ChatFavoritesService.getInstance(plugin);
    const container = document.createElement("div");
    const callback = jest.fn();

    const toggle = new ChatFavoriteToggle(container, "chat-1", service, callback);
    toggle.element.dispatchEvent(new dom.window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.isFavorite("chat-1")).toBe(true);
    expect(toggle.element.classList.contains("is-favorite")).toBe(true);
    expect(callback).toHaveBeenCalledWith("chat-1", true);
  });
});
