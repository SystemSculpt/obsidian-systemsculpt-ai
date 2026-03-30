/**
 * @jest-environment jsdom
 */

import { App, WorkspaceLeaf } from "obsidian";
import { SystemSculptService } from "../../../services/SystemSculptService";
import { ChatView } from "../ChatView";

describe("ChatView loading UX", () => {
  test("shows a loading banner and renders history progressively", async () => {
    const app = new App();
    const leaf = new WorkspaceLeaf(app);

    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({} as any);

    const plugin: any = {
      app,
      manifest: { id: "systemsculpt-ai" },
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        selectedModelId: "",
        chatFontSize: "medium",
        hideSystemMessagesInChat: false,
        respectReducedMotion: false,
        activeProvider: { type: "native", id: "systemsculpt" },
        customProviders: [],
        mcpServers: [],
      },
    };

    const chatView = new ChatView(leaf as any, plugin);
    chatView.chatId = "test-chat";
    chatView.isFullyLoaded = false;
    chatView.chatContainer = document.createElement("div");

    const domOps: Array<{ op: string; nodeType: number; className?: string }> = [];
    const originalInsertBefore = chatView.chatContainer.insertBefore.bind(chatView.chatContainer);
    const originalAppendChild = chatView.chatContainer.appendChild.bind(chatView.chatContainer);

    jest.spyOn(chatView.chatContainer, "insertBefore").mockImplementation(((newNode: any, ref: any) => {
      domOps.push({ op: "insertBefore", nodeType: newNode?.nodeType, className: newNode?.className });
      return originalInsertBefore(newNode, ref);
    }) as any);

    jest.spyOn(chatView.chatContainer, "appendChild").mockImplementation(((child: any) => {
      domOps.push({ op: "appendChild", nodeType: child?.nodeType, className: child?.className });
      return originalAppendChild(child);
    }) as any);

    chatView.messages = Array.from({ length: 60 }, (_v, i) => ({
      role: "user",
      content: `Message ${i}`,
      message_id: `m${i}`,
    })) as any;

    await chatView.renderMessagesInChunks();

    const bannerIndex = domOps.findIndex(
      (entry) => entry.op === "insertBefore" && (entry.className ?? "").includes("systemsculpt-chat-loading-banner")
    );
    expect(bannerIndex).toBeGreaterThanOrEqual(0);

    const fragmentAppends = domOps.filter(
      (entry) => entry.op === "appendChild" && entry.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    );
    expect(fragmentAppends.length).toBeGreaterThan(1);

    const firstFragmentIndex = domOps.findIndex(
      (entry) => entry.op === "appendChild" && entry.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    );
    expect(bannerIndex).toBeLessThan(firstFragmentIndex);

    expect(chatView.chatContainer.querySelector(".systemsculpt-chat-loading-banner")).toBeNull();
    expect(chatView.chatContainer.querySelectorAll(".systemsculpt-message").length).toBe(20);
    expect(chatView.chatContainer.querySelector(".systemsculpt-load-more")?.textContent).toContain("(40)");
  });

  test("omits system-role messages from the rendered history when the setting is enabled", async () => {
    const app = new App();
    const leaf = new WorkspaceLeaf(app);

    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({} as any);

    const plugin: any = {
      app,
      manifest: { id: "systemsculpt-ai" },
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        selectedModelId: "",
        chatFontSize: "medium",
        hideSystemMessagesInChat: true,
        respectReducedMotion: false,
        activeProvider: { type: "native", id: "systemsculpt" },
        customProviders: [],
        mcpServers: [],
      },
    };

    const chatView = new ChatView(leaf as any, plugin);
    chatView.chatContainer = document.createElement("div");
    chatView.messages = [
      { role: "user", content: "Visible user turn", message_id: "u1" },
      { role: "system", content: "Hidden system turn", message_id: "s1" },
      { role: "assistant", content: "Visible assistant turn", message_id: "a1" },
    ] as any;

    await chatView.renderMessagesInChunks();

    expect(chatView.chatContainer.querySelectorAll(".systemsculpt-message")).toHaveLength(2);
    expect(chatView.chatContainer.querySelector(".systemsculpt-system-message")).toBeNull();
    expect(chatView.chatContainer.textContent).toContain("Visible user turn");
    expect(chatView.chatContainer.textContent).toContain("Visible assistant turn");
    expect(chatView.chatContainer.textContent).not.toContain("Hidden system turn");
  });
});
