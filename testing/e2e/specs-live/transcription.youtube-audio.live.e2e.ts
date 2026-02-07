import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  approveAllToolCallsDirect,
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  openFreshChatView,
  PLUGIN_ID,
  requireEnv,
} from "../utils/systemsculptChat";

const execFileAsync = promisify(execFile);

async function execFileWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
}

async function waitForTFile(pathInVault: string, timeoutMs: number, minSizeBytes?: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await browser.executeObsidian(({ app }, filePath, minBytes) => {
      const normalized = String(filePath).replace(/\\/g, "/");
      const file = app.vault.getAbstractFileByPath(normalized);
      const size = (file as any)?.stat?.size;
      // @ts-ignore
      return (
        !!file &&
        typeof (file as any).extension === "string" &&
        (!minBytes || (typeof size === "number" && size >= minBytes))
      );
    }, pathInVault, minSizeBytes ?? null);
    if (exists) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for vault file: ${pathInVault}`);
}

describe("Transcription + YouTube transcript (live)", function () {
  this.timeout(1_200_000);
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";
  const sourceAudioPath = getEnv("SYSTEMSCULPT_E2E_SOURCE_AUDIO_PATH");

  const youtubeUrl =
    "https://www.youtube.com/watch?v=nDLb8_wgX50&pp=ygUZZHIgaHViZXJtYW4gZGF2aWQgZ29nZ2lucw%3D%3D";

  let vaultPath: string;
  const nonce = crypto.randomUUID().slice(0, 8);
  const TOKEN_PHRASE_WORDS = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
    "mike",
    "november",
    "oscar",
    "papa",
    "quebec",
    "romeo",
    "sierra",
    "tango",
    "uniform",
    "victor",
    "whiskey",
    "yankee",
    "zulu",
  ] as const;

  const tokenWords = (() => {
    const cleaned = nonce.toLowerCase().replace(/[^a-f0-9]/g, "");
    const words: string[] = [];
    for (let i = 0; i < cleaned.length && words.length < 5; i += 1) {
      const n = Number.parseInt(cleaned[i], 16);
      if (Number.isNaN(n)) continue;
      const idx = (n + i * 7) % TOKEN_PHRASE_WORDS.length;
      words.push(TOKEN_PHRASE_WORDS[idx]);
    }
    while (words.length < 5) {
      words.push(TOKEN_PHRASE_WORDS[words.length % TOKEN_PHRASE_WORDS.length]);
    }
    return words;
  })();
  const audioFolder = "E2E/audio";
  const shortAiffPath = path.join(audioFolder, `tts-short-${nonce}.aiff`);
  const mp3Path = path.join(audioFolder, `tts-long-${nonce}.mp3`);
  const oggPath = path.join(audioFolder, `tts-long-${nonce}.ogg`);
  const meetingWavPath = path.join(audioFolder, `meeting-chunked-${nonce}.wav`);
  const serverlessAudioLimitBytes = 4 * 1024 * 1024 - 64 * 1024;
  const jobsChunkingThresholdBytes = 95 * 1024 * 1024;
  const jobsMaxAudioBytes = 500 * 1024 * 1024;

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        mcpEnabled: true,
        mcpAutoAccept: false,
        toolingAutoApproveReadOnly: true,
        transcriptionProvider: "systemsculpt",
      },
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `systemsculpt-e2e-audio-${nonce}-`));
    try {
      const shortAbs = path.join(tmpDir, `tts-short-${nonce}.aiff`);
      const mp3Abs = path.join(tmpDir, `tts-long-${nonce}.mp3`);
      const oggAbs = path.join(tmpDir, `tts-long-${nonce}.ogg`);
      const meetingWavAbs = path.join(tmpDir, `meeting-chunked-${nonce}.wav`);

      await execFileWithTimeout(
        "/usr/bin/say",
        [
          "-o",
          shortAbs,
          "-r",
          "160",
          `System Sculpt audio transcription test. This is an automated integration check. Token phrase: ${tokenWords.join(
            " "
          )}.`,
        ],
        30_000
      );

      const ffmpegBinCandidates = [
        process.env.SYSTEMSCULPT_E2E_FFMPEG_BIN,
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        "ffmpeg",
      ].filter(Boolean) as string[];

      let ffmpegBin: string | null = null;
      for (const candidate of ffmpegBinCandidates) {
        if (candidate === "ffmpeg") {
          ffmpegBin = candidate;
          break;
        }
        try {
          await fs.access(candidate);
          ffmpegBin = candidate;
          break;
        } catch (_) {}
      }
      if (!ffmpegBin) throw new Error("ffmpeg not available (set SYSTEMSCULPT_E2E_FFMPEG_BIN).");

      await execFileWithTimeout(
        ffmpegBin,
        [
          "-y",
          "-v",
          "error",
          "-stream_loop",
          "-1",
          "-i",
          shortAbs,
          "-t",
          "200",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "320k",
          mp3Abs,
        ],
        90_000
      );

      await execFileWithTimeout(
        ffmpegBin,
        [
          "-y",
          "-v",
          "error",
          "-stream_loop",
          "-1",
          "-i",
          shortAbs,
          "-t",
          "200",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-c:a",
          "libopus",
          "-b:a",
          "256k",
          "-vbr",
          "off",
          oggAbs,
        ],
        90_000
      );

      const meetingMp3Abs = path.resolve(
        sourceAudioPath ??
          path.join(os.homedir(), "gits/private-vault/90 - system/systemsculpt/Recordings/test_meeting.mp3")
      );
      try {
        await fs.access(meetingMp3Abs);
      } catch (error) {
        throw new Error(`Missing private-vault audio fixture: ${meetingMp3Abs}`);
      }

      // Exercise the server-side chunking path by transcoding 10 minutes of a real recording
      // to a high-bitrate PCM WAV (>95MB), with a short TTS intro so the transcript contains
      // a deterministic token phrase we can assert on.
      const introWavAbs = path.join(tmpDir, `intro-${nonce}.wav`);
      const mainWavAbs = path.join(tmpDir, `meeting-main-${nonce}.wav`);
      const concatListAbs = path.join(tmpDir, `concat-${nonce}.txt`);

      await execFileWithTimeout(
        ffmpegBin,
        [
          "-y",
          "-v",
          "error",
          "-i",
          shortAbs,
          "-ar",
          "96000",
          "-ac",
          "2",
          "-c:a",
          "pcm_s32le",
          introWavAbs,
        ],
        90_000
      );

      await execFileWithTimeout(
        ffmpegBin,
        [
          "-y",
          "-v",
          "error",
          "-stream_loop",
          "-1",
          "-i",
          meetingMp3Abs,
          "-t",
          "600",
          "-ar",
          "96000",
          "-ac",
          "2",
          "-c:a",
          "pcm_s32le",
          mainWavAbs,
        ],
        300_000
      );

      await fs.writeFile(concatListAbs, `file '${introWavAbs}'\nfile '${mainWavAbs}'\n`, "utf8");

      await execFileWithTimeout(
        ffmpegBin,
        ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concatListAbs, "-c", "copy", meetingWavAbs],
        60_000
      );

      const [mp3Stat, oggStat] = await Promise.all([fs.stat(mp3Abs), fs.stat(oggAbs)]);
      expect(mp3Stat.size).toBeGreaterThan(serverlessAudioLimitBytes);
      expect(oggStat.size).toBeGreaterThan(serverlessAudioLimitBytes);

      await browser.executeObsidian(async ({ app }, { audioFolder, mp3Path, oggPath, mp3Abs, oggAbs }) => {
        const remote: any = (window as any)?.electron?.remote;
        const nodeFs = remote?.require?.("fs");
        const fsp = nodeFs?.promises;
        if (!fsp) throw new Error("Electron remote fs.promises unavailable");

        try {
          await app.vault.createFolder(audioFolder);
        } catch (_) {}

        const toArrayBuffer = (buf: any): ArrayBuffer =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

        const [mp3Buf, oggBuf] = await Promise.all([fsp.readFile(mp3Abs), fsp.readFile(oggAbs)]);

        await app.vault.createBinary(mp3Path, toArrayBuffer(mp3Buf));
        await app.vault.createBinary(oggPath, toArrayBuffer(oggBuf));
      }, { audioFolder, mp3Path, oggPath, mp3Abs, oggAbs });

      const meetingStat = await fs.stat(meetingWavAbs);
      expect(meetingStat.size).toBeGreaterThan(jobsChunkingThresholdBytes);
      expect(meetingStat.size).toBeGreaterThan(400 * 1024 * 1024);
      expect(meetingStat.size).toBeLessThan(jobsMaxAudioBytes);

      const activeVaultPath = await browser.executeObsidian(({ app }) => {
        const adapter: any = (app as any)?.vault?.adapter;
        const candidate =
          typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : adapter?.basePath;
        return typeof candidate === "string" ? candidate : "";
      });
      const targetVaultPath = String(activeVaultPath || vaultPath || "").trim();
      if (!targetVaultPath) throw new Error("Unable to resolve active vault path for large-audio copy.");

      const meetingDestAbs = path.join(targetVaultPath, meetingWavPath);
      await fs.mkdir(path.dirname(meetingDestAbs), { recursive: true });
      await fs.copyFile(meetingWavAbs, meetingDestAbs);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    await waitForTFile(mp3Path, 30_000);
    await waitForTFile(oggPath, 30_000);
    await waitForTFile(meetingWavPath, 600_000, jobsChunkingThresholdBytes);
  });

  const start = async (filePath: string): Promise<string> =>
    await browser.executeObsidian(async ({ app }, { pluginId, filePath }) => {
      const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
      if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);

      const file = app.vault.getAbstractFileByPath(filePath);
      if (!file) throw new Error(`File not found: ${filePath}`);

      const runId = `e2e-transcribe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const root: any = (window as any).__systemsculptE2E ?? ((window as any).__systemsculptE2E = {});
      const transcriptions: any = root.transcriptions ?? (root.transcriptions = {});
      const state = {
        done: false,
        text: null as string | null,
        error: null as string | null,
        statuses: [] as string[],
      };
      transcriptions[runId] = state;

      void plugin
        .getTranscriptionService()
        .transcribeFile(file, {
          type: "note",
          timestamped: false,
          suppressNotices: true,
          onProgress: (_p: number, status: string) => {
            if (typeof status === "string" && status.trim().length > 0) state.statuses.push(status);
          },
        })
        .then((text: string) => {
          state.done = true;
          state.text = text;
        })
        .catch((error: any) => {
          state.done = true;
          state.error = String(error?.message || error);
        });

      return runId;
    }, { pluginId: PLUGIN_ID, filePath });

  const waitForResult = async (
    runId: string,
    timeoutMs: number
  ): Promise<{ text: string; statuses: string[] }> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await browser.executeObsidian(({ }, { runId }) => {
        const root: any = (window as any).__systemsculptE2E;
        const entry = root?.transcriptions?.[runId];
        if (!entry) return null;
        return {
          done: !!entry.done,
          text: typeof entry.text === "string" ? entry.text : null,
          error: typeof entry.error === "string" ? entry.error : null,
          statuses: Array.isArray(entry.statuses) ? entry.statuses.slice(-200) : [],
        };
      }, { runId });

      if (state?.done) {
        if (state.error) {
          throw new Error(state.error);
        }
        return { text: state.text || "", statuses: state.statuses || [] };
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error("Timed out waiting for transcription to complete.");
  };

  it("runs the YouTube transcript MCP tool against the live API", async function () {
    this.timeout(300000);

    await openFreshChatView();

    const toolCallId = await browser.executeObsidian(({ app }, { url }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view: any = (leaf as any)?.view;
      const manager: any = view?.toolCallManager;
      if (!manager) throw new Error("ToolCallManager missing");
      const request = {
        id: `e2e-youtube-${Date.now()}`,
        type: "function",
        function: {
          name: "mcp-youtube_youtube_transcript",
          arguments: JSON.stringify({ url }),
        },
      };
      const tc = manager.createToolCall(request, `e2e-message-${Date.now()}`, true);
      return tc.id;
    }, { url: youtubeUrl });

    await approveAllToolCallsDirect();

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }, { toolCallId }) => {
          const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
          const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
          const activeLeaf: any = app.workspace.activeLeaf as any;
          const leaf =
            markedLeaf ||
            (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
          const view: any = (leaf as any)?.view;
          const manager: any = view?.toolCallManager;
          const call = manager?.getToolCall?.(toolCallId);
          return call?.state === "completed";
        }, { toolCallId }),
      { timeout: 240000, timeoutMsg: "YouTube transcript tool call did not complete." }
    );

    const result = await browser.executeObsidian(({ app }, { toolCallId }) => {
      const leaves: any[] = app.workspace.getLeavesOfType("systemsculpt-chat-view") as any;
      const markedLeaf = leaves.find((l) => (l as any)?.view?.__systemsculptE2EActive);
      const activeLeaf: any = app.workspace.activeLeaf as any;
      const leaf =
        markedLeaf ||
        (activeLeaf?.view?.getViewType?.() === "systemsculpt-chat-view" ? activeLeaf : leaves[0]);
      const view: any = (leaf as any)?.view;
      const manager: any = view?.toolCallManager;
      const call = manager?.getToolCall?.(toolCallId);
      return call?.result;
    }, { toolCallId });

    expect(result?.success).toBe(true);
    expect(result?.data?.success).toBe(true);
    expect(String(result?.data?.text ?? "").length).toBeGreaterThan(1000);
  });

  it("transcribes large MP3 + OGG via the live API (jobs flow)", async function () {
    this.timeout(480000);

    const mp3 = await waitForResult(await start(mp3Path), 420_000);
    expect(mp3.text.length).toBeGreaterThan(10);
    expect(mp3.text.toLowerCase()).toContain("audio transcription test");
    {
      const normalized = mp3.text.toLowerCase();
      const matches = tokenWords.filter((word) => normalized.includes(word));
      expect(matches.length).toBeGreaterThanOrEqual(3);
    }
    expect(mp3.statuses.some((s) => s.toLowerCase().includes("upload"))).toBe(true);
    expect(mp3.statuses.some((s) => s.toLowerCase().includes("transcrib"))).toBe(true);

    const ogg = await waitForResult(await start(oggPath), 420_000);
    expect(ogg.text.length).toBeGreaterThan(10);
    expect(ogg.text.toLowerCase()).toContain("audio transcription test");
    {
      const normalized = ogg.text.toLowerCase();
      const matches = tokenWords.filter((word) => normalized.includes(word));
      expect(matches.length).toBeGreaterThanOrEqual(3);
    }
    expect(ogg.statuses.some((s) => s.toLowerCase().includes("upload"))).toBe(true);
    expect(ogg.statuses.some((s) => s.toLowerCase().includes("transcrib"))).toBe(true);
  });

  it("transcribes a >400MB WAV via the live API (server-side chunking)", async function () {
    this.timeout(900000);

    const result = await waitForResult(await start(meetingWavPath), 840_000);

    expect(result.text.length).toBeGreaterThan(200);
    {
      const normalized = result.text.toLowerCase();
      const matches = tokenWords.filter((word) => normalized.includes(word));
      expect(matches.length).toBeGreaterThanOrEqual(3);
    }
    expect(result.statuses.some((s) => s.toLowerCase().includes("upload"))).toBe(true);
    expect(result.statuses.some((s) => s.toLowerCase().includes("chunk"))).toBe(true);
    expect(result.statuses.some((s) => s.toLowerCase().includes("transcrib"))).toBe(true);
  });
});
