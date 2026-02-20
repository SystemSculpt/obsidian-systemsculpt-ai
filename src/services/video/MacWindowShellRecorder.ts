import { App, FileSystemAdapter } from "obsidian";
import { hasMacWindowShellRecordingSupport } from "./MacShellVideoSupport";
import {
  type ChildProcessLike,
  type ExecFileSyncFn,
  type SpawnFn,
  readAbsoluteOutputBytesViaFs,
  readAbsoluteOutputSizeViaFs,
  resolveExecFileSyncFromRuntime,
  resolveSpawnFromRuntime,
} from "./MacShellRuntime";
import { probeObsidianFrontWindowBounds } from "./ObsidianWindowBounds";
import {
  type VideoAudioCaptureConfig,
  normalizeVideoAudioCaptureConfig,
} from "./VideoAudioCaptureConfig";

export type MacShellRecorderStopReason = "manual" | "source-ended" | "permission-revoked";

type MacCaptureLaunchPlan =
  | {
    mode: "window-rectangle";
    args: string[];
  }
  | {
    mode: "window-picker";
    args: string[];
  };

export class RecorderCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecorderCanceledError";
  }
}

export const isRecorderCanceledError = (error: Error): boolean => error?.name === "RecorderCanceledError";

export interface MacWindowShellRecorderOptions {
  onError: (error: Error) => void;
  onStatus: (status: string) => void;
  onComplete: (filePath: string, videoBlob: Blob, stopReason?: MacShellRecorderStopReason) => void;
  captureAudio?: Partial<VideoAudioCaptureConfig>;
}

type RecorderState = "idle" | "starting" | "recording" | "stopping";

/**
 * macOS fallback recorder that prioritizes direct Obsidian-window rectangle capture,
 * then falls back to the native window picker when bounds cannot be resolved.
 */
export class MacWindowShellRecorder {
  private readonly app: App;
  private readonly onError: (error: Error) => void;
  private readonly onStatus: (status: string) => void;
  private readonly onComplete: (filePath: string, videoBlob: Blob, stopReason?: MacShellRecorderStopReason) => void;
  private readonly spawn: SpawnFn;
  private readonly execFileSync: ExecFileSyncFn | null;
  private readonly captureAudio: VideoAudioCaptureConfig;

  private state: RecorderState = "idle";
  private process: ChildProcessLike | null = null;
  private outputPath: string | null = null;
  private stopReason: MacShellRecorderStopReason = "manual";
  private stderrOutput = "";
  private userRequestedStop = false;
  private ignoreProcessClose = false;
  private fullOutputPath: string | null = null;
  private captureConfirmedByProcessOutput = false;
  private gracefulStopTimer: ReturnType<typeof setTimeout> | null = null;
  private captureMode: "window-rectangle" | "window-picker" = "window-picker";

  constructor(app: App, options: MacWindowShellRecorderOptions) {
    this.app = app;
    this.onError = options.onError;
    this.onStatus = options.onStatus;
    this.onComplete = options.onComplete;
    this.spawn = resolveSpawnFromRuntime();
    this.execFileSync = resolveExecFileSyncFromRuntime();
    this.captureAudio = normalizeVideoAudioCaptureConfig(options.captureAudio);
  }

  public async start(outputPath: string): Promise<void> {
    if (this.state !== "idle") {
      this.onStatus("Video recorder is busy.");
      return;
    }

    if (!hasMacWindowShellRecordingSupport()) {
      throw new Error("macOS shell recording is unavailable in this runtime.");
    }

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Video recording fallback requires desktop filesystem adapter.");
    }

    this.state = "starting";
    this.outputPath = outputPath;
    this.stopReason = "manual";
    this.stderrOutput = "";
    this.userRequestedStop = false;
    this.ignoreProcessClose = false;
    this.fullOutputPath = adapter.getFullPath(outputPath);
    this.captureConfirmedByProcessOutput = false;
    this.captureMode = "window-picker";
    this.clearGracefulStopTimer();

