/** @jest-environment jsdom */

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  Notice: jest.fn(),
}));

import { App, Notice, TFile } from "obsidian";
import { CommandManager } from "../commands";

const openMock = jest.fn();
const modalCtorMock = jest.fn().mockImplementation(() => ({ open: openMock }));
const resumeMock = jest.fn().mockResolvedValue(undefined);
const availabilityMock = jest.fn().mockResolvedValue(true);
const artifactOpenMock = jest.fn().mockResolvedValue(undefined);
const saveArtifactForJobMock = jest.fn().mockResolvedValue({
  notePath: "SystemSculpt/Audio Notes/Product sync Transcript.md",
  open: artifactOpenMock,
});
const serviceCtorMock = jest.fn().mockImplementation(() => ({
  saveArtifactForJob: saveArtifactForJobMock,
}));

jest.mock("../../../features/audio-processor", () => ({
  AudioProcessorModal: modalCtorMock,
  AudioProcessorService: serviceCtorMock,
  canOpenAudioProcessor: availabilityMock,
  resumeAudioProcessorJobs: resumeMock,
}));

describe("CommandManager Audio Processor commands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    availabilityMock.mockResolvedValue(true);
  });

  it("registers both source entry points and resumes server-owned jobs", async () => {
    const addCommand = jest.fn();
    const plugin = { addCommand } as any;
    const app = new App();
    const manager = new CommandManager(plugin, app);

    (manager as any).registerAudioProcessorCommands();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const commands = addCommand.mock.calls.map(([command]) => command);
    expect(commands.map((command) => command.id)).toEqual([
      "open-audio-processor",
      "process-youtube-video",
      "save-audio-summary",
      "save-audio-transcript",
    ]);
    expect(resumeMock).toHaveBeenCalledWith(plugin);

    await commands[0].callback();
    expect(availabilityMock).toHaveBeenNthCalledWith(1, plugin);
    expect(modalCtorMock).toHaveBeenLastCalledWith(plugin, { initialTab: "audio" });
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenLastCalledWith(plugin, { notifyOnDiscoveryFailure: true });

    await commands[1].callback();
    expect(availabilityMock).toHaveBeenNthCalledWith(2, plugin);
    expect(modalCtorMock).toHaveBeenLastCalledWith(plugin, { initialTab: "youtube" });
    expect(openMock).toHaveBeenCalledTimes(2);

    const audioNote = new (TFile as any)({
      path: "SystemSculpt/Audio Notes/Product sync.md",
      name: "Product sync.md",
      extension: "md",
      stat: { size: 200, ctime: 1, mtime: 1 },
    }) as TFile;
    (app.workspace.getActiveFile as jest.Mock).mockReturnValue(audioNote);
    (app.metadataCache.getFileCache as jest.Mock).mockReturnValue({
      frontmatter: {
        "systemsculpt-audio-job-id": "audio_job_original",
        "systemsculpt-audio-delivery-job-id": "audio_job_authenticated_alias",
        "systemsculpt-audio-artifact": "full",
      },
    });

    expect(commands[2].checkCallback(false)).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(serviceCtorMock).toHaveBeenCalledWith(plugin);
    expect(saveArtifactForJobMock).toHaveBeenNthCalledWith(
      1,
      "audio_job_authenticated_alias",
      "audio_job_original",
      "summary",
    );

    expect(commands[3].checkCallback(false)).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(saveArtifactForJobMock).toHaveBeenCalledWith(
      "audio_job_authenticated_alias",
      "audio_job_original",
      "transcript",
    );
    expect(artifactOpenMock).toHaveBeenCalledTimes(2);
  });

  it("hides durable artifact commands outside a saved Audio Processor note", () => {
    const addCommand = jest.fn();
    const plugin = { addCommand } as any;
    const manager = new CommandManager(plugin, new App());

    (manager as any).registerAudioProcessorCommands();
    const commands = addCommand.mock.calls.map(([command]) => command);

    expect(commands[2].checkCallback(true)).toBe(false);
    expect(commands[3].checkCallback(true)).toBe(false);
  });

  it("shows an availability notice instead of opening when the hosted processor is explicitly unavailable", async () => {
    availabilityMock.mockResolvedValue(false);

    const addCommand = jest.fn();
    const plugin = { addCommand } as any;
    const app = new App();
    const manager = new CommandManager(plugin, app);

    (manager as any).registerAudioProcessorCommands();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const commands = addCommand.mock.calls.map(([command]) => command);

    await commands[0].callback();
    await commands[1].callback();

    expect(availabilityMock).toHaveBeenNthCalledWith(1, plugin);
    expect(availabilityMock).toHaveBeenNthCalledWith(2, plugin);
    expect(modalCtorMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledTimes(2);
    expect(Notice).toHaveBeenCalledWith("Audio Processor is temporarily unavailable.", 6000);
  });
});
