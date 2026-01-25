import { JSDOM } from "jsdom";
import { AgentSelectionMenu } from "../AgentSelectionMenu";
import { SystemPromptService } from "../../../services/SystemPromptService";

jest.mock("../../../services/SystemPromptService", () => ({
  SystemPromptService: {
    getInstance: jest.fn(),
  },
}));

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
  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      return this;
    };
  }
};

ensureDomHelpers();

describe("AgentSelectionMenu", () => {
  afterEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("filters agents and selects one", async () => {
    (SystemPromptService.getInstance as jest.Mock).mockReturnValue({
      getCustomPromptFiles: jest.fn(async () => [
        { path: "Prompts/Custom.md", name: "Custom Prompt" },
      ]),
    });

    const input = document.createElement("textarea");
    input.value = "/agent ";
    const chatView: any = {
      systemPromptType: "general-use",
      systemPromptPath: "",
      updateSystemPromptIndicator: jest.fn(async () => {}),
      saveChat: jest.fn(async () => {}),
    };
    const plugin: any = { app: {}, settings: {} };

    const menu = new AgentSelectionMenu(plugin, chatView, input);
    await menu.show(input.value.length);

    const searchInput = document.querySelector(".agent-selection-search-input") as HTMLInputElement;
    searchInput.value = "concise";
    searchInput.dispatchEvent(new dom.window.Event("input"));

    const items = document.querySelectorAll(".agent-selection-item");
    expect(items.length).toBeGreaterThan(0);

    items[0].dispatchEvent(new dom.window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatView.updateSystemPromptIndicator).toHaveBeenCalled();
    expect(chatView.saveChat).toHaveBeenCalled();
    expect(input.value.includes("/agent")).toBe(false);
  });
});

