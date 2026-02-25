/** @jest-environment jsdom */

import { App } from "obsidian";
import { CommandManager } from "../commands";

const openMock = jest.fn();
const modalCtorMock = jest.fn().mockImplementation(() => ({
  open: openMock,
}));

jest.mock("../../../modals/TranscribeAudioFileModal", () => ({
  TranscribeAudioFileModal: modalCtorMock,
}));

describe("CommandManager transcribe-audio-file command", () => {
  beforeEach(() => {
    openMock.mockReset();
    modalCtorMock.mockClear();
  });

  it("registers and opens the transcribe-audio-file modal", async () => {
    const addCommand = jest.fn();
    const plugin = {
      addCommand,
    } as any;

    const manager = new CommandManager(plugin, new App());
    (manager as any).registerTranscribeAudioFile();

    expect(addCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "transcribe-audio-file",
        name: "Transcribe an audio file",
        callback: expect.any(Function),
      })
    );

    const registered = addCommand.mock.calls[0]?.[0];
    await registered.callback();

    expect(modalCtorMock).toHaveBeenCalledWith(plugin);
    expect(openMock).toHaveBeenCalledTimes(1);
  });
});
