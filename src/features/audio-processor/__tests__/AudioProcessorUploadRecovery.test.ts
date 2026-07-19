import { AudioProcessorUploadRecovery } from "../AudioProcessorUploadRecovery";
import type { AudioProcessorAudioSource } from "../types";

function vaultSource(name: string): AudioProcessorAudioSource {
  return {
    filename: `${name}.m4a`,
    contentType: "audio/mp4",
    sizeBytes: 8,
    resumeDescriptor: {
      kind: "vault",
      filePath: `Meetings/${name}.m4a`,
      modifiedAt: 1,
    },
    readSlice: async () => new ArrayBuffer(0),
    release: () => undefined,
  };
}

describe("AudioProcessorUploadRecovery", () => {
  it("serializes full-array checkpoint mutations across separate service stores", async () => {
    const settings = { pendingAudioProcessorUploads: [] as any[] };
    const updateSettings = jest.fn(async (update: { pendingAudioProcessorUploads?: any[] }) => {
      await Promise.resolve();
      settings.pendingAudioProcessorUploads = [
        ...(update.pendingAudioProcessorUploads ?? []),
      ];
    });
    const plugin = {
      settings,
      getSettingsManager: () => ({ updateSettings }),
    } as any;
    const first = new AudioProcessorUploadRecovery(plugin);
    const second = new AudioProcessorUploadRecovery(plugin);

    await Promise.all([
      first.rememberStarted(
        "audio_job_one",
        vaultSource("one"),
        { partSizeBytes: 4, totalParts: 2 },
      ),
      second.rememberStarted(
        "audio_job_two",
        vaultSource("two"),
        { partSizeBytes: 4, totalParts: 2 },
      ),
    ]);

    expect(settings.pendingAudioProcessorUploads.map((entry) => entry.jobId).sort()).toEqual([
      "audio_job_one",
      "audio_job_two",
    ]);
    expect(updateSettings).toHaveBeenCalledTimes(2);
  });
});
