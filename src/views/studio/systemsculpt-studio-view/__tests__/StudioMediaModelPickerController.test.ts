import type SystemSculptPlugin from "../../../../main";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeInstance } from "../../../../studio/types";
import { getStudioMediaCatalogs } from "../../../../studio/StudioMediaCatalogs";
import { openStudioMediaModelPickerModal } from "../../canvas/StudioMediaModelPickerModal";
import { StudioMediaModelPickerController } from "../StudioMediaModelPickerController";

jest.mock("../../../../studio/StudioMediaCatalogs");
jest.mock("../../canvas/StudioMediaModelPickerModal");
jest.mock("../../canvas/studioMediaModelFavorites", () => ({ readMediaModelFavorites: () => [], toggleMediaModelFavorite: jest.fn() }));

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const node = { id: "video", kind: "studio.video_generation", config: {} } as StudioNodeInstance;

describe("Studio model picker lifetime", () => {
  beforeEach(() => jest.clearAllMocks());

  function fixture() {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const catalog = { peek: () => null, load: jest.fn(async () => {
      await pending;
      return { models: [{ id: "model", name: "Model" }] };
    }) };
    jest.mocked(getStudioMediaCatalogs).mockReturnValue({ videos: catalog } as unknown as ReturnType<typeof getStudioMediaCatalogs>);
    const requestRender = jest.fn();
    const controller = new StudioMediaModelPickerController({ plugin: () => ({ app: {} }) as SystemSculptPlugin, requestRender });
    return { controller, catalog, requestRender, release };
  }

  it("does not load a catalog or open a picker for retired image controls", async () => {
    const { controller, catalog, release } = fixture();
    const imageNode = { ...node, id: "image", kind: "studio.image_generation" };
    expect(controller.planInputs(imageNode)).toBeNull();
    controller.open("image_models" as StudioNodeConfigDynamicOptionsSource, imageNode, "saved/image", jest.fn());
    controller.open("video_generation_models", imageNode, "saved/image", jest.fn());
    release();
    await settle();
    expect(getStudioMediaCatalogs).not.toHaveBeenCalled();
    expect(catalog.load).not.toHaveBeenCalled();
    expect(openStudioMediaModelPickerModal).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("warms a video catalog once for concurrent card renders", async () => {
    const { controller, catalog, requestRender, release } = fixture();
    expect(controller.planInputs(node)).toMatchObject({ kind: "video", model: null });
    controller.planInputs(node);
    expect(catalog.load).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(requestRender).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

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
    controller.open("video_generation_models", node, "", jest.fn());
    controller.dispose();
    release();
    await settle();
    expect(openStudioMediaModelPickerModal).not.toHaveBeenCalled();
  });

  it("closes an already opened model dialog when the owning view closes", async () => {
    const { controller, release } = fixture();
    const modal = { close: jest.fn() };
    jest.mocked(openStudioMediaModelPickerModal).mockReturnValue(modal as unknown as ReturnType<typeof openStudioMediaModelPickerModal>);
    controller.open("video_generation_models", node, "", jest.fn());
    release();
    await settle();
    expect(openStudioMediaModelPickerModal).toHaveBeenCalledTimes(1);
    expect(jest.mocked(openStudioMediaModelPickerModal).mock.calls[0][1]).toMatchObject({ kind: "video", selectedId: "" });
    controller.dispose();
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest picker when an earlier catalog request resolves last", async () => {
    const { controller } = fixture();
    let releaseEarlier!: () => void;
    const earlierPending = new Promise<void>(resolve => { releaseEarlier = resolve; });
    const earlierModel = { id: "earlier-model", name: "Earlier model" };
    const latestModel = { id: "latest-model", name: "Latest model" };
    jest.mocked(getStudioMediaCatalogs).mockReturnValue({
      videos: { load: jest.fn()
        .mockImplementationOnce(async () => { await earlierPending; return { models: [earlierModel] }; })
        .mockResolvedValue({ models: [latestModel] }) },
    } as unknown as ReturnType<typeof getStudioMediaCatalogs>);
    const modal = { close: jest.fn() };
    jest.mocked(openStudioMediaModelPickerModal).mockReturnValue(modal as unknown as ReturnType<typeof openStudioMediaModelPickerModal>);
    const earlierSelection = jest.fn();
    const latestSelection = jest.fn();
    controller.open("video_generation_models", node, "earlier-model", earlierSelection);
    controller.open("video_generation_models", { ...node, id: "other-video" }, "latest-model", latestSelection);
    await settle();
    expect(openStudioMediaModelPickerModal).toHaveBeenCalledTimes(1);
    expect(jest.mocked(openStudioMediaModelPickerModal).mock.calls[0][1].selectedId).toBe("latest-model");
    releaseEarlier();
    await settle();
    expect(openStudioMediaModelPickerModal).toHaveBeenCalledTimes(1);
    expect(modal.close).not.toHaveBeenCalled();
    const options = jest.mocked(openStudioMediaModelPickerModal).mock.calls[0][1];
    options.onSelect(options.models[0]);
    expect(latestSelection).toHaveBeenCalledWith("latest-model", "Latest model");
    expect(earlierSelection).not.toHaveBeenCalled();
    controller.dispose();
  });
});
