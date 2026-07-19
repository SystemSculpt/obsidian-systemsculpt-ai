const mockInstances: Array<{
  start: jest.Mock;
  transcribeFile: jest.Mock;
  abort: jest.Mock;
  getActiveOperationId: jest.Mock;
  acknowledgeCompleted: jest.Mock;
}> = [];
const mockStart = jest.fn();
const mockTranscribeFile = jest.fn();

jest.mock("../transcription/TranscriptionCoordinator", () => ({
  TranscriptionCoordinator: jest.fn().mockImplementation(() => {
    const instance = {
      start: jest.fn((request) => mockStart(request)),
      transcribeFile: jest.fn((file, context, commit) => (
        mockTranscribeFile(file, context, commit)
      )),
      abort: jest.fn(),
      getActiveOperationId: jest.fn(() => "transcription-op-1"),
      acknowledgeCompleted: jest.fn().mockResolvedValue(undefined),
    };
    mockInstances.push(instance);
    return instance;
  }),
}));

import { TranscriptionCoordinator } from "../transcription/TranscriptionCoordinator";
import { TranscriptionService } from "../TranscriptionService";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const completedResult = {
  operationId: "transcription-op-1",
  text: "managed transcript",
  outputPath: "recordings/demo - transcript.md",
  insertedIntoOrigin: false,
  sourceDisposition: "kept" as const,
};

describe("TranscriptionService", () => {
  beforeEach(() => {
    TranscriptionService.clearInstance();
    jest.clearAllMocks();
    mockInstances.length = 0;
    mockStart.mockReset().mockResolvedValue(completedResult);
    mockTranscribeFile.mockReset().mockImplementation(
      async (_file, _context, commit: (text: string) => Promise<unknown>) => (
        commit("managed transcript")
      ),
    );
  });

  afterEach(() => {
    TranscriptionService.clearInstance();
  });

  it("wraps a caller-owned durable commit without persisting a second output", async () => {
    const plugin = { app: {} } as any;
    const file = { path: "recordings/demo.webm" } as any;
    const context = { type: "note" as const, timestamped: true };
    const commit = jest.fn(async () => "Extractions/demo/transcript.md");
    const service = TranscriptionService.getInstance(plugin);

    await expect(service.transcribeFile(file, context, commit))
      .resolves.toBe("Extractions/demo/transcript.md");

    expect(TranscriptionCoordinator).toHaveBeenCalledTimes(1);
    expect(mockInstances[0].transcribeFile).toHaveBeenCalledWith(file, context, commit);
  });

  it("returns a cancellable task whose cancellation is scoped to its coordinator", async () => {
    const pending = deferred<typeof completedResult>();
    mockStart.mockReturnValueOnce(pending.promise);
    const service = TranscriptionService.getInstance({ app: {} } as any);
    const request = {
      filePath: "recordings/demo.webm",
      destination: "note" as const,
      targetEditor: { replaceSelection: jest.fn() } as any,
      validateInsertionTarget: jest.fn(() => true),
    };

    const task = service.start(request);
    task.cancel();

    expect(mockInstances[0].start).toHaveBeenCalledWith(request);
    expect(mockInstances[0].abort).toHaveBeenCalledTimes(1);
    pending.resolve(completedResult);
    await expect(task.promise).resolves.toEqual(completedResult);
  });

  it("acknowledges a completed operation through a short-lived coordinator", async () => {
    const service = TranscriptionService.getInstance({ app: {} } as any);

    await service.acknowledgeCompleted("completed-op");
    service.unload();

    expect(mockInstances[0].acknowledgeCompleted).toHaveBeenCalledWith("completed-op");
    expect(mockInstances[0].abort).not.toHaveBeenCalled();
  });

  it("does not let one transcription task cancel an unrelated task", async () => {
    const first = deferred<typeof completedResult>();
    const second = deferred<typeof completedResult>();
    mockStart
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const service = TranscriptionService.getInstance({ app: {} } as any);

    const firstTask = service.start({
      filePath: "recordings/first.webm",
      destination: "note",
    });
    const secondTask = service.start({
      filePath: "recordings/second.webm",
      destination: "chat",
    });
    firstTask.cancel();

    expect(mockInstances).toHaveLength(2);
    expect(mockInstances[0].abort).toHaveBeenCalledTimes(1);
    expect(mockInstances[1].abort).not.toHaveBeenCalled();

    first.resolve(completedResult);
    second.resolve({ ...completedResult, operationId: "transcription-op-2" });
    await Promise.all([firstTask.promise, secondTask.promise]);
  });

  it("aborts every active coordinator on plugin unload", async () => {
    const first = deferred<typeof completedResult>();
    const second = deferred<typeof completedResult>();
    mockStart
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const service = TranscriptionService.getInstance({ app: {} } as any);
    const firstTask = service.start({ filePath: "first.webm", destination: "note" });
    const secondTask = service.start({ filePath: "second.webm", destination: "chat" });

    service.unload();

    expect(mockInstances[0].abort).toHaveBeenCalledTimes(1);
    expect(mockInstances[1].abort).toHaveBeenCalledTimes(1);
    first.resolve(completedResult);
    second.resolve(completedResult);
    await Promise.all([firstTask.promise, secondTask.promise]);
  });

  it("does not retain or abort a task after it settles", async () => {
    const service = TranscriptionService.getInstance({ app: {} } as any);
    const task = service.start({ filePath: "recordings/demo.webm", destination: "note" });
    await task.promise;

    service.unload();

    expect(mockInstances[0].abort).not.toHaveBeenCalled();
  });
});