    await this.launchCaptureProcess(this.fullOutputPath);
  }

  public stop(reason: MacShellRecorderStopReason = "manual"): void {
    if (!this.process || this.state !== "recording") {
      return;
    }

    this.state = "stopping";
    this.stopReason = reason;
    this.userRequestedStop = true;
    this.onStatus("Stopping recording...");

    const processRef = this.process;
    const stdin = processRef.stdin;
    const hasWritableStdin = !!stdin && typeof stdin.write === "function";
    if (hasWritableStdin) {
      try {
        stdin.write!("\n");
        this.clearGracefulStopTimer();
        this.gracefulStopTimer = setTimeout(() => {
          if (this.process !== processRef) return;
          try {
            processRef.kill("SIGINT");
          } catch {}
        }, 1200);
        return;
      } catch {
        // fall through to signal-based stop
      }
    }

    try {
      this.process.kill("SIGINT");
    } catch (error) {
      this.handleProcessError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  public cleanup(): void {
    if (this.process && (this.state === "recording" || this.state === "stopping")) {
      this.ignoreProcessClose = true;
      try {
        this.process.kill("SIGTERM");
      } catch {}
    }
    this.resetState();
  }

  public getMediaStream(): MediaStream | null {
    return null;
  }

  private async handleProcessClose(code: number | null): Promise<void> {
    this.clearGracefulStopTimer();
    if (this.ignoreProcessClose) {
      this.resetState();
      return;
    }

    const path = this.outputPath;
    const stopReason = this.stopReason;
    const stderr = this.stderrOutput.toLowerCase();
    const userRequestedStop = this.userRequestedStop;

    this.process = null;
    this.state = "idle";

    if (!path) {
      this.resetState();
      return;
    }

    try {
      const bytes = await this.readOutputBytesWithRetry(path);
      if (bytes && bytes.byteLength > 0) {
        const blob = new Blob([bytes], { type: "video/quicktime" });
        this.onComplete(path, blob, stopReason);
        return;
      }

      const outputSize = await this.probeOutputSizeWithRetry(path);
      if (outputSize > 0) {
        // File was saved on disk but could not be read back through this runtime bridge.
        this.onComplete(path, new Blob([], { type: "video/quicktime" }), stopReason);
        return;
      }

      if (this.isSaveLocationError(stderr)) {
        this.onError(
          new Error(
            "macOS recorder could not save to the target folder. Check vault path permissions and try again."
          )
        );
        return;
      }

      if (this.isPermissionError(stderr)) {
        this.onError(
          new Error(
            "macOS denied screen capture permission for Obsidian. Enable it in System Settings > Privacy & Security > Screen & System Audio Recording."
          )
        );
        return;
      }

      if (this.isUnsupportedCaptureMode(stderr)) {
        this.onError(
          new Error(
            "macOS screencapture video mode is unavailable on this system. Update macOS and try again."
          )
        );
        return;
      }

      if (userRequestedStop || stopReason === "manual" || this.isCanceledExitCode(code)) {
        if (this.captureMode === "window-picker" && !this.captureConfirmedByProcessOutput) {
          this.onError(
            new RecorderCanceledError(
              "Recording canceled before start. Select the Obsidian window first."
            )
          );
          return;
        }

        this.onError(
          new Error(
            "Recording stopped, but no video data was saved. Make sure you selected the Obsidian window and kept it visible."
          )
        );
        return;
      }

      this.onError(new Error("Recording ended but no output file was produced."));
    } catch (error) {
      this.onError(
        new Error(`Failed to finalize shell recording: ${error instanceof Error ? error.message : String(error)}`)
      );
    } finally {
      this.resetState();
    }
  }

  private handleProcessError(error: Error): void {
    this.process = null;
    this.state = "idle";
    this.onError(new Error(`Shell recorder failed: ${error.message}`));
    this.resetState();
  }

  private appendStderr(chunk: unknown): void {
    if (chunk == null) return;
    let textChunk = "";
    if (typeof chunk === "string") {
      this.stderrOutput += chunk;
      textChunk = chunk;
    } else {
      const asAny = chunk as any;
      if (asAny && typeof asAny.toString === "function") {
        textChunk = asAny.toString("utf8");
        this.stderrOutput += textChunk;
      }
    }

    const lowered = textChunk.toLowerCase();
    const hasAnyOutput = lowered.trim().length > 0;
    const indicatesActiveCapture = lowered.includes("type any character")
      || lowered.includes("stop screen recording")
      || lowered.includes("press return")
      || lowered.includes("stop recording");
    const looksLikeImmediateError = this.isSaveLocationError(lowered)
      || this.isPermissionError(lowered)
      || this.isUnsupportedCaptureMode(lowered);
    if ((indicatesActiveCapture || (hasAnyOutput && !looksLikeImmediateError))) {
      if (!this.captureConfirmedByProcessOutput) {
        this.captureConfirmedByProcessOutput = true;
        this.onStatus("Recording in progress...");
      }
    }
  }

  private async launchCaptureProcess(fullPath: string): Promise<void> {
    this.stderrOutput = "";
    this.state = "recording";
    this.captureConfirmedByProcessOutput = false;
    this.captureMode = "window-picker";

    const launchPlan = await this.buildCaptureLaunchPlan(fullPath);
    if (launchPlan.mode === "window-rectangle") {
      this.captureMode = "window-rectangle";
      this.captureConfirmedByProcessOutput = true;
      this.onStatus("Recording Obsidian window...");
    } else {
      this.onStatus("Choose the Obsidian window to start recording...");
    }

    const child = this.spawn(
      "screencapture",
      launchPlan.args,
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    this.process = child;
    child.stderr?.on("data", (chunk) => this.appendStderr(chunk));
    child.stdout?.on("data", (chunk) => this.appendStderr(chunk));

    child.once("error", (error: Error) => {
      this.handleProcessError(error);
    });

    child.once("close", (code: number | null) => {
      void this.handleProcessClose(code);
    });
  }

  private isSaveLocationError(stderr: string): boolean {
    return stderr.includes("failed to save to final location");
  }

  private isPermissionError(stderr: string): boolean {
    return stderr.includes("not permitted") || stderr.includes("permission");
  }

  private isUnsupportedCaptureMode(stderr: string): boolean {
    return stderr.includes("illegal option") || stderr.includes("usage: screencapture");
  }

  private isCanceledExitCode(code: number | null): boolean {
    return code === 1 || code === 130 || code === 143;
  }

  private async buildCaptureLaunchPlan(fullPath: string): Promise<MacCaptureLaunchPlan> {
    const boundsProbe = probeObsidianFrontWindowBounds(this.execFileSync);
    const audioArgs = this.buildShellAudioArgs();
    if (boundsProbe.state === "available") {
      const bounds = boundsProbe.bounds;
      return {
        mode: "window-rectangle",
        args: ["-v", ...audioArgs, `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, "-o", fullPath],
      };
    }

    return {
      mode: "window-picker",
      args: ["-v", ...audioArgs, "-w", "-o", fullPath],
    };
  }

  private buildShellAudioArgs(): string[] {
    const wantsSystemAudio = this.captureAudio.includeSystemAudio;
    const wantsMicrophoneAudio = this.captureAudio.includeMicrophoneAudio;

    if (!wantsSystemAudio && !wantsMicrophoneAudio) {
      return [];
    }

    if (wantsSystemAudio && !wantsMicrophoneAudio) {
      this.onStatus(
        "System audio capture in macOS shell fallback is limited. Enable microphone audio for the most reliable audio capture."
      );
      return [];
    }

    if (wantsSystemAudio && wantsMicrophoneAudio) {
      this.onStatus(
        "Capturing audio via macOS shell fallback (default input source)."
      );
    }

    return ["-g"];
  }

  private async readOutputBytesWithRetry(path: string): Promise<ArrayBuffer | null> {
    const maxWaitMs = 6000;
    const pollMs = 150;
    const startedAt = Date.now();
    const fullPath = this.fullOutputPath;

    while (Date.now() - startedAt <= maxWaitMs) {
      try {
        const relativeBytes = await this.readRelativeOutputBytes(path);
        if (relativeBytes) return relativeBytes;
        if (fullPath) {
          const absoluteBytes = await this.readAbsoluteOutputBytes(fullPath);
          if (absoluteBytes) return absoluteBytes;
        }
      } catch {
        // keep polling until timeout
      }
      await this.delay(pollMs);
    }

    return null;
  }

  private async probeOutputSizeWithRetry(path: string): Promise<number> {
    const maxWaitMs = 10000;
    const pollMs = 200;
    const startedAt = Date.now();
    const fullPath = this.fullOutputPath;
    let largestSize = 0;

    while (Date.now() - startedAt <= maxWaitMs) {
      try {
        const size = await this.readOutputSize(path, fullPath);
        if (size > largestSize) {
          largestSize = size;
        }
        if (size > 0) {
          return size;
        }
      } catch {
        // keep polling until timeout
      }
      await this.delay(pollMs);
    }

    return largestSize;
  }

  private async readRelativeOutputBytes(path: string): Promise<ArrayBuffer | null> {
    const exists = await this.app.vault.adapter.exists(path);
    if (!exists) {
      return null;
    }
    const bytes = await this.app.vault.adapter.readBinary(path);
    return bytes.byteLength > 0 ? bytes : null;
  }

  private async readAbsoluteOutputBytes(path: string): Promise<ArrayBuffer | null> {
    return await readAbsoluteOutputBytesViaFs(path);
  }

  private async readOutputSize(path: string, fullPath: string | null): Promise<number> {
    const relativeSize = await this.readRelativeOutputSize(path);
    if (relativeSize > 0) {
      return relativeSize;
    }
    if (fullPath) {
      const absoluteSize = await this.readAbsoluteOutputSize(fullPath);
      if (absoluteSize > 0) {
        return absoluteSize;
      }
    }
    return 0;
  }

  private async readRelativeOutputSize(path: string): Promise<number> {
    const statFn = (this.app.vault.adapter as any)?.stat;
    if (typeof statFn !== "function") {
      return 0;
    }
    try {
      const stat = await statFn.call(this.app.vault.adapter, path);
      if (stat && typeof stat.size === "number" && Number.isFinite(stat.size)) {
        return stat.size > 0 ? stat.size : 0;
      }
    } catch {
      // ignore and fall back to absolute stat
    }
    return 0;
  }

  private async readAbsoluteOutputSize(path: string): Promise<number> {
    return await readAbsoluteOutputSizeViaFs(path);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private clearGracefulStopTimer(): void {
    if (!this.gracefulStopTimer) {
      return;
    }
    clearTimeout(this.gracefulStopTimer);
    this.gracefulStopTimer = null;
  }

  private resetState(): void {
    this.process = null;
    this.outputPath = null;
    this.state = "idle";
    this.stopReason = "manual";
    this.stderrOutput = "";
    this.userRequestedStop = false;
    this.ignoreProcessClose = false;
    this.fullOutputPath = null;
    this.captureConfirmedByProcessOutput = false;
    this.captureMode = "window-picker";
    this.clearGracefulStopTimer();
  }

}
