/** @jest-environment jsdom */
import { App, Keymap, MarkdownRenderer } from "obsidian";
import type { AgentConversationSnapshot } from "../../../chat/ChatConversation";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
import { presentAgentConversation } from "../AgentConversationPresentation";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  Keymap: { isModEvent: jest.fn((event: MouseEvent) => event.metaKey || event.ctrlKey || event.button === 1) },
}));

const sourcePath = "SystemSculpt/Chats/Atlas question.md";
const citation = "Projects/Atlas launch#Blockers";

function setup() {
  const app = new App();
  const openLinkText = jest.fn(async () => undefined);
  app.workspace.openLinkText = openLinkText;
  const parent = document.body.createDiv();
  const renderer = new AgentConversationRenderer(parent, {
    app, sourcePath: () => sourcePath, onApprove: jest.fn(),
    onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(),
  });
  renderer.load();
  return { renderer, parent, openLinkText };
}

function click(target: Element, init: MouseEventInit = {}, type = "click"): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function snapshot(status: AgentConversationSnapshot["status"]): AgentConversationSnapshot {
  return {
    runId: "run", turnId: "turn", elapsedMs: 1_000, status, messages: [],
    parts: [{ kind: "text", id: "answer", messageId: "answer", order: 0,
      markdown: "Atlas is blocked by access review. [[Projects/Atlas launch#Blockers|Atlas launch]]",
      state: status === "running" ? "streaming" : "complete" }],
  };
}

async function renderActive(renderer: AgentConversationRenderer, status: AgentConversationSnapshot["status"]) {
  const value = snapshot(status);
  await renderer.renderActive(value, presentAgentConversation(value, false));
  // Streaming commits run on the renderer's throttle, independently of renderActive.
  if (status === "running") {
    await new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (renderer.element.querySelector("a.internal-link")) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(renderer.element, { childList: true, subtree: true });
      if (renderer.element.querySelector("a.internal-link")) {
        observer.disconnect();
        resolve();
      }
    });
  }
}

describe("conversation source links", () => {
  beforeEach(() => {
    jest.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, _markdown, staging) => {
      const link = staging.createEl("a", {
        cls: "internal-link", attr: { "data-href": citation, href: "wrong-fallback" },
      });
      link.createEl("strong", { text: "Atlas launch" });
    });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); document.body.empty(); });

  it("opens streamed, completed and restored citations with their source path and heading", async () => {
    const { renderer, parent, openLinkText } = setup();
    try {
      for (const status of ["running", "completed"] as const) {
        await renderActive(renderer, status);
        const event = click(parent.querySelector("a.internal-link strong")!);
        expect(event.defaultPrevented).toBe(true);
        expect(openLinkText).toHaveBeenLastCalledWith(citation, sourcePath, false);
      }
      await renderer.renderHistory([{ role: "assistant", message_id: "restored", content: "Saved citation" }]);
      click(parent.querySelector(".systemsculpt-agent-history a.internal-link")!);
      expect(openLinkText).toHaveBeenCalledTimes(3);
    } finally { renderer.unload(); }
  });

  it("preserves host modifier handling and middle-click without handling right-click", async () => {
    const { renderer, parent, openLinkText } = setup();
    try {
      await renderer.renderHistory([{ role: "assistant", message_id: "saved", content: "Citation" }]);
      const link = parent.querySelector("a.internal-link")!;
      click(link, { metaKey: true });
      expect(openLinkText).toHaveBeenLastCalledWith(citation, sourcePath, true);
      jest.mocked(Keymap.isModEvent).mockReturnValueOnce("split");
      click(link, { shiftKey: true, ctrlKey: true });
      expect(openLinkText).toHaveBeenLastCalledWith(citation, sourcePath, "split");
      expect(click(link, { button: 1 }, "auxclick").defaultPrevented).toBe(true);
      expect(openLinkText).toHaveBeenCalledTimes(3);
      expect(click(link, { button: 2 }, "auxclick").defaultPrevented).toBe(false);
      expect(openLinkText).toHaveBeenCalledTimes(3);
    } finally { renderer.unload(); }
  });

  it("leaves external, empty and already-handled links alone and removes handlers on unload", async () => {
    const { renderer, parent, openLinkText } = setup();
    await renderer.renderHistory([{ role: "assistant", message_id: "saved", content: "Citation" }]);
    const link = parent.querySelector<HTMLAnchorElement>("a.internal-link")!;
    link.addEventListener("click", event => event.preventDefault(), { once: true });
    click(link);
    expect(openLinkText).not.toHaveBeenCalled();
    link.removeAttribute("data-href");
    link.setAttribute("href", "Projects/Atlas launch");
    click(link);
    expect(openLinkText).toHaveBeenLastCalledWith("Projects/Atlas launch", sourcePath, false);
    openLinkText.mockClear();
    link.setAttribute("href", "");
    expect(click(link).defaultPrevented).toBe(false);
    link.removeClass("internal-link");
    link.setAttribute("href", "https://example.com");
    link.addEventListener("click", event => event.preventDefault(), { once: true });
    click(link);
    expect(openLinkText).not.toHaveBeenCalled();
    link.addClass("internal-link");
    link.setAttribute("data-href", citation);
    renderer.unload();
    expect(click(link).defaultPrevented).toBe(false);
    expect(openLinkText).not.toHaveBeenCalled();
  });
});
