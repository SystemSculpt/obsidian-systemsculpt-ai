/** @jest-environment jsdom */

import { App, Notice, TFile } from "obsidian";
import { CommandManager } from "../commands";
import { CHAT_VIEW_TYPE } from "../viewTypes";
import { tryCopyToClipboard } from "../../../utils/clipboard";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));
jest.mock("../../../utils/clipboard", () => ({ tryCopyToClipboard: jest.fn() }));

function registerCommands() {
  const app = new App();
  const plugin = {
    addCommand: jest.fn(),
    settings: {},
    getLogger: jest.fn(),
    getRecorderService: jest.fn(),
    getViewManager: jest.fn(),
    getPluginUpdateService: jest.fn(),
    getInboxTranscriptionService: jest.fn(),
    getResourceMonitor: jest.fn(),
  } as any;
  new CommandManager(plugin, app).registerCommands();
  const commands = plugin.addCommand.mock.calls.map(([command]: any[]) => command);
  const command = (id: string) => {
    const matches = commands.filter((registered: any) => registered.id === id);
    expect(matches).toHaveLength(1);
    return matches[0];
  };
  return { app, plugin, commands, command };
}

describe("CommandManager command surface contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers each current command once without retired or redundant entries", () => {
    const { commands } = registerCommands();
    const registeredIds = commands.map((command: any) => command.id);

    expect(new Set(registeredIds).size).toBe(registeredIds.length);
    expect(registeredIds).toEqual(expect.arrayContaining([
      "open-systemsculpt-chat",
      "toggle-audio-recorder",
      "change-chat-title",
      "open-embeddings-view",
      "check-for-updates",
      "resume-inbox-transcription",
      "systemsculpt-copy-resource-report",
    ]));
    expect(registeredIds).not.toEqual(expect.arrayContaining(["reload-obsidian"]));
    for (const retired of [
      "find-similar-current-note",
      "change-chat-model",
      "set-default-chat-model",
      "open-template-modal",
      "daily-vault-open-today",
      "daily-vault-create-note",
      "daily-vault-open-settings",
    ]) {
      expect(registeredIds).not.toContain(retired);
    }
  });

  it("does not initialize services or views while registering commands", () => {
    const { plugin } = registerCommands();

    expect(plugin.getLogger).not.toHaveBeenCalled();
    expect(plugin.getRecorderService).not.toHaveBeenCalled();
    expect(plugin.getViewManager).not.toHaveBeenCalled();
    expect(plugin.getPluginUpdateService).not.toHaveBeenCalled();
    expect(plugin.getInboxTranscriptionService).not.toHaveBeenCalled();
    expect(plugin.getResourceMonitor).not.toHaveBeenCalled();
  });

  it("uses the existing ribbon manager's owned recorder action", async () => {
    const { plugin, command } = registerCommands();
    const toggleAudioRecorder = jest.fn().mockResolvedValue(undefined);
    plugin.getViewManager.mockReturnValue({ ribbonManager: { toggleAudioRecorder } });

    await command("toggle-audio-recorder").callback();

    expect(plugin.getViewManager).toHaveBeenCalledTimes(1);
    expect(toggleAudioRecorder).toHaveBeenCalledTimes(1);
    expect(plugin.getRecorderService).not.toHaveBeenCalled();
  });

  it("runs manual update checks through the lazy service only when chosen", () => {
    const { plugin, command } = registerCommands();
    const checkForUpdates = jest.fn().mockResolvedValue({ outcome: "up_to_date" });
    plugin.getPluginUpdateService.mockReturnValue({ checkForUpdates });

    command("check-for-updates").callback();

    expect(plugin.getPluginUpdateService).toHaveBeenCalledTimes(1);
    expect(checkForUpdates).toHaveBeenCalledWith({ manual: true });
  });

  it("keeps inbox resume hidden until an existing service has waiting files", () => {
    const { plugin, command } = registerCommands();
    const resume = command("resume-inbox-transcription");
    plugin.getInboxTranscriptionService.mockReturnValue(null);
    expect(resume.checkCallback(true)).toBe(false);
    expect(resume.checkCallback(false)).toBe(false);

    const canResumeDeferredFiles = jest.fn().mockReturnValue(false);
    const resumeDeferredFiles = jest.fn().mockResolvedValue(undefined);
    plugin.getInboxTranscriptionService.mockReturnValue({ canResumeDeferredFiles, resumeDeferredFiles });
    expect(resume.checkCallback(true)).toBe(false);
    expect(resume.checkCallback(false)).toBe(false);
    expect(resumeDeferredFiles).not.toHaveBeenCalled();

    canResumeDeferredFiles.mockReturnValue(true);
    expect(resume.checkCallback(true)).toBe(true);
    expect(resumeDeferredFiles).not.toHaveBeenCalled();
    expect(resume.checkCallback(false)).toBe(true);
    expect(resumeDeferredFiles).toHaveBeenCalledTimes(1);
  });

  it("captures and copies a resource report only when requested", async () => {
    const { plugin, command } = registerCommands();
    const monitor = {
      captureManualSample: jest.fn().mockResolvedValue(undefined),
      exportSummaryReport: jest.fn().mockResolvedValue({ summary: "Resource summary", path: "report.md" }),
    };
    plugin.getResourceMonitor.mockReturnValue(monitor);
    jest.mocked(tryCopyToClipboard).mockResolvedValue(true);

    await command("systemsculpt-copy-resource-report").callback();

    expect(monitor.captureManualSample).toHaveBeenCalledWith("command");
    expect(monitor.exportSummaryReport).toHaveBeenCalledTimes(1);
    expect(tryCopyToClipboard).toHaveBeenCalledWith("Resource summary");
    expect(Notice).not.toHaveBeenCalled();
  });

  it("preserves the resource monitor's startup fallback", async () => {
    const { plugin, command } = registerCommands();
    plugin.getResourceMonitor.mockReturnValue(null);

    await command("systemsculpt-copy-resource-report").callback();

    expect(Notice).toHaveBeenCalledWith("Resource monitor is still starting up.");
    expect(tryCopyToClipboard).not.toHaveBeenCalled();
  });

  it.each([
    ["report.md", "Resource report saved to report.md."],
    [undefined, "Unable to copy the report. See .systemsculpt/diagnostics."],
  ])("preserves the resource report clipboard fallback (%s)", async (path, message) => {
    const { plugin, command } = registerCommands();
    plugin.getResourceMonitor.mockReturnValue({
      captureManualSample: jest.fn().mockResolvedValue(undefined),
      exportSummaryReport: jest.fn().mockResolvedValue({ summary: "Resource summary", path }),
    });
    jest.mocked(tryCopyToClipboard).mockResolvedValue(false);

    await command("systemsculpt-copy-resource-report").callback();

    expect(Notice).toHaveBeenCalledWith(message, 5000);
  });

  it("opens Similar notes through the existing view manager", async () => {
    const { plugin, command } = registerCommands();
    const activateEmbeddingsView = jest.fn().mockResolvedValue(undefined);
    plugin.getViewManager.mockReturnValue({ activateEmbeddingsView });

    await command("open-embeddings-view").callback();

    expect(activateEmbeddingsView).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null, false],
    ["md", true],
    ["systemsculpt", true],
    ["pdf", false],
  ] as const)("preserves the title command's file context condition (%s)", (extension, expected) => {
    const { app, command } = registerCommands();
    (app.workspace.getActiveFile as jest.Mock).mockReturnValue(
      extension ? new TFile({ path: `file.${extension}`, extension }) : null,
    );

    expect(command("change-chat-title").checkCallback(true)).toBe(expected);
    expect(Notice).not.toHaveBeenCalled();
  });

  it.each([0, 1])("offers title creation only for a nonempty active chat (%s messages)", (messageCount) => {
    const { app, command } = registerCommands();
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue({
      getViewType: () => CHAT_VIEW_TYPE,
      messageCount,
    });

    expect(command("change-chat-title").checkCallback(true)).toBe(messageCount > 0);
    expect(Notice).not.toHaveBeenCalled();
  });

  it.each([
    ["pdf", true],
    ["png", true],
    ["webp", true],
    ["svg", false],
    ["mp3", true],
    ["doc", false],
    ["docx", false],
    ["pptx", false],
    ["xlsx", false],
  ] as const)("advertises Chat with File for %s only when the active route is supported", (extension, expected) => {
    const { app, command } = registerCommands();
    (app.workspace.getActiveFile as jest.Mock).mockReturnValue(new TFile({ path: `file.${extension}`, extension }));

    expect(command("chat-with-file").checkCallback(true)).toBe(expected);
  });
});
