/** @jest-environment jsdom */

import type SystemSculptPlugin from "../../../main";
import { AudioProcessorPanel } from "../AudioProcessorPanel";
import type { AudioProcessorCompletedNote } from "../types";

const actionButton = (label: string): HTMLButtonElement => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(
    ".systemsculpt-progress-button",
  )).find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing progress action: ${label}`);
  return button;
};

describe("AudioProcessorPanel", () => {
  afterEach(() => {
    document.body.empty();
    jest.restoreAllMocks();
  });

  it("distinguishes cancelling an upload from stopping local observation of server work", () => {
    const onCancel = jest.fn();
    const plugin = { register: jest.fn() } as unknown as SystemSculptPlugin;
    const panel = new AudioProcessorPanel(plugin, "audio.m4a", onCancel);

    panel.update({ stage: "uploading", progress: 0.2, message: "Uploading audio…" });
    actionButton("Cancel upload").click();
    expect(onCancel).toHaveBeenCalledTimes(1);

    panel.update({
      stage: "uploading",
      progress: 0.4,
      message: "Receiving audio…",
      serverOwned: true,
    });
    expect(actionButton("Stop watching")).toBeTruthy();

    panel.update({ stage: "transcribing", progress: 0.6, message: "Transcribing…" });
    expect(actionButton("Stop watching")).toBeTruthy();
    panel.fail(new DOMException("Stopped", "AbortError"));

    expect(document.body.textContent).toContain("Stopped watching audio progress");
    expect(document.body.textContent).toContain("Processing is continuing on the server");
    expect(document.body.textContent).not.toContain("Audio processing cancelled");
  });

  it("offers direct access to the note and automatically persisted transcript", async () => {
    const plugin = { register: jest.fn() } as unknown as SystemSculptPlugin;
    const artifactOpen = jest.fn().mockResolvedValue(undefined);
    const saveArtifact = jest.fn().mockImplementation(async (kind: string) => ({
      notePath: `SystemSculpt/Audio Notes/Product sync ${kind}.md`,
      open: artifactOpen,
    }));
    const note: AudioProcessorCompletedNote = {
      jobId: "audio_job_123",
      notePath: "SystemSculpt/Audio Notes/Product sync.md",
      transcriptPath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      summaryAvailable: true,
      open: jest.fn().mockResolvedValue(undefined),
      saveArtifact,
    };
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());

    panel.succeed(note);
    expect(actionButton("Open note")).toBeTruthy();
    expect(actionButton("Open transcript")).toBeTruthy();
    expect(saveArtifact).not.toHaveBeenCalled();

    actionButton("Open transcript").click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(saveArtifact).toHaveBeenCalledWith("transcript");
    expect(artifactOpen).toHaveBeenCalledTimes(1);
  });

  it("opens Credits & usage while an awaiting-funds job remains resumable", () => {
    const openCreditsBalanceModal = jest.fn().mockResolvedValue(undefined);
    const onCancel = jest.fn();
    const plugin = {
      register: jest.fn(),
      openCreditsBalanceModal,
    } as unknown as SystemSculptPlugin;
    const panel = new AudioProcessorPanel(plugin, "Product sync", onCancel);

    panel.update({
      stage: "awaiting_funds",
      progress: 0.4,
      message: "More credits are needed to continue",
      serverOwned: true,
      quotedCredits: 3_850,
      chargedCredits: 1_100,
      resumeRequired: true,
    });

    expect(document.body.textContent).toContain("3,850 credits; 1,100 charged so far");
    expect(document.body.textContent).toContain("resume automatically");
    actionButton("Credits & usage").click();
    expect(openCreditsBalanceModal).toHaveBeenCalledTimes(1);
    expect(actionButton("Stop watching")).toBeTruthy();
    actionButton("Stop watching").click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("opens an independently paid transcript without stopping active processing", async () => {
    const plugin = { register: jest.fn() } as unknown as SystemSculptPlugin;
    const onCancel = jest.fn();
    const transcriptOpen = jest.fn().mockResolvedValue(undefined);
    let finishSave: ((value: { notePath: string; open(): Promise<void> }) => void) | undefined;
    const save = jest.fn(() => new Promise<{ notePath: string; open(): Promise<void> }>((resolve) => {
      finishSave = resolve;
    }));
    const panel = new AudioProcessorPanel(plugin, "Product sync", onCancel);

    panel.update({
      stage: "summarizing",
      progress: 0.82,
      message: "Writing the audio summary…",
      serverOwned: true,
      availableTranscript: {
        filename: "Product sync — Transcript.md",
        save,
      },
    });

    expect(actionButton("Open transcript")).toBeTruthy();
    expect(actionButton("Hide")).toBeTruthy();
    expect(actionButton("Stop watching")).toBeTruthy();
    actionButton("Open transcript").click();
    actionButton("Open transcript").click();
    expect(save).toHaveBeenCalledTimes(1);
    expect(actionButton("Open transcript").disabled).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();

    finishSave?.({
      notePath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      open: transcriptOpen,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transcriptOpen).toHaveBeenCalledTimes(1);
    expect(actionButton("Open transcript").disabled).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps transcript and funding actions usable after an early-download error", async () => {
    const openCreditsBalanceModal = jest.fn().mockResolvedValue(undefined);
    const plugin = {
      register: jest.fn(),
      openCreditsBalanceModal,
    } as unknown as SystemSculptPlugin;
    const notice = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());

    panel.update({
      stage: "awaiting_funds",
      progress: 0.84,
      message: "More credits are needed to continue",
      serverOwned: true,
      availableTranscript: {
        filename: "Product sync — Transcript.md",
        save: jest.fn().mockRejectedValue(new Error("Transcript integrity check failed.")),
      },
    });

    expect(actionButton("Credits & usage")).toBeTruthy();
    expect(actionButton("Hide")).toBeTruthy();
    expect(actionButton("Stop watching")).toBeTruthy();
    actionButton("Open transcript").click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Transcript integrity check failed."));
    expect(actionButton("Open transcript").disabled).toBe(false);
    actionButton("Credits & usage").click();
    expect(openCreditsBalanceModal).toHaveBeenCalledTimes(1);
  });

  it("presents a transcript-only recovery without offering a missing summary note", () => {
    const plugin = { register: jest.fn() } as unknown as SystemSculptPlugin;
    const note: AudioProcessorCompletedNote = {
      jobId: "audio_job_123",
      notePath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      transcriptPath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      summaryAvailable: false,
      open: jest.fn().mockResolvedValue(undefined),
      saveArtifact: jest.fn().mockResolvedValue({
        notePath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
        open: jest.fn(),
      }),
    };
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());

    panel.succeed(note);

    expect(document.body.textContent).toContain("Transcript saved; summary unavailable");
    expect(actionButton("Open transcript")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("button"))
      .some((button) => button.textContent?.includes("Open note"))).toBe(false);
  });
});
