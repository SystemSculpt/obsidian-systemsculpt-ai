/** @jest-environment jsdom */

import { Scope, TFile } from "obsidian";

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
    transcript: { snapshot: () => ({ messages: Array.from({ length: options.messages ?? 0 }, () => ({})) }) },
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

  it("starts a new chat when the backend changes in a chat with messages, carrying the draft", async () => {
    const view = harness({ messages: 2 });
    await (view as any).selectBackend("codex");
    expect(view.plugin.getSettingsManager().updateSettings)
      .toHaveBeenCalledWith({ textExecutionBackend: "codex", textExecutionBackendExplicit: true });
    expect(view.startNewChat).toHaveBeenCalledWith(true, undefined, undefined, {
      backend: "codex",
      carry: { text: "Carry this draft", attachments: [{ id: "shot" }], pinned: ["Projects/Plan.md"] },
      switchedFrom: "chat-1",
    });
    expect(view.workspace.announce).toHaveBeenCalledWith("Started a new chat with Codex");
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
    const keys = (view.scope as unknown as { keys: Array<{ modifiers: string[]; key: string }> }).keys;
    expect(keys.map(({ modifiers, key }) => `${modifiers.join("+")}+${key}`))
      .toEqual(["Mod+k", "Mod+Shift+o", "Mod+.", "Mod+Shift+."]);
    expect((view.scope as unknown as { parent: unknown }).parent).toBe(view.app.scope);
    const [, , mode, backend] = (view.scope as unknown as { keys: Array<{ func: () => unknown }> }).keys;
    expect(mode.func()).toBe(false);
    expect(view.workspace.runLine.openModeMenu).toHaveBeenCalledTimes(1);
    expect(backend.func()).toBe(false);
    expect(view.workspace.runLine.openBackendMenu).toHaveBeenCalledTimes(1);
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

  it("renames an open chat through its view", async () => {
    const view = harness({ messages: 2 });
    view.app.workspace.getLeavesOfType.mockReturnValue([{ view }]);
    view.setTitle = jest.fn(async () => undefined);
    await (view as any).renameSavedChat({ chatId: "chat-1", title: "Old", chatPath: "x.md", timestampMs: 1, backend: "claude", favorite: false }, "New title");
    expect(view.setTitle).toHaveBeenCalledWith("New title");
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
