/** @jest-environment jsdom */

import { Menu, Scope, TFile } from "obsidian";

const host = { localCli: true };
jest.mock("../../../platform/hostCapabilities", () => {
  const actual = jest.requireActual("../../../platform/hostCapabilities");
  return {
    ...actual,
    hasHostCapability: (capability: string, owner?: unknown) =>
      capability === "local-cli" ? host.localCli : actual.hasHostCapability(capability, owner),
    getHostOperatingSystem: () => "macOS",
  };
});
const confirm = { confirmed: true };
jest.mock("../../../core/ui/notifications", () => ({
  showConfirm: jest.fn(async () => confirm),
}));

import { AgentChatView } from "../AgentChatView";
import { UpgradePlanModal } from "../../../modals/UpgradePlanModal";
import { LocalAgentChatSession } from "../../../services/codex/LocalAgentChatSession";
import { CommandManager } from "../../../core/plugin/commands";

type Harness = AgentChatView & Record<string, any>;

function nativeAgent(agent: "claude" | "codex"): LocalAgentChatSession {
  const session = Object.create(LocalAgentChatSession.prototype);
  Object.defineProperty(session, "agent", { value: agent });
  session.getSnapshot = () => ({ status: "idle", parts: [], messages: [] });
  return session;
}

function harness(options: Readonly<{ messages?: number; agent?: "claude" | "codex" | null }> = {}): Harness {
  const view = Object.create(AgentChatView.prototype) as Harness;
  const settings: Record<string, unknown> = { favoriteChats: [], textExecutionBackend: "claude" };
  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(settings, patch); });
  Object.assign(view, {
    app: {
      scope: new Scope(),
      workspace: { requestSaveLayout: jest.fn(), getLeavesOfType: jest.fn(() => []), getMostRecentLeaf: () => null },
      vault: { getAbstractFileByPath: jest.fn() },
      fileManager: { trashFile: jest.fn(async () => undefined) },
    },
    plugin: { settings, getSettingsManager: () => ({ updateSettings }) },
    agent: options.agent === null ? { getSnapshot: () => ({ status: "idle" }) } : nativeAgent(options.agent ?? "claude"),
    chatId: options.messages ? "chat-1" : "",
    chatTitle: "Plan the Q4 launch",
    approvalMode: "auto",
    containerEl: document.body.createDiv(),
    transcript: { snapshot: () => ({ messages: Array.from({ length: options.messages ?? 0 }, () => ({})) }), idle: jest.fn(async () => undefined), setTitle: jest.fn() },
    chatStorage: { renameChat: jest.fn(async () => undefined) },
    contextManager: { getPinnedFiles: () => new Set(["Projects/Plan.md"]) },
    workspace: {
      setChrome: jest.fn(),
      announce: jest.fn(),
      setBanner: jest.fn(),
      setComposerReadOnly: jest.fn(),
      getInputText: () => "Carry this draft",
      getMessageAttachments: () => [{ id: "shot" }],
      isHistoryOpen: false,
      runLine: { openModeMenu: jest.fn(), openBackendMenu: jest.fn() },
    },
    startNewChat: jest.fn(async () => undefined),
    updateViewState: jest.fn(),
    saveChat: jest.fn(async () => undefined),
    logAgentError: jest.fn(),
    reportAgentError: jest.fn(),
    detection: null,
    switchedFrom: null,
    unavailableBackend: null,
    usedInVault: new Set(),
    codexModels: null,
    creditsBalance: null,
    claudeAutoUnavailable: false,
    detecting: false,
  });
  view.getInputText = () => "Carry this draft";
  view.getMessageAttachments = () => [{ id: "shot" } as never];
  return view;
}

