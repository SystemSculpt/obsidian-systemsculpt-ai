/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { desktopHost, hasNodeRuntime } from "../../../platform/desktopOnly";
import {
  createDeviceAudioSource,
  createVaultAudioSource,
} from "../audioSource";
import { AUDIO_PROCESSOR_MAX_AUDIO_BYTES } from "../types";

jest.mock("../../../platform/desktopOnly", () => ({
  desktopHost: { fs: jest.fn() },
  hasNodeRuntime: jest.fn(),
}));

const mockHasNodeRuntime = hasNodeRuntime as jest.MockedFunction<typeof hasNodeRuntime>;
const mockDesktopFs = desktopHost.fs as jest.Mock;

describe("Audio Processor audio sources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasNodeRuntime.mockReturnValue(false);
  });

  it("uses canonical media types and bounded File slices for device audio", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const slice = jest.fn((start: number, end: number) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }));
    const file = {
      name: "audio.m4a",
      type: "application/octet-stream",
      size: bytes.byteLength,
      slice,
    } as unknown as File;

    const source = createDeviceAudioSource(file);
    expect(source.contentType).toBe("audio/mp4");
    await expect(source.readSlice(2, 5)).resolves.toEqual(bytes.slice(2, 5).buffer);
    expect(slice).toHaveBeenCalledWith(2, 5);
  });

  it("accepts the one-GB boundary but rejects a larger source", () => {
    const atLimit = {
      name: "long-audio.mp3",
      type: "audio/mpeg",
      size: AUDIO_PROCESSOR_MAX_AUDIO_BYTES,
      slice: jest.fn(),
    } as unknown as File;
    const overLimit = {
      ...atLimit,
      size: AUDIO_PROCESSOR_MAX_AUDIO_BYTES + 1,
    } as unknown as File;

    expect(createDeviceAudioSource(atLimit).sizeBytes)
      .toBe(AUDIO_PROCESSOR_MAX_AUDIO_BYTES);
    expect(() => createDeviceAudioSource(overLimit)).toThrow("up to 1 GB");
  });

  it("refuses an unbounded vault read when the host has no range-read seam", () => {
    const app = new App();
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const file = new (TFile as any)({
      path: "Meetings/long.webm",
      name: "long.webm",
      extension: "webm",
      stat: { size: bytes.byteLength, ctime: 1, mtime: 1 },
    }) as TFile;
    (app.vault as any).readBinary = jest.fn().mockResolvedValue(bytes.buffer);

    expect(() => createVaultAudioSource(app, file)).toThrow(
      "choose this recording from Device",
    );
    expect(app.vault.readBinary).not.toHaveBeenCalled();
  });

  it("uses bounded filesystem reads for large desktop vault audio", async () => {
    mockHasNodeRuntime.mockReturnValue(true);
    const app = new App();
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const file = new (TFile as any)({
      path: "Meetings/long.flac",
      name: "long.flac",
      extension: "flac",
      stat: { size: bytes.byteLength, ctime: 1, mtime: 1 },
    }) as TFile;
    const close = jest.fn().mockResolvedValue(undefined);
    const handle = {
      stat: jest.fn().mockResolvedValue({ size: bytes.byteLength, mtimeMs: 1 }),
      read: jest.fn(async (
        target: Uint8Array,
        _offset: number,
        length: number,
        position: number,
      ) => {
        target.set(bytes.slice(position, position + length));
        return { bytesRead: length, buffer: target };
      }),
      close,
    };
    const open = jest.fn().mockResolvedValue(handle);
    mockDesktopFs.mockReturnValue({ open });
    (app.vault as any).adapter = {
      getFullPath: jest.fn().mockReturnValue("/vault/Meetings/long.flac"),
    };

    const source = createVaultAudioSource(app, file);
    await expect(source.readSlice(1, 4)).resolves.toEqual(bytes.slice(1, 4).buffer);

    expect(open).toHaveBeenCalledWith("/vault/Meetings/long.flac", "r");
    expect(handle.read).toHaveBeenCalledWith(expect.any(Uint8Array), 0, 3, 1);
    expect((app.vault as any).readBinary).toBeUndefined();
    source.release();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
