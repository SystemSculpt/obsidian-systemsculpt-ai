import { imageGenerationNode } from "../nodes/imageGenerationNode";
import { videoGenerationNode } from "../nodes/videoGenerationNode";
import type { StudioImageGenerationInput, StudioImageGenerationRequest, StudioVideoGenerationRequest } from "../types";

describe.each([
  ["image references", imageGenerationNode, "images"],
  ["video frames", videoGenerationNode, "first_frame"],
] as const)("Studio %s asset admission", (_label, definition, port) => {
  function fixture(candidate: unknown) {
    let admitted: StudioImageGenerationInput[] = [];
    const bytes = new Uint8Array([1, 2]).buffer;
    const asset = { path: "assets/input.jpg", hash: "a".repeat(64), sizeBytes: 2, mimeType: "image/jpeg" };
    const services = {
      readAsset: jest.fn(async () => bytes),
      readVaultBinary: jest.fn(async () => bytes),
      readLocalFileBinary: jest.fn(async () => bytes),
      assertFilesystemPath: jest.fn((_path: string) => {}),
      storeAsset: jest.fn(async () => asset),
      api: {
        generateImage: jest.fn(async (request: StudioImageGenerationRequest) => {
          admitted = (await request.buildPayload()).inputImages || [];
          return { images: [] };
        }),
        generateVideo: jest.fn(async (request: StudioVideoGenerationRequest) => {
          admitted = (await request.buildPayload()).frameImages || [];
          return { videos: [] };
        }),
      },
    };
    const execute = () => definition.execute({
      runId: "run", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
      node: { id: "node", kind: definition.kind, version: definition.version, title: "Media",
        position: { x: 0, y: 0 }, config: { ...definition.configDefaults, prompt: "A fox", model: "video-model" } },
      inputs: { [port]: [candidate] }, services, log: jest.fn(),
    } as never);
    return { services, execute, admitted: () => admitted, asset, bytes };
  }

  it("keeps existing staged assets lazy and normalizes their metadata", async () => {
    const run = fixture({ path: "assets/already.jpg", hash: "B".repeat(64), sizeBytes: 3,
      mimeType: "IMAGE/JPG" });
    await run.execute();
    expect(run.services.readAsset).not.toHaveBeenCalled();
    expect(run.services.readVaultBinary).not.toHaveBeenCalled();
    expect(run.services.readLocalFileBinary).not.toHaveBeenCalled();
    expect(run.services.storeAsset).not.toHaveBeenCalled();
    const [input] = run.admitted();
    expect(input.asset).toEqual({ path: "assets/already.jpg", hash: "b".repeat(64), sizeBytes: 3,
      mimeType: "image/jpeg" });
    await expect(input.load()).resolves.toBe(run.bytes);
    expect(run.services.readAsset).toHaveBeenCalledWith(input.asset);
  });

  it("stages a vault path once before exposing its lazy asset loader", async () => {
    const run = fixture("refs/portrait.jpg");
    await run.execute();
    expect(run.services.readVaultBinary).toHaveBeenCalledWith("refs/portrait.jpg");
    expect(run.services.storeAsset).toHaveBeenCalledTimes(1);
    expect(run.services.storeAsset).toHaveBeenCalledWith(run.bytes, "image/jpeg");
    expect(run.services.readLocalFileBinary).not.toHaveBeenCalled();
    expect(run.services.readAsset).not.toHaveBeenCalled();
    expect(run.admitted()[0].asset).toEqual(run.asset);
    await run.admitted()[0].load();
    expect(run.services.readAsset).toHaveBeenCalledWith(run.asset);
  });

  it("checks external path permission before reading or staging bytes", async () => {
    const run = fixture("/private/portrait.jpg");
    run.services.assertFilesystemPath.mockImplementation(() => { throw new Error("Permission denied"); });
    await expect(run.execute()).rejects.toThrow("Permission denied");
    expect(run.services.assertFilesystemPath).toHaveBeenCalledWith("/private/portrait.jpg");
    expect(run.services.readLocalFileBinary).not.toHaveBeenCalled();
    expect(run.services.readVaultBinary).not.toHaveBeenCalled();
    expect(run.services.storeAsset).not.toHaveBeenCalled();
  });
});
