/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { MeetingProcessorModal } from "../MeetingProcessorModal";

const createAudioFile = (path: string, mtime: number) => {
  return new TFile({ path, stat: { mtime } });
};

const createNoteFile = (path: string, mtime: number) => {
  return new TFile({ path, stat: { mtime } });
};

const createMockPlugin = (params: {
  audioFiles: TFile[];
  outputFilesByPath?: Record<string, TFile>;
  settings?: Partial<Record<string, any>>;
}) => {
  const app = new App();

  (app.vault.getFiles as jest.Mock).mockReturnValue(params.audioFiles);

  const outputFilesByPath = params.outputFilesByPath || {};
  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
    return outputFilesByPath[path] ?? null;
  });

  return {
    app,
    settings: {
      meetingProcessorOutputDirectory: "SystemSculpt/Extractions",
      meetingProcessorOutputNameTemplate: "{{basename}}-processed.md",
      ...params.settings,
    },
  } as any;
};

describe("MeetingProcessorModal", () => {
  it("renders processed status badges for vault audio files", () => {
    const audioProcessed = createAudioFile("Audio/processed.m4a", 100);
    const audioStale = createAudioFile("Audio/stale.m4a", 200);
    const audioUnprocessed = createAudioFile("Audio/unprocessed.m4a", 300);

    const plugin = createMockPlugin({
      audioFiles: [audioProcessed, audioStale, audioUnprocessed],
      outputFilesByPath: {
        "SystemSculpt/Extractions/processed-processed.md": createNoteFile(
          "SystemSculpt/Extractions/processed-processed.md",
          150
        ),
        "SystemSculpt/Extractions/stale-processed.md": createNoteFile(
          "SystemSculpt/Extractions/stale-processed.md",
          50
        ),
      },
    });

    const modal = new MeetingProcessorModal(plugin);
    modal.onOpen();

    const listEl = (modal as any).listEl as HTMLElement;
    const statusBadges = Array.from(
      listEl.querySelectorAll<HTMLElement>(".ss-meeting-processor__file-badge--status")
    );

    expect(statusBadges.map((el) => el.textContent?.trim())).toEqual(
      expect.arrayContaining(["Processed", "Out of date", "Unprocessed"])
    );
  });

  it("filters files by processed status", () => {
    const audioProcessed = createAudioFile("Audio/processed.m4a", 100);
    const audioUnprocessed = createAudioFile("Audio/unprocessed.m4a", 200);

    const plugin = createMockPlugin({
      audioFiles: [audioProcessed, audioUnprocessed],
      outputFilesByPath: {
        "SystemSculpt/Extractions/processed-processed.md": createNoteFile(
          "SystemSculpt/Extractions/processed-processed.md",
          150
        ),
      },
    });

    const modal = new MeetingProcessorModal(plugin);
    modal.onOpen();

    const processedButton = (modal as any).filterButtons.processed as HTMLButtonElement;
    processedButton.click();

    const listEl = (modal as any).listEl as HTMLElement;
    const rowsAfterProcessed = Array.from(
      listEl.querySelectorAll<HTMLElement>(".ss-meeting-processor__file")
    );
    expect(rowsAfterProcessed).toHaveLength(1);
    expect(
      listEl.querySelector(".ss-meeting-processor__file-badge--status")?.textContent?.trim()
    ).toBe("Processed");

    const unprocessedButton = (modal as any).filterButtons.unprocessed as HTMLButtonElement;
    unprocessedButton.click();

    const rowsAfterUnprocessed = Array.from(
      listEl.querySelectorAll<HTMLElement>(".ss-meeting-processor__file")
    );
    expect(rowsAfterUnprocessed).toHaveLength(1);
    expect(
      listEl.querySelector(".ss-meeting-processor__file-badge--status")?.textContent?.trim()
    ).toBe("Unprocessed");
  });
});

