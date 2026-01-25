/**
 * @jest-environment jsdom
 */
import { TFile } from "obsidian";
import { runAudioAnalysis } from "../RunAudioAnalysis";

// Track Notice calls
const noticeCalls: string[] = [];

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn().mockImplementation((message: string) => {
      noticeCalls.push(message);
      return new actual.Notice(message);
    }),
  };
});

describe("runAudioAnalysis", () => {
  let mockApp: any;
  let mockPlugin: any;
  let mockFile: TFile;
  let mockOpenFile: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    noticeCalls.length = 0;

    mockFile = new TFile({ path: "AudioChunkingAnalysis-test.md" });
    mockOpenFile = jest.fn().mockResolvedValue(undefined);

    mockApp = {
      vault: {
        create: jest.fn().mockResolvedValue(undefined),
        getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
      },
      workspace: {
        getLeaf: jest.fn().mockReturnValue({
          openFile: mockOpenFile,
        }),
      },
    };

    mockPlugin = {
      app: mockApp,
    };
  });

  it("shows initial notice about running analysis", async () => {
    await runAudioAnalysis(mockPlugin);

    expect(noticeCalls).toContain("Running audio chunking analysis...");
  });

  it("creates a file with timestamped name", async () => {
    await runAudioAnalysis(mockPlugin);

    const createCall = (mockApp.vault.create as jest.Mock).mock.calls[0];
    expect(createCall[0]).toMatch(/^AudioChunkingAnalysis-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    expect(createCall[0]).toMatch(/\.md$/);
  });

  it("creates file with disabled functionality message", async () => {
    await runAudioAnalysis(mockPlugin);

    const createCall = (mockApp.vault.create as jest.Mock).mock.calls[0];
    expect(createCall[1]).toContain("disabled");
  });

  it("shows completion notice with file path", async () => {
    await runAudioAnalysis(mockPlugin);

    const completionNotice = noticeCalls.find((msg) =>
      /Analysis complete\. Results saved to AudioChunkingAnalysis-/.test(msg)
    );
    expect(completionNotice).toBeDefined();
  });

  it("opens the created file", async () => {
    await runAudioAnalysis(mockPlugin);

    expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalled();
    expect(mockOpenFile).toHaveBeenCalledWith(mockFile);
  });

  it("handles file not being TFile instance", async () => {
    mockApp.vault.getAbstractFileByPath = jest.fn().mockReturnValue({
      path: "folder",
    }); // Not a TFile

    await runAudioAnalysis(mockPlugin);

    // Should not throw and should not try to open
    expect(mockApp.vault.create).toHaveBeenCalled();
  });

  it("handles null from getAbstractFileByPath", async () => {
    mockApp.vault.getAbstractFileByPath = jest.fn().mockReturnValue(null);

    await expect(runAudioAnalysis(mockPlugin)).resolves.not.toThrow();
  });

  it("shows error notice when vault.create fails", async () => {
    const error = new Error("Failed to create file");
    mockApp.vault.create = jest.fn().mockRejectedValue(error);

    await runAudioAnalysis(mockPlugin);

    // Check that some notice was called with error message
    const hasErrorNotice = noticeCalls.some((msg) =>
      msg.includes("Error running analysis")
    );
    expect(hasErrorNotice).toBe(true);
  });

  it("handles non-Error thrown values", async () => {
    mockApp.vault.create = jest.fn().mockRejectedValue("string error");

    await runAudioAnalysis(mockPlugin);

    // Check that some notice was called with error
    const hasErrorNotice = noticeCalls.some((msg) => msg.includes("Error"));
    expect(hasErrorNotice).toBe(true);
  });
});