describe("AgentChatView chrome wiring", () => {
  beforeEach(() => {
    host.localCli = true;
    confirm.confirmed = true;
    document.body.empty();
  });

  it("exports through the reachable chat menu using the real export service", async () => {
    const view = harness({ messages: 1 });
    view.chatVersion = 1;
    view.transcript.snapshot = () => ({ messages: [{ id: "message-1", role: "user", content: "My retained conversation" }] });
    view.transcript.chatPath = () => "Chats/chat-1.md";
    view.contextManager.getPinnedFiles = () => new Set();
    const exported = Object.assign(new TFile(), { path: "Notes/Plan the Q4 launch (export).md" });
    view.app.fileManager.getNewFileParent = () => ({ path: "Notes" });
    view.app.vault.create = jest.fn(async () => exported);
    let finishOpen!: () => void;
    const opened = new Promise<void>(resolve => { finishOpen = resolve; });
    const openFile = jest.fn(async () => { finishOpen(); });
    view.app.workspace.getLeaf = jest.fn(() => ({ openFile }));
    const menu = new Menu();
    (view as any).addChatMenuItems(menu);

    (menu as any).select("Export chat");
    await opened;

    expect(view.app.vault.create).toHaveBeenCalledWith(exported.path, expect.stringContaining("My retained conversation"));
    expect(openFile).toHaveBeenCalledWith(exported);
    expect(view.app.workspace.getLeaf).toHaveBeenCalledWith("tab");
  });

  it("starts a new chat when the backend changes in a chat with messages, carrying the draft", async () => {
    const view = harness({ messages: 2 });
    await (view as any).selectBackend("codex");
    expect(view.plugin.getSettingsManager().updateSettings)
      .toHaveBeenCalledWith({ textExecutionBackend: "codex", textExecutionBackendExplicit: true });
    expect(view.startNewChat).toHaveBeenCalledWith(true, undefined, undefined, {
      backend: "codex",
      carry: { pinned: ["Projects/Plan.md"] },
      switchedFrom: "chat-1",
    });
    expect(view.workspace.announce).toHaveBeenCalledWith("Started a new chat with Codex");
  });

  it.each(["claude", "codex", null] as const)("announces an explicit new chat with %s exactly once", async (agent) => {
    const view = harness({ agent });
    await view.newChat();
    expect(view.startNewChat).toHaveBeenCalledWith(true);
    expect(view.workspace.announce.mock.calls).toEqual([[`Started a new chat with ${agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "SystemSculpt"}`]]);
  });

  it("does not announce a new chat superseded by another conversation", async () => {
    const view = harness();
    let finish!: () => void;
    view.startNewChat.mockImplementation(() => {
      view.conversationOriginToken = "new-chat";
      return new Promise<void>(resolve => { finish = resolve; });
    });
    const started = view.newChat();
    view.conversationOriginToken = "restored-chat";
    finish();
    await started;
    expect(view.workspace.announce).not.toHaveBeenCalled();
  });

  it("does not announce a new chat when creating it fails", async () => {
    const view = harness();
    view.startNewChat.mockRejectedValue(new Error("Could not save"));
    await expect(view.newChat()).rejects.toThrow("Could not save");
    expect(view.workspace.announce).not.toHaveBeenCalled();
  });

  it("switches an empty chat in place and leaves a matching backend alone", async () => {
    const empty = harness();
    await (empty as any).selectBackend("systemsculpt");
    expect(empty.startNewChat).toHaveBeenCalledWith(true, undefined, undefined, expect.not.objectContaining({ switchedFrom: expect.anything() }));
    expect(empty.workspace.announce).toHaveBeenCalledWith("Switched to SystemSculpt");

    const same = harness({ messages: 2 });
    await (same as any).selectBackend("claude");
    expect(same.startNewChat).not.toHaveBeenCalled();
  });

  it("never offers a local agent on mobile", async () => {
    host.localCli = false;
    const view = harness({ agent: null });
    await (view as any).selectBackend("claude");
    expect(view.plugin.getSettingsManager().updateSettings).not.toHaveBeenCalled();
    expect(view.startNewChat).not.toHaveBeenCalled();
  });

  it("saves each backend's mode where that backend reads it, without a new chat", async () => {
    const claude = harness();
    await (claude as any).selectMode("plan");
    expect(claude.plugin.settings.claudePermissionMode).toBe("plan");
    expect(claude.workspace.announce).toHaveBeenCalledWith("Switched to Plan only");

    const codex = harness({ agent: "codex" });
    await (codex as any).selectMode("read-only");
    expect(codex.plugin.settings.codexApprovalMode).toBe("read-only");

    const hosted = harness({ agent: null, messages: 1 });
    await (hosted as any).selectMode("full-access");
    expect(hosted.approvalMode).toBe("full-access");
    expect(hosted.startNewChat).not.toHaveBeenCalled();
    await (hosted as any).selectMode("not-a-mode");
    expect(hosted.approvalMode).toBe("full-access");
  });

  it("keeps a thinking level the new Codex model supports", async () => {
    const view = harness({ agent: "codex" });
    Object.assign(view.plugin.settings, { codexModel: "gpt-6.1", codexThinkingLevel: "low", codexServiceTier: "default" });
    view.codexModels = [
      { model: "gpt-6.1", name: "GPT-6.1", efforts: ["low", "high"], defaultEffort: "high" },
      { model: "mini", name: "Mini", efforts: ["medium"], defaultEffort: "medium" },
    ];
    await (view as any).changeAgentModel("model:mini");
    expect(view.plugin.settings).toMatchObject({ codexModel: "mini", codexThinkingLevel: "medium" });
    await (view as any).changeAgentModel("effort:medium");
    await (view as any).changeAgentModel("tier:priority");
    expect(view.plugin.settings).toMatchObject({ codexThinkingLevel: "medium", codexServiceTier: "priority" });
  });

  it("binds its keys to the view's scope only", () => {
    const view = harness();
    (view as any).registerViewKeys();
    const keys = (view.scope as unknown as { keys: Array<{ modifiers: string[]; key: string | null; func: (event: KeyboardEvent) => unknown }> }).keys;
    expect(keys.map(({ modifiers, key }) => `${modifiers.join("+")}+${key}`))
      .toEqual(["Mod+k", "Mod+Shift+o", "Mod+null", "Mod+Shift+null"]);
    expect((view.scope as unknown as { parent: unknown }).parent).toBe(view.app.scope);
    const [, , mode, backend] = keys;
    expect(mode.func(new KeyboardEvent("keydown", { key: ":", code: "Period", metaKey: true }))).toBe(false);
    expect(view.workspace.runLine.openModeMenu).toHaveBeenCalledTimes(1);
    expect(backend.func(new KeyboardEvent("keydown", { key: ">", code: "Period", metaKey: true, shiftKey: true }))).toBe(false);
    expect(view.workspace.runLine.openBackendMenu).toHaveBeenCalledTimes(1);
    expect(mode.func(new KeyboardEvent("keydown", { key: ".", code: "NumpadDecimal", metaKey: true }))).toBeUndefined();
    expect(view.workspace.runLine.openModeMenu).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Search chats", 0, { key: "k", metaKey: true }, "history"],
    ["New chat", 1, { key: "O", metaKey: true, shiftKey: true }, "new"],
    ["Change mode", 2, { key: ".", code: "Period", metaKey: true }, "mode"],
    ["Change backend", 3, { key: ">", code: "Period", metaKey: true, shiftKey: true }, "backend"],
  ] as const)("keyboard map 6.1: %s dispatches only its view action", (_label, index, event, action) => {
    const view = harness();
    const actions = {
      history: jest.fn(), new: jest.fn(),
      mode: view.workspace.runLine.openModeMenu,
      backend: view.workspace.runLine.openBackendMenu,
    };
    view.openChatHistory = actions.history;
    view.newChat = actions.new;
    (view as any).registerViewKeys();
    const keys = (view.scope as unknown as { keys: Array<{ func: (event: KeyboardEvent) => unknown }> }).keys;
    expect(keys[index].func(new KeyboardEvent("keydown", event))).toBe(false);
    for (const [name, callback] of Object.entries(actions)) {
      expect(callback).toHaveBeenCalledTimes(name === action ? 1 : 0);
    }
  });

  it("makes a saved chat read-only where its agent cannot run, and writable again once it can", () => {
    host.localCli = false;
    const mobile = harness({ messages: 2 });
    mobile.chatExecutionBackend = "codex";
    (mobile as any).applyBackendAvailability();
    expect(mobile.workspace.setComposerReadOnly).toHaveBeenCalledWith("Codex isn't available on this device.");
    expect(mobile.workspace.setBanner).toHaveBeenCalledWith(
      "This chat ran on Codex. Codex isn't available on this device, so this chat is read-only here.",
      "info",
      expect.objectContaining({ label: "New chat", testId: "chat.banner.new-chat" }),
    );

    host.localCli = true;
    const desktop = harness({ messages: 2 });
    desktop.chatExecutionBackend = "claude";
    desktop.detection = {
      preferred: "systemsculpt",
      agents: {
        claude: { installed: false, signedIn: false, recentSessionCount: 0, lastUsed: null },
        codex: { installed: false, signedIn: false, recentSessionCount: 0, lastUsed: null },
      },
    };
    (desktop as any).applyBackendAvailability();
    expect(desktop.workspace.setBanner).toHaveBeenLastCalledWith(
      "This chat ran on Claude Code. Claude Code isn't available on this computer, so this chat is read-only here.",
      "info",
      expect.anything(),
    );
    desktop.detection.agents.claude = { installed: true, signedIn: false, recentSessionCount: 0, lastUsed: null };
    (desktop as any).applyBackendAvailability();
    expect(desktop.workspace.setComposerReadOnly).toHaveBeenLastCalledWith(null);
    expect(desktop.workspace.setBanner).toHaveBeenLastCalledWith(null);
  });

  it("deletes a chat from history only after confirmation, and resets views that show it", async () => {
    const view = harness({ messages: 2 });
    const file = Object.assign(new TFile(), { path: "SystemSculpt/Chats/chat-1.md" });
    view.app.vault.getAbstractFileByPath.mockReturnValue(file);
    view.app.workspace.getLeavesOfType.mockReturnValue([{ view }]);
    const row = { chatId: "chat-1", title: "Plan", chatPath: file.path, timestampMs: 1, backend: "claude", favorite: false };

    confirm.confirmed = false;
    await expect((view as any).deleteSavedChat(row)).resolves.toBe(false);
    expect(view.app.fileManager.trashFile).not.toHaveBeenCalled();

    confirm.confirmed = true;
    await expect((view as any).deleteSavedChat(row)).resolves.toBe(true);
    expect(view.app.fileManager.trashFile).toHaveBeenCalledWith(file);
    expect(view.startNewChat).toHaveBeenCalledWith(false);
  });

  it("drains cancellation output and pending physical writes before trashing a chat", async () => {
    const view = harness({ messages: 2 });
    const file = Object.assign(new TFile(), { path: "SystemSculpt/Chats/chat-1.md" });
    view.app.vault.getAbstractFileByPath.mockReturnValue(file);
    view.app.workspace.getLeavesOfType.mockReturnValue([{ view }]);
    const order: string[] = [];
    let finishWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    view.startNewChat.mockImplementation(async () => { order.push("cancel persisted; reset"); });
    view.transcript.idle.mockImplementation(async () => {
      await pendingWrite;
      order.push("physical write finished");
    });
    view.app.fileManager.trashFile.mockImplementation(async () => { order.push("trash"); });
    const deleting = (view as any).deleteSavedChat({ chatId: "chat-1", title: "Plan", chatPath: file.path, favorite: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.app.fileManager.trashFile).not.toHaveBeenCalled();
    finishWrite();
    await expect(deleting).resolves.toBe(true);
    expect(order).toEqual(["cancel persisted; reset", "physical write finished", "trash"]);
  });

  it("does not trash the chat if detaching its writer fails", async () => {
    const notice = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const view = harness({ messages: 2 });
    view.app.workspace.getLeavesOfType.mockReturnValue([{ view }]);
    view.startNewChat.mockRejectedValueOnce(new Error("Could not detach"));
    await expect((view as any).deleteSavedChat({ chatId: "chat-1", title: "Plan", chatPath: "x.md", favorite: false })).resolves.toBe(false);
    expect(view.app.fileManager.trashFile).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith("Notice: This chat couldn't be deleted.");
    notice.mockRestore();
  });

  it("starts the welcome's own sign-up and sign-in handoffs from the empty state", () => {
    const openConnect = jest.spyOn(UpgradePlanModal, "openConnect").mockImplementation(() => ({}) as UpgradePlanModal);
    try {
      const view = harness({ agent: null });
      (view as any).handleEmptyStateAction("start-free");
      (view as any).handleEmptyStateAction("sign-in");
      expect(openConnect.mock.calls.map(([, mode]) => mode)).toEqual(["sign-up", "sign-in"]);
      expect(openConnect).toHaveBeenCalledWith(view.plugin, "sign-up", { feature: "Chat" });
    } finally {
      openConnect.mockRestore();
    }
  });

  it("goes back to the chat a backend switch left", async () => {
    const view = harness();
    view.switchedFrom = { chatId: "previous-chat" };
    view.loadChatById = jest.fn(async () => undefined);
    view.workspace.focus = jest.fn();
    (view as any).handleEmptyStateAction("back-to-previous");
    await Promise.resolve();
    expect(view.loadChatById).toHaveBeenCalledWith("previous-chat");
  });

  it("renames the durable title once and updates all open copies without saving their transcripts", async () => {
    const view = harness({ messages: 4 });
    const stale = harness({ messages: 2 });
    view.app.workspace.getLeavesOfType.mockReturnValue([{ view }, { view: stale }]);
    view.setTitle = jest.fn(async () => undefined);
    stale.setTitle = jest.fn(async () => undefined);
    await (view as any).renameSavedChat({ chatId: "chat-1", title: "Old", chatPath: "x.md" }, "New title");
    expect(view.setTitle).toHaveBeenCalledWith("New title", false);
    expect(stale.setTitle).toHaveBeenCalledWith("New title", false);
    expect(view.transcript.idle).toHaveBeenCalledTimes(1);
    expect(stale.transcript.idle).toHaveBeenCalledTimes(1);
    expect(view.chatStorage.renameChat).toHaveBeenCalledTimes(1);
    expect(view.chatStorage.renameChat).toHaveBeenCalledWith("x.md", "chat-1", "New title");
  });
});

describe("chat palette commands", () => {
  it("adds the spec 6.1 commands without default hotkeys", () => {
    const commands: Array<{ id: string; name: string; hotkeys?: unknown }> = [];
    const plugin = { addCommand: (command: { id: string; name: string }) => commands.push(command) };
    const manager = Object.create(CommandManager.prototype) as CommandManager & Record<string, any>;
    Object.assign(manager, { plugin, app: { workspace: {} }, ribbonManager: {} });
    manager.registerChatCommands();
    expect(commands.map((command) => command.name)).toEqual([
      "Chat: New chat",
      "Chat: Open chat history",
      "Chat: Focus message box",
      "Chat: Stop response",
      "Chat: Change mode",
      "Chat: Change backend",
      "Chat: Review pending approval",
    ]);
    expect(commands.every((command) => command.hotkeys === undefined)).toBe(true);
  });
});
