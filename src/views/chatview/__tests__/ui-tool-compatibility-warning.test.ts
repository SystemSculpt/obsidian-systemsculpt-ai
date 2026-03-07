jest.mock("../../../utils/modelUtils", () => ({
  ensureCanonicalId: jest.fn((id: string) => id || ""),
  getModelLabelWithProvider: jest.fn((id: string) => id || ""),
  getDisplayName: jest.fn((id: string) => (id === "text-only-model" ? "Text Only Model" : id || "")),
  getImageCompatibilityInfo: jest.fn(),
}));

import { TFile } from "obsidian";
import { JSDOM } from "jsdom";
import { getImageCompatibilityInfo } from "../../../utils/modelUtils";
import { uiSetup } from "../uiSetup";

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

const mockedGetImageCompatibilityInfo = getImageCompatibilityInfo as jest.Mock;

const createMockChatView = (options?: {
  contextFiles?: string[];
  processingExtensions?: string[];
}) => {
  const root = document.createElement("div");
  root.createDiv();
  const content = root.createDiv();
  content.createDiv({ cls: "systemsculpt-chat-composer" });

  const imageFile = new TFile({ path: "Image.png" });
  const docFile = new TFile({ path: "Notes.md" });

  const contextFiles = new Set(options?.contextFiles ?? []);
  const processingEntries = (options?.processingExtensions ?? []).map((extension, index) => ({
    key: `processing-${index}`,
    file: new TFile({ path: `Queued-${index}.${extension}` }),
  }));

  const chatView: any = {
    containerEl: root,
    selectedModelId: "text-only-model",
    app: {
      metadataCache: {
        getFirstLinkpathDest: jest.fn((linkText: string) => {
          if (linkText === "Image.png") return imageFile;
          if (linkText === "Notes.md") return docFile;
          return null;
        }),
      },
      vault: {
        getAbstractFileByPath: jest.fn((linkText: string) => {
          if (linkText === "Image.png") return imageFile;
          if (linkText === "Notes.md") return docFile;
          return null;
        }),
      },
    },
    contextManager: {
      getContextFiles: jest.fn(() => contextFiles),
      getProcessingEntries: jest.fn(() => processingEntries),
    },
    plugin: {
      modelService: {
        getModels: jest.fn(async () => [{ id: "text-only-model" }]),
      },
    },
  };

  return { chatView, content };
};

describe("uiSetup.updateToolCompatibilityWarning", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mockedGetImageCompatibilityInfo.mockReset();
  });

  it("does not show the warning when there is no image context to skip", async () => {
    mockedGetImageCompatibilityInfo.mockReturnValue({
      isCompatible: false,
      confidence: "high",
    });

    const { chatView, content } = createMockChatView({
      contextFiles: ["[[Notes.md]]"],
    });

    await uiSetup.updateToolCompatibilityWarning(chatView);

    expect(content.querySelector(".systemsculpt-tool-warning-banner")).toBeNull();
  });

  it("shows the warning when image context files are attached", async () => {
    mockedGetImageCompatibilityInfo.mockReturnValue({
      isCompatible: false,
      confidence: "high",
    });

    const { chatView, content } = createMockChatView({
      contextFiles: ["[[Image.png]]"],
    });

    await uiSetup.updateToolCompatibilityWarning(chatView);

    const banner = content.querySelector(".systemsculpt-tool-warning-banner") as HTMLElement | null;
    expect(banner).toBeTruthy();
    expect(banner?.style.display).toBe("flex");
    expect(banner?.textContent).toContain("Text Only Model doesn't support images");
  });

  it("shows the warning when an image is still processing", async () => {
    mockedGetImageCompatibilityInfo.mockReturnValue({
      isCompatible: false,
      confidence: "high",
    });

    const { chatView, content } = createMockChatView({
      processingExtensions: ["png"],
    });

    await uiSetup.updateToolCompatibilityWarning(chatView);

    const banner = content.querySelector(".systemsculpt-tool-warning-banner") as HTMLElement | null;
    expect(banner).toBeTruthy();
    expect(banner?.style.display).toBe("flex");
  });

  it("rebuilds a malformed banner instead of leaving an empty warning strip", async () => {
    mockedGetImageCompatibilityInfo.mockReturnValue({
      isCompatible: false,
      confidence: "high",
    });

    const { chatView, content } = createMockChatView({
      contextFiles: ["[[Image.png]]"],
    });
    const composer = content.querySelector(".systemsculpt-chat-composer") as HTMLElement;
    const malformedBanner = document.createElement("div");
    malformedBanner.className = "systemsculpt-tool-warning-banner";
    composer.parentNode?.insertBefore(malformedBanner, composer);

    await uiSetup.updateToolCompatibilityWarning(chatView);

    expect(malformedBanner.querySelector(".systemsculpt-tool-warning-icon")).toBeTruthy();
    expect(malformedBanner.querySelector(".systemsculpt-tool-warning-text")?.textContent).toContain(
      "Text Only Model doesn't support images"
    );
  });
});
