/**
 * Real-disk device staging latency, without network or model calls. Run manually:
 *
 * PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/jest.mjs \
 *   --config jest.integration.config.cjs --roots '<rootDir>/testing/bench' \
 *   --runTestsByPath testing/bench/audio-staging.bench.test.ts --reporters=default --verbose
 *
 * AUDIO_STAGING_BENCH_BYTES overrides the default 129 MiB + 7 byte fixture.
 * Fixture creation and restart verification are outside the timed upload path.
 * Staging uses real disk; settings checkpoints remain in memory. The upload sink
 * hashes bytes immediately; its duration is not network latency.
 */
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type SystemSculptPlugin from "../../src/main";
import {
  AudioProcessorApiError,
  type AudioProcessorApiClient,
  type AudioProcessorSignedPart,
} from "../../src/features/audio-processor/AudioProcessorApiClient";
import { AudioProcessorDeviceStaging } from "../../src/features/audio-processor/AudioProcessorDeviceStaging";
import { AudioProcessorService } from "../../src/features/audio-processor/AudioProcessorService";
import { createDeviceAudioSource } from "../../src/features/audio-processor/audioSource";
import type { PendingAudioProcessorUpload } from "../../src/types";

const SIZE_BYTES = Number(process.env.AUDIO_STAGING_BENCH_BYTES ?? 129 * 1024 * 1024 + 7);
const PART_SIZE_BYTES = 10 * 1024 * 1024;

