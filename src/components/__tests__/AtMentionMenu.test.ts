import { JSDOM } from "jsdom";
import { TFile } from "obsidian";
import { AtMentionMenu } from "../AtMentionMenu";

const applyObsidianDomHelpers = (win: Window) => {
  const proto = (win as any).HTMLElement?.prototype as any;
  if (!proto) return;

  const applyClasses = (el: HTMLElement, cls: string | string[] | undefined) => {
    if (!cls) return;
    const classes = Array.isArray(cls) ? cls : `${cls}`.split(/\s+/);
    classes.filter(Boolean).forEach((c) => el.classList.add(c));
  };

  if (!proto.addClass) {
    proto.addClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`
            .split(/\s+/)
            .filter(Boolean)
            .forEach((c) => this.classList.add(c));
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

  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
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

  if (!proto.createEl) {
    proto.createEl = function (tag: string, options?: any) {
      const normalized = typeof options === "string" ? { cls: options } : options ?? {};
      const el = (this.ownerDocument ?? document).createElement(tag);
      applyClasses(el, normalized.cls);
      if (normalized.text !== undefined) {
        el.textContent = `${normalized.text}`;
      }
      if (normalized.attr) {
        Object.entries(normalized.attr).forEach(([key, value]) => {
          el.setAttr(key, value as any);
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

const createMockFile = (path: string, mtime: number): TFile => {
  return new TFile({
    path,
    stat: {
      mtime,
      ctime: mtime,
      size: 0,
    },
  });
};

describe("AtMentionMenu", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");

  beforeEach(() => {
    (global as any).window = dom.window as any;
    (global as any).document = dom.window.document as any;
    applyObsidianDomHelpers(dom.window as any);
    jest.useFakeTimers();
    // Map window timers to global timers so Jest fake timers control them.
    (global as any).window.setTimeout = globalThis.setTimeout.bind(globalThis);
    (global as any).window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders a non-blocking search and shows results after timers flush", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);

    const files = [
      createMockFile("notes/alpha.md", 300),
      createMockFile("notes/beta.md", 200),
      createMockFile("other/gamma.md", 100),
    ];

    const chatView: any = {
      plugin: {
        vaultFileCache: {
          getAllFiles: () => files,
        },
      },
      app: {
        vault: { getFiles: () => files },
        workspace: { openLinkText: jest.fn() },
      },
      contextManager: {
        hasContextFile: jest.fn(() => false),
      },
      addFileToContext: jest.fn(async () => {}),
    };

    const menu = new AtMentionMenu(chatView, input);
    menu.load();
    menu.show(0, 1, "a");

    // Immediate render: Searching… placeholder.
    expect(document.body.textContent).toContain("Searching…");

    // Flush start + chunk timers.
    jest.runOnlyPendingTimers();
    jest.runOnlyPendingTimers();

    const titles = Array.from(document.querySelectorAll(".systemsculpt-at-mention-item__title")).map((el) => el.textContent);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles[0]).toBe("alpha");
    menu.unload();
  });

  it("cancels pending work when hidden", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);

    const files = [createMockFile("notes/alpha.md", 300)];
    const chatView: any = {
      plugin: {
        vaultFileCache: {
          getAllFiles: () => files,
        },
      },
      app: {
        vault: { getFiles: () => files },
        workspace: { openLinkText: jest.fn() },
      },
      contextManager: {
        hasContextFile: jest.fn(() => false),
      },
      addFileToContext: jest.fn(async () => {}),
    };

    const menu = new AtMentionMenu(chatView, input);
    menu.load();
    menu.show(0, 1, "a");
    menu.hide();

    jest.runOnlyPendingTimers();
    jest.runOnlyPendingTimers();

    expect(document.querySelectorAll(".systemsculpt-at-mention-item").length).toBe(0);
    expect(menu.isOpen()).toBe(false);
    menu.unload();
  });

  it("excludes already-attached files when query is empty (recent list)", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);

    const files = [
      createMockFile("notes/alpha.md", 300),
      createMockFile("notes/beta.md", 200),
    ];

    const chatView: any = {
      plugin: {
        vaultFileCache: {
          getAllFiles: () => files,
        },
      },
      app: {
        vault: { getFiles: () => files },
        workspace: { openLinkText: jest.fn() },
      },
      contextManager: {
        hasContextFile: jest.fn((wikiLink: string) => wikiLink === "[[notes/alpha.md]]"),
      },
      addFileToContext: jest.fn(async () => {}),
    };

    const menu = new AtMentionMenu(chatView, input);
    menu.load();
    menu.show(0, 1, "");

    jest.runOnlyPendingTimers();
    jest.runOnlyPendingTimers();

    const titles = Array.from(document.querySelectorAll(".systemsculpt-at-mention-item__title")).map((el) => el.textContent);
    expect(titles).toEqual(["beta"]);
    menu.unload();
  });
});
