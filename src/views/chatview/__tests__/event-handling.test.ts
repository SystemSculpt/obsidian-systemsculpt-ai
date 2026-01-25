import { JSDOM } from "jsdom";
import { TFile } from "obsidian";
import { eventHandling } from "../eventHandling";
import { DocumentContextManager } from "../../../services/DocumentContextManager";

jest.mock("../../../services/DocumentContextManager", () => ({
  DocumentContextManager: {
    getInstance: jest.fn(),
  },
}));

jest.mock("../../../core/ui/", () => ({
  showPopup: jest.fn(async () => ({ confirmed: false })),
  showAlert: jest.fn(async () => {}),
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

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
  if (!proto.createEl) {
    proto.createEl = function (tag: string, options?: any) {
      const el = (this.ownerDocument ?? document).createElement(tag);
      if (options?.cls) {
        `${options.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
      }
      if (options?.text !== undefined) {
        el.textContent = `${options.text}`;
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
};

ensureDomHelpers();

describe("eventHandling.setupDragAndDrop", () => {
  afterEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("adds search-result files to context on drop", async () => {
    const addFilesToContext = jest.fn(async (files: TFile[]) => files.length);
    (DocumentContextManager.getInstance as jest.Mock).mockReturnValue({ addFilesToContext });

    const chatView: any = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => new TFile({ path })),
          getAllLoadedFiles: jest.fn(() => []),
        },
      },
      plugin: {
        settings: { licenseKey: "key", licenseValid: true },
      },
      contextManager: {
        getContextFiles: () => new Set(),
      },
    };

    const container = document.createElement("div");
    const handlers: Record<string, (e: any) => any> = {};
    const originalAdd = container.addEventListener.bind(container);
    container.addEventListener = (type: string, cb: any) => {
      handlers[type] = cb;
      return originalAdd(type, cb);
    };

    eventHandling.setupDragAndDrop(chatView, container);

    const dataTransfer = {
      items: [
        {
          type: "text/plain",
          getAsString: (cb: (value: string) => void) => cb("FileA.md\nFileB.md"),
        },
      ],
      types: ["text/plain"],
    };

    await handlers.drop({
      dataTransfer,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });

    expect(addFilesToContext).toHaveBeenCalled();
    const filesArg = addFilesToContext.mock.calls[0][0] as TFile[];
    expect(filesArg).toHaveLength(2);
    expect(filesArg.map((f) => f.path)).toEqual(["FileA.md", "FileB.md"]);
  });
});
