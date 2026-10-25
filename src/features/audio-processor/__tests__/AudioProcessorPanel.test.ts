/** @jest-environment jsdom */

import { Component } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import { AudioProcessorPanel } from "../AudioProcessorPanel";
import type { AudioProcessorCompletedNote } from "../types";

/** A loaded plugin component: unloading it runs what live runs registered. */
const loadedPlugin = (extra: Record<string, unknown> = {}): SystemSculptPlugin => {
  const plugin = Object.assign(new Component(), extra);
  plugin.load();
  return plugin as unknown as SystemSculptPlugin;
};

/** Runs still registered for unload (the Obsidian mock keeps children in `children`). */
const registeredRuns = (plugin: SystemSculptPlugin): number =>
  (plugin as unknown as { children: unknown[] }).children.length;

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

  it("uses a preset-neutral note step in the shared progress timeline", () => {
    const plugin = loadedPlugin();

    new AudioProcessorPanel(plugin, "audio.m4a", jest.fn());

    expect(document.body.textContent).toContain("Note");
    expect(document.body.textContent).not.toContain("Summary");
  });

  it("distinguishes cancelling an upload from stopping local observation of server work", () => {
    const onCancel = jest.fn();
    const plugin = loadedPlugin();
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
    const plugin = loadedPlugin();
    const artifactOpen = jest.fn().mockResolvedValue(undefined);
    const saveArtifact = jest.fn().mockImplementation(async (kind: string) => ({
      notePath: `SystemSculpt/Audio Notes/Product sync ${kind}.md`,
      open: artifactOpen,
    }));
    const note: AudioProcessorCompletedNote = {
      jobId: "audio_job_123",
      notePath: "SystemSculpt/Audio Notes/Product sync.md",
      transcriptPath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      primaryNoteAvailable: true,
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
    const plugin = loadedPlugin({ openCreditsBalanceModal });
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

    expect(document.body.textContent).toContain(
      "Up to 3,850 credits may be temporarily reserved; 1,100 charged so far",
    );
    expect(document.body.textContent).toContain("Unused reserved credits are returned");
    expect(document.body.textContent).toContain("resume automatically");
    actionButton("Credits & usage").click();
    expect(openCreditsBalanceModal).toHaveBeenCalledTimes(1);
    expect(actionButton("Stop watching")).toBeTruthy();
    actionButton("Stop watching").click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("routes a rejected 402 to Add credits instead of a raw failure (#300)", () => {
    const openCreditsBalanceModal = jest.fn().mockResolvedValue(undefined);
    const plugin = loadedPlugin({ openCreditsBalanceModal });
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());
    const error = Object.assign(new Error("Insufficient available credits to run this request."), {
      status: 402,
      code: "insufficient_credits",
    });

    panel.fail(error);

    expect(document.body.textContent).toContain("Not enough credits");
    expect(document.body.textContent).toContain("Add credits to process audio.");
    expect(document.body.textContent).not.toContain("Audio processing failed");
    actionButton("Add credits").click();
    expect(openCreditsBalanceModal).toHaveBeenCalledTimes(1);
  });

  it("brings a hidden job back with Add credits when it later returns 402", () => {
    const openCreditsBalanceModal = jest.fn().mockResolvedValue(undefined);
    const plugin = loadedPlugin({ openCreditsBalanceModal });
    const notices = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());
    panel.update({ stage: "transcribing", progress: 0.5, message: "Transcribing…", serverOwned: true });
    actionButton("Hide").click();
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
    expect(notices).toHaveBeenCalledWith(expect.stringContaining("continuing on the server"));

    panel.fail(Object.assign(new Error("Insufficient available credits to run this request."), {
      status: 402,
      code: "insufficient_credits",
    }));

    expect(document.querySelectorAll(".systemsculpt-progress-panel")).toHaveLength(1);
    expect(document.body.textContent).toContain("Product sync");
    expect(document.body.textContent).toContain("Not enough credits");
    actionButton("Add credits").click();
    expect(openCreditsBalanceModal).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
  });

  it.each([
    [true, "Audio processing is continuing on the server. You can close Obsidian and resume later."],
    [false, "This audio is still being prepared. Keep Obsidian open until server processing begins."],
  ])("says once, on Hide, whether Obsidian may close (server-owned %s)", (serverOwned, expected) => {
    const plugin = loadedPlugin();
    const notices = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());
    panel.update({ stage: serverOwned ? "transcribing" : "uploading", progress: 0.5, message: "Working…", serverOwned });

    actionButton("Hide").click();

    expect(notices.mock.calls.map(([line]) => line)).toEqual([`Notice: ${expected}`]);
  });

  it.each([
    [true, "Audio note and transcript saved to SystemSculpt/Audio Notes/Product sync.md."],
    [false, "Transcript recovered to SystemSculpt/Audio Notes/Product sync — Transcript.md; primary note unavailable."],
  ])("says once where a hidden job's result went (primary note %s)", (primaryNoteAvailable, expected) => {
    const plugin = loadedPlugin();
    const notices = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());
    panel.update({ stage: "transcribing", progress: 0.5, message: "Transcribing…", serverOwned: true });
    actionButton("Hide").click();
    notices.mockClear();

    panel.succeed({
      jobId: "audio_job_123",
      notePath: "SystemSculpt/Audio Notes/Product sync.md",
      transcriptPath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      primaryNoteAvailable,
      open: jest.fn().mockResolvedValue(undefined),
      saveArtifact: jest.fn(),
    });

    expect(notices.mock.calls.map(([line]) => line)).toEqual([`Notice: ${expected}`]);
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
  });

  it("does not bring a panel back after it was closed by unload", () => {
    const plugin = loadedPlugin({ openCreditsBalanceModal: jest.fn() });
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());

    plugin.unload();
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
    panel.fail(Object.assign(new Error("Insufficient credits"), { status: 402, code: "insufficient_credits" }));

    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
    expect(plugin.openCreditsBalanceModal).not.toHaveBeenCalled();
  });

  describe("unload registration", () => {
    const completedNote = (): AudioProcessorCompletedNote => ({
      jobId: "audio_job_123",
      notePath: "SystemSculpt/Audio Notes/Product sync.md",
      transcriptPath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      primaryNoteAvailable: true,
      open: jest.fn().mockResolvedValue(undefined),
      saveArtifact: jest.fn(),
    });
    const dismiss = (): void => {
      document.querySelector<HTMLButtonElement>(".systemsculpt-progress-dismiss")!.click();
    };

    beforeEach(() => {
      jest.spyOn(console, "log").mockImplementation(() => undefined);
    });

    it("keeps a running or still-visible result registered and releases it once dismissed", () => {
      const plugin = loadedPlugin();
      const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());
      expect(registeredRuns(plugin)).toBe(1);

      panel.succeed(completedNote());
      expect(registeredRuns(plugin)).toBe(1);

      dismiss();
      expect(registeredRuns(plugin)).toBe(0);
    });

    it("releases a hidden run as soon as it succeeds", () => {
      const plugin = loadedPlugin();
      const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());
      panel.update({ stage: "transcribing", progress: 0.5, message: "Transcribing…", serverOwned: true });
      actionButton("Hide").click();
      expect(registeredRuns(plugin)).toBe(1);

      panel.succeed(completedNote());

      expect(registeredRuns(plugin)).toBe(0);
    });

    it.each([
      ["a plain failure", new Error("Network down")],
      ["a cancellation", new DOMException("Stopped", "AbortError")],
    ])("releases a hidden run after %s", (_label, error) => {
      const plugin = loadedPlugin();
      const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());
      actionButton("Hide").click();

      panel.fail(error);

      expect(registeredRuns(plugin)).toBe(0);
    });

    it("releases a shown failure when the user closes it", () => {
      const plugin = loadedPlugin();
      const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());

      panel.fail(new Error("Network down"));
      expect(registeredRuns(plugin)).toBe(1);
      actionButton("Close").click();

      expect(registeredRuns(plugin)).toBe(0);
    });

    it("leaves nothing to run at unload after a finished run", () => {
      const plugin = loadedPlugin();
      const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());
      const close = jest.spyOn(panel, "close");
      panel.fail(new Error("Network down"));
      actionButton("Close").click();
      close.mockClear();

      plugin.unload();

      expect(close).not.toHaveBeenCalled();
    });
  });

  it("opens an independently paid transcript without stopping active processing", async () => {
    const plugin = loadedPlugin();
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
    const plugin = loadedPlugin({ openCreditsBalanceModal });
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

  it("presents a clean transcript as a completed primary note without implying a summary exists", () => {
    const plugin = loadedPlugin();
    const note: AudioProcessorCompletedNote = {
      jobId: "audio_job_123",
      notePath: "SystemSculpt/Audio Notes/Product sync.md",
      transcriptPath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      primaryNoteAvailable: true,
      open: jest.fn().mockResolvedValue(undefined),
      saveArtifact: jest.fn(),
    };
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());

    panel.succeed(note);

    expect(document.body.textContent).toContain("Audio note ready");
    expect(actionButton("Open note")).toBeTruthy();
    expect(actionButton("Open transcript")).toBeTruthy();
    expect(document.body.textContent).not.toContain("summary unavailable");
  });

  it("presents a transcript-only recovery without offering a missing summary note", () => {
    const plugin = loadedPlugin();
    const note: AudioProcessorCompletedNote = {
      jobId: "audio_job_123",
      notePath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      transcriptPath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      primaryNoteAvailable: false,
      open: jest.fn().mockResolvedValue(undefined),
      saveArtifact: jest.fn().mockResolvedValue({
        notePath: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
        open: jest.fn(),
      }),
    };
    const panel = new AudioProcessorPanel(plugin, "Product sync", jest.fn());

    panel.succeed(note);

    expect(document.body.textContent).toContain(
      "Transcript recovered; primary note unavailable",
    );
    expect(actionButton("Open transcript")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("button"))
      .some((button) => button.textContent?.includes("Open note"))).toBe(false);
  });
});
