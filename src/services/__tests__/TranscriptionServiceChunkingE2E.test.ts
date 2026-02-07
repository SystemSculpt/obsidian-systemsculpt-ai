/**
 * @jest-environment jsdom
 */

jest.mock("../../constants/uploadLimits", () => ({
  DOCUMENT_UPLOAD_MAX_BYTES: 4096,
  AUDIO_UPLOAD_MAX_BYTES: 4096,
}));

jest.mock("../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      // Mobile path should continue using client-side chunking (legacy endpoint per chunk).
      isMobile: jest.fn(() => true),
      preferredTransport: jest.fn(() => "requestUrl"),
      supportsStreaming: jest.fn(() => true),
    })),
  },
}));

jest.mock("../SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => ({
      baseUrl: "https://api.systemsculpt.com",
    })),
  },
}));

jest.mock("../AudioResampler", () => ({
  AudioResampler: jest.fn().mockImplementation(() => ({
    checkNeedsResampling: jest.fn().mockResolvedValue({ needsResampling: false, currentSampleRate: 16000 }),
    resampleAudio: jest.fn().mockResolvedValue({ buffer: new ArrayBuffer(100) }),
    dispose: jest.fn(),
  })),
}));

jest.mock("../../utils/SerialTaskQueue", () => ({
  SerialTaskQueue: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((fn: () => Promise<any>) => ({
      promise: fn(),
      ahead: 0,
    })),
    size: 0,
  })),
}));

jest.mock("../../utils/errorHandling", () => ({
  logDebug: jest.fn(),
  logInfo: jest.fn(),
  logWarning: jest.fn(),
  logError: jest.fn(),
  logMobileError: jest.fn(),
}));

import { requestUrl, TFile } from "obsidian";
import { AUDIO_UPLOAD_MAX_BYTES } from "../../constants/uploadLimits";
import { TranscriptionService } from "../TranscriptionService";

class FakeAudioBuffer {
  public readonly numberOfChannels: number;
  public readonly length: number;
  public readonly sampleRate: number;
  public readonly duration: number;

  private channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = this.length / this.sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }

  copyToChannel(source: Float32Array, channel: number, startInChannel: number = 0) {
    this.channels[channel].set(source, startInChannel);
  }
}

class FakeAudioContext {
  public state = "running";

  async decodeAudioData(): Promise<any> {
    const buffer = new FakeAudioBuffer(2, 3000, 16000);
    buffer.getChannelData(0).fill(0.5);
    buffer.getChannelData(1).fill(-0.5);
    return buffer as any;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): any {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate) as any;
  }

  async close() {
    this.state = "closed";
  }
}

class FakeOfflineAudioContext {
  constructor() {
    throw new Error("OfflineAudioContext should not be used in this test");
  }
}

describe("TranscriptionService chunking end-to-end", () => {
  let service: TranscriptionService;
  let mockPlugin: any;

  beforeAll(() => {
    (globalThis as any).AudioContext = FakeAudioContext;
    (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;

    if (typeof (globalThis as any).Blob !== "undefined") {
      (globalThis as any).Blob.prototype.arrayBuffer = function () {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.readAsArrayBuffer(this);
        });
      };
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockPlugin = {
      app: {
        vault: {
          readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(AUDIO_UPLOAD_MAX_BYTES + 1)),
          adapter: {
            basePath: "/test/vault",
          },
        },
      },
      settings: {
        licenseKey: "test-license-key",
        licenseValid: true,
        transcriptionProvider: "systemsculpt",
        enableAutoAudioResampling: true,
      },
      directoryManager: null,
    };

    (TranscriptionService as any).instance = undefined;
    service = TranscriptionService.getInstance(mockPlugin);
  });

  it.each(["mp3", "ogg"])("chunks and uploads WAV chunks for %s input", async (extension) => {
    (requestUrl as jest.Mock)
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/json" },
        json: { text: "Hello world this is an overlap phrase" },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/json" },
        json: { text: "an overlap phrase with continuation" },
      });

    let capturedChunkBlobs: Blob[] = [];
    const buildChunksOriginal = (service as any).buildWavChunkBlobs.bind(service);
    jest.spyOn(service as any, "buildWavChunkBlobs").mockImplementation(async (...args: any[]) => {
      const blobs = (await buildChunksOriginal(...args)) as Blob[];
      capturedChunkBlobs = blobs;
      return blobs;
    });

    const file = new TFile();
    (file as any).path = `big.${extension}`;
    (file as any).name = `big.${extension}`;
    (file as any).basename = "big";
    (file as any).extension = extension;
    (file as any).stat = { size: AUDIO_UPLOAD_MAX_BYTES + 1 };

    const result = await service.transcribeFile(file, {
      type: "note",
      timestamped: false,
      onProgress: jest.fn(),
      suppressNotices: true,
    });

    expect(result).toBe("Hello world this is an overlap phrase with continuation");
    expect(requestUrl).toHaveBeenCalledTimes(2);

    expect(capturedChunkBlobs).toHaveLength(2);
    expect(capturedChunkBlobs[0].type).toBe("audio/wav");
    expect(capturedChunkBlobs[0].size).toBeGreaterThan(44);

    for (const call of (requestUrl as jest.Mock).mock.calls) {
      const requestArgs = call[0];
      const body = requestArgs.body as ArrayBuffer;
      const bytes = new Uint8Array(body);
      const riffOffset = (() => {
        for (let i = 0; i < bytes.length - 4; i++) {
          if (
            bytes[i] === 0x52 && // R
            bytes[i + 1] === 0x49 && // I
            bytes[i + 2] === 0x46 && // F
            bytes[i + 3] === 0x46 // F
          ) {
            return i;
          }
        }
        return -1;
      })();

      expect(riffOffset).toBeGreaterThanOrEqual(0);
      const wavView = new DataView(body);
      expect(wavView.getUint16(riffOffset + 22, true)).toBe(1);
      expect(wavView.getUint32(riffOffset + 24, true)).toBe(16000);

      const text = new TextDecoder().decode(bytes.slice(0, 800));
      expect(text).toContain('filename="big.wav"');
      expect(text).toContain("Content-Type: audio/wav");
    }
  });
});
