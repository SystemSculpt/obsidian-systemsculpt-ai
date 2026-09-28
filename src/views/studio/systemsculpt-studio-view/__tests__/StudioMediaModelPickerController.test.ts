import type SystemSculptPlugin from "../../../../main";
import type { StudioNodeInstance } from "../../../../studio/types";
import { getStudioMediaCatalogs } from "../../../../studio/StudioMediaCatalogs";
import { openStudioMediaModelPickerModal } from "../../canvas/StudioMediaModelPickerModal";
import { StudioMediaModelPickerController } from "../StudioMediaModelPickerController";

jest.mock("../../../../studio/StudioMediaCatalogs");
jest.mock("../../canvas/StudioMediaModelPickerModal");
jest.mock("../../canvas/studioMediaModelFavorites", () => ({ readMediaModelFavorites: () => [], toggleMediaModelFavorite: jest.fn() }));

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const node = { id: "image", kind: "studio.image_generation", config: {} } as StudioNodeInstance;

describe("Studio model picker lifetime", () => {
  beforeEach(() => jest.clearAllMocks());

  function fixture() {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const catalog = { peek: () => null, load: jest.fn(async () => {
      await pending;
      return { models: [{ id: "model", name: "Model" }], defaultModelId: "model" };
    }) };
    jest.mocked(getStudioMediaCatalogs).mockReturnValue({ images: catalog, videos: catalog } as unknown as ReturnType<typeof getStudioMediaCatalogs>);
    const requestRender = jest.fn();
    const controller = new StudioMediaModelPickerController({ plugin: () => ({ app: {} }) as SystemSculptPlugin, requestRender });
    return { controller, requestRender, release };
  }

  it("does not repaint a closed view when catalog warming finishes", async () => {
    const { controller, requestRender, release } = fixture();
    controller.planInputs(node);
    controller.dispose();
    release();
    await settle();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("does not open a pending model dialog after the owning view closes", async () => {
    const { controller, release } = fixture();
    controller.open("image_generation_models", node, "", jest.fn());
    controller.dispose();
    release();
    await settle();
    expect(openStudioMediaModelPickerModal).not.toHaveBeenCalled();
  });

  it("closes an already opened model dialog when the owning view closes", async () => {
    const { controller, release } = fixture();
    const modal = { close: jest.fn() };
    jest.mocked(openStudioMediaModelPickerModal).mockReturnValue(modal as unknown as ReturnType<typeof openStudioMediaModelPickerModal>);
    controller.open("image_generation_models", node, "", jest.fn());
    release();
    await settle();
    expect(openStudioMediaModelPickerModal).toHaveBeenCalledTimes(1);
    controller.dispose();
    expect(modal.close).toHaveBeenCalledTimes(1);
  });
  it("keeps the latest picker when an earlier catalog request resolves last", async () => {
    const { controller } = fixture();
    let releaseImages!: () => void;
    const imagesPending = new Promise<void>(resolve => { releaseImages = resolve; });
    const imageModel = { id: "image-model", name: "Image model" };
    const videoModel = { id: "video-model", name: "Video model" };
    jest.mocked(getStudioMediaCatalogs).mockReturnValue({
      images: { load: async () => { await imagesPending; return { models: [imageModel] }; } },
      videos: { load: async () => ({ models: [videoModel] }) },
    } as unknown as ReturnType<typeof getStudioMediaCatalogs>);
    const modal = { close: jest.fn() };
    jest.mocked(openStudioMediaModelPickerModal).mockReturnValue(modal as unknown as ReturnType<typeof openStudioMediaModelPickerModal>);
    const imageSelection = jest.fn();
    const videoSelection = jest.fn();
    controller.open("image_generation_models", node, "", imageSelection);
    controller.open("video_generation_models", { ...node, id: "video", kind: "studio.video_generation" }, "", videoSelection);
    await settle();
    expect(openStudioMediaModelPickerModal).toHaveBeenCalledTimes(1);
    expect(jest.mocked(openStudioMediaModelPickerModal).mock.calls[0][1].kind).toBe("video");
    releaseImages();
    await settle();
    expect(openStudioMediaModelPickerModal).toHaveBeenCalledTimes(1);
    expect(modal.close).not.toHaveBeenCalled();
    const options = jest.mocked(openStudioMediaModelPickerModal).mock.calls[0][1];
    options.onSelect(options.models[0]);
    expect(videoSelection).toHaveBeenCalledWith("video-model", "Video model");
    expect(imageSelection).not.toHaveBeenCalled();
    controller.dispose();
  });

});
