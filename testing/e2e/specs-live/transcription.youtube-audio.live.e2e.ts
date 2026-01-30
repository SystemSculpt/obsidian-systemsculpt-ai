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

async function waitForTFile(pathInVault: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await browser.executeObsidian(({ app }, filePath) => {
      const normalized = String(filePath).replace(/\\/g, "/");
      const file = app.vault.getAbstractFileByPath(normalized);
      // @ts-ignore
      return !!file && typeof (file as any).extension === "string";
    }, pathInVault);
    if (exists) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for vault file: ${pathInVault}`);
}

describe("Transcription + YouTube transcript (live)", function () {
  this.timeout(600000);
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  const youtubeUrl =
    "https://www.youtube.com/watch?v=nDLb8_wgX50&pp=ygUZZHIgaHViZXJtYW4gZGF2aWQgZ29nZ2lucw%3D%3D";

  let vaultPath: string;
  const nonce = crypto.randomUUID().slice(0, 8);
  const audioFolder = "E2E/audio";
  const shortAiffPath = path.join(audioFolder, `tts-short-${nonce}.aiff`);
  const mp3Path = path.join(audioFolder, `tts-long-${nonce}.mp3`);
  const oggPath = path.join(audioFolder, `tts-long-${nonce}.ogg`);
  const serverlessAudioLimitBytes = 4 * 1024 * 1024 - 64 * 1024;

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

      await execFileWithTimeout(
        "/usr/bin/say",
        [
          "-o",
          shortAbs,
          "-r",
          "160",
          `System Sculpt audio transcription test. This is an automated integration check. Token ${nonce}.`,
        ],
        30_000
      );

      await execFileWithTimeout(
        "/opt/homebrew/bin/ffmpeg",
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
        "/opt/homebrew/bin/ffmpeg",
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
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    await waitForTFile(mp3Path, 30_000);
    await waitForTFile(oggPath, 30_000);
  });

  it("runs the YouTube transcript MCP tool against the live API", async function () {
    this.timeout(300000);

    await openFreshChatView();

    const toolCallId = await browser.executeObsidian(({ app }, { url }) => {
      const view: any = app.workspace.getLeavesOfType("systemsculpt-chat-view")[0]?.view;
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
          const view: any = app.workspace.getLeavesOfType("systemsculpt-chat-view")[0]?.view;
          const manager: any = view?.toolCallManager;
          const call = manager?.getToolCall?.(toolCallId);
          return call?.state === "completed";
        }, { toolCallId }),
      { timeout: 240000, timeoutMsg: "YouTube transcript tool call did not complete." }
    );

    const result = await browser.executeObsidian(({ app }, { toolCallId }) => {
      const view: any = app.workspace.getLeavesOfType("systemsculpt-chat-view")[0]?.view;
      const manager: any = view?.toolCallManager;
      const call = manager?.getToolCall?.(toolCallId);
      return call?.result;
    }, { toolCallId });

    expect(result?.success).toBe(true);
    expect(result?.data?.success).toBe(true);
    expect(String(result?.data?.text ?? "").length).toBeGreaterThan(1000);
  });

  it("transcribes large MP3 + OGG via the live API (chunking + merge)", async function () {
    this.timeout(480000);

    const run = async (filePath: string) =>
      await browser.executeObsidian(async ({ app }, { pluginId, filePath }) => {
        const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
        if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);

        const file = app.vault.getAbstractFileByPath(filePath);
        if (!file) throw new Error(`File not found: ${filePath}`);

        const statuses: string[] = [];
        const text = await plugin.getTranscriptionService().transcribeFile(file, {
          type: "note",
          timestamped: false,
          suppressNotices: true,
          onProgress: (_p: number, status: string) => {
            if (typeof status === "string" && status.trim().length > 0) statuses.push(status);
          },
        });

        return { text, statuses };
      }, { pluginId: PLUGIN_ID, filePath });

    const mp3 = await run(mp3Path);
    expect(mp3.text.length).toBeGreaterThan(10);
    expect(mp3.statuses.some((s) => s.toLowerCase().includes("chunk") || s.toLowerCase().includes("splitting"))).toBe(
      true
    );

    const ogg = await run(oggPath);
    expect(ogg.text.length).toBeGreaterThan(10);
    expect(ogg.statuses.some((s) => s.toLowerCase().includes("chunk") || s.toLowerCase().includes("splitting"))).toBe(
      true
    );
  });
});
