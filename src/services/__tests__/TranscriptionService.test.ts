jest.mock("../transcription/TranscriptionCoordinator", () => ({
  TranscriptionCoordinator: jest.fn().mockImplementation(() => ({
    transcribeFile: jest.fn().mockResolvedValue("managed transcript"),
    abort: jest.fn(),
  })),
}));

import { TranscriptionCoordinator } from "../transcription/TranscriptionCoordinator";
import { TranscriptionService } from "../TranscriptionService";

describe("TranscriptionService", () => {
  beforeEach(() => {
    TranscriptionService.clearInstance();
    jest.clearAllMocks();
  });

  it("is a thin compatibility facade over the managed coordinator", async () => {
    const plugin = { app: {} } as any;
    const file = { path: "recordings/demo.webm" } as any;
    const service = TranscriptionService.getInstance(plugin);

    await expect(service.transcribeFile(file, { type: "note", timestamped: true })).resolves.toBe("managed transcript");

    const coordinator = (TranscriptionCoordinator as jest.Mock).mock.results[0].value;
    expect(coordinator.transcribeFile).toHaveBeenCalledWith(file, { type: "note", timestamped: true });
  });

  it("aborts its coordinator on plugin unload", () => {
    const service = TranscriptionService.getInstance({ app: {} } as any);
    const coordinator = (TranscriptionCoordinator as jest.Mock).mock.results[0].value;
    service.unload();
    expect(coordinator.abort).toHaveBeenCalledTimes(1);
  });
});