it("measures serial staging before the first upload against real disk and SHA-256", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "systemsculpt-audio-staging-bench-"));
  let source: ReturnType<typeof createDeviceAudioSource> | undefined;
  try {
    // A non-sparse fixture, generated incrementally rather than retained in RAM.
    const fixture = join(root, "recording.m4a");
    const expected = createHash("sha256");
    const block = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < block.length; index += 1) block[index] = index % 251;
    const writer = await fs.open(fixture, "wx");
    try {
      for (let offset = 0; offset < SIZE_BYTES; offset += block.length) {
        const bytes = block.subarray(0, Math.min(block.length, SIZE_BYTES - offset));
        await writer.writeFile(bytes);
        expected.update(bytes);
      }
    } finally {
      await writer.close();
    }
    const expectedSha256 = expected.digest("hex");
    // Same Blob.slice().arrayBuffer() path used by the real device picker.
    source = createDeviceAudioSource(new File([await openAsBlob(fixture)], "recording.m4a"));
    const settings = { pendingAudioProcessorUploads: [] as PendingAudioProcessorUpload[] };
    let binaryWrites = 0;
    let binaryReads = 0;
    let maximumWriteBytes = 0;
    let maximumReadBytes = 0;
    const adapter = {
      exists: async (path: string) => {
        try {
          await fs.stat(join(root, path));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      mkdir: (path: string) => fs.mkdir(join(root, path), { recursive: true }),
      list: async (path: string) => {
        const entries = await fs.readdir(join(root, path), { withFileTypes: true });
        return {
          files: entries.filter(entry => entry.isFile()).map(entry => `${path}/${entry.name}`),
          folders: entries.filter(entry => entry.isDirectory()).map(entry => `${path}/${entry.name}`),
        };
      },
      write: (path: string, text: string) => fs.writeFile(join(root, path), text),
      read: (path: string) => fs.readFile(join(root, path), "utf8"),
      writeBinary: async (path: string, bytes: ArrayBuffer) => {
        binaryWrites += 1;
        maximumWriteBytes = Math.max(maximumWriteBytes, bytes.byteLength);
        await fs.writeFile(join(root, path), new Uint8Array(bytes));
      },
      readBinary: async (path: string) => {
        const bytes = await fs.readFile(join(root, path));
        binaryReads += 1;
        maximumReadBytes = Math.max(maximumReadBytes, bytes.byteLength);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      rename: (from: string, to: string) => fs.rename(join(root, from), join(root, to)),
      rmdir: (path: string, recursive: boolean) => fs.rm(join(root, path), { recursive }),
    };
    const plugin = {
      app: { vault: { configDir: ".obsidian", adapter } },
      manifest: { id: "systemsculpt-ai", version: "benchmark" },
      settings,
      getSettingsManager: () => ({
        updateSettings: async (update: typeof settings) => Object.assign(settings, update),
      }),
    } as unknown as SystemSculptPlugin;
    const staging = new AudioProcessorDeviceStaging(plugin);
    const stage = staging.stage.bind(staging);
    let stagingStart = 0;
    let stagingEnd = 0;
    jest.spyOn(staging, "stage").mockImplementation(async (...args) => {
      stagingStart = performance.now();
      const staged = await stage(...args);
      stagingEnd = performance.now();
      return staged;
    });
    const received = createHash("sha256");
    let receivedBytes = 0;
    let firstPartSend = 0;
    let sentParts = 0;
    const finished = new AudioProcessorApiError("Benchmark stops before server processing.", 400, "benchmark_finished");
    const api = {
      createAudioJob: async () => ({
        job: { id: "audio_benchmark", status: "uploading" },
        upload: { partSizeBytes: PART_SIZE_BYTES, totalParts: Math.ceil(SIZE_BYTES / PART_SIZE_BYTES) },
      }),
      getPartUrl: async (_jobId: string, partNumber: number) => ({ partNumber }),
      uploadPart: async (part: AudioProcessorSignedPart, bytes: ArrayBuffer) => {
        if (!firstPartSend) {
          firstPartSend = performance.now();
          // Checkpoint already names the complete ready manifest, before part 1.
          expect(settings.pendingAudioProcessorUploads[0]).toMatchObject({
            source: { kind: "staged" }, uploadedParts: [],
          });
          expect(binaryWrites).toBe(Math.ceil(SIZE_BYTES / (8 * 1024 * 1024)));
        }
        received.update(new Uint8Array(bytes));
        receivedBytes += bytes.byteLength;
        sentParts += 1;
        return { part_number: part.partNumber, etag: `benchmark-${part.partNumber}` };
      },
      completeUpload: async () => { throw finished; },
    } as unknown as AudioProcessorApiClient;
    const service = new AudioProcessorService(plugin, { apiClient: api, deviceStaging: staging });
    const start = performance.now();
    await expect(service.process({ type: "audio", audio: source }, {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "benchmark_finished" });
    const end = performance.now();
    expect(firstPartSend).toBeGreaterThanOrEqual(stagingEnd);
    expect(receivedBytes).toBe(SIZE_BYTES);
    expect(received.digest("hex")).toBe(expectedSha256);
    expect(settings.pendingAudioProcessorUploads[0].uploadedParts).toHaveLength(sentParts);
    const uploadReadCount = binaryReads;
    // Original device File is no longer needed. A new owner can read every byte.
    source.release();
    const descriptor = settings.pendingAudioProcessorUploads[0].source;
    if (descriptor.kind !== "staged") throw new Error("Expected a staged recovery descriptor.");
    const discovered = await new AudioProcessorDeviceStaging(plugin).openForJob("audio_benchmark");
    expect(discovered?.resumeDescriptor).toEqual(descriptor);
    discovered?.release();
    const restored = await new AudioProcessorDeviceStaging(plugin).open(descriptor);
    const restarted = createHash("sha256");
    try {
      for (let offset = 0; offset < SIZE_BYTES; offset += PART_SIZE_BYTES) {
        restarted.update(new Uint8Array(await restored.readSlice(offset, Math.min(SIZE_BYTES, offset + PART_SIZE_BYTES))));
      }
    } finally {
      restored.release();
    }
    expect(restarted.digest("hex")).toBe(expectedSha256);
    process.stdout.write(`${JSON.stringify({
      sizeBytes: SIZE_BYTES,
      settingsPersistence: "in-memory",
      uploadSink: "in-process-sha256",
      stagingMs: Number((stagingEnd - stagingStart).toFixed(2)),
      firstPartSendMs: Number((firstPartSend - start).toFixed(2)),
      localUploadPathMs: Number((end - start).toFixed(2)),
      binaryWrites,
      uploadReadCount,
      maximumWriteBytes,
      maximumReadBytes,
      sentParts,
      sha256: expectedSha256,
    })}\n`);
  } finally {
    source?.release();
    // Only this test's mkdtemp fixture and staging tree; never a user's vault.
    await fs.rm(root, { recursive: true, force: true });
  }
}, 600_000);
