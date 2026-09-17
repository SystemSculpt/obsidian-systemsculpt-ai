import type { App } from "obsidian";
import { StudioAssetPreviewController } from "../StudioAssetPreviewController";
jest.mock("../canvas/StudioGraphMediaPreviewModal", () => ({ resolveStudioAssetPreviewSrc: (_app: unknown, path: string) => `app://vault/${path}` }));

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

describe("Studio asset arrival", () => {
  it("does not issue a resource URL until the file exists, then wakes on arrival", async () => {
    let exists = false;
    const changed = jest.fn();
    const check = jest.fn(async () => exists);
    const controller = new StudioAssetPreviewController({ vault: { adapter: { exists: check } } } as unknown as App, changed);
    expect(controller.resolve("assets/photo.png")).toBeNull();
    await settle();
    for (let i = 0; i < 30; i += 1) expect(controller.resolve("assets/photo.png")).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    exists = true;
    controller.invalidate("assets/photo.png");
    expect(controller.resolve("assets/photo.png")).toBeNull();
    await settle();
    expect(controller.resolve("assets/photo.png")).toBe("app://vault/assets/photo.png");
    controller.dispose();
  });

  it("restores an archived asset without launching a generation", async () => {
    const restore = jest.fn(async () => true);
    const controller = new StudioAssetPreviewController({ vault: { adapter: { exists: async () => false } } } as unknown as App, jest.fn(), restore);
    controller.resolve("assets/photo.png");
    await settle();
    expect(restore).toHaveBeenCalledWith("assets/photo.png");
    expect(controller.resolve("assets/photo.png")).toBe("app://vault/assets/photo.png");
    controller.dispose();
  });

  it("bounds parallel file checks and suppresses callbacks after close", async () => {
    let release!: (exists: boolean) => void;
    const blocked = new Promise<boolean>(resolve => { release = resolve; });
    const check = jest.fn(() => blocked), changed = jest.fn();
    const controller = new StudioAssetPreviewController({ vault: { adapter: { exists: check } } } as unknown as App, changed);
    for (let i = 0; i < 20; i += 1) controller.resolve(`assets/${i}.png`);
    expect(check).toHaveBeenCalledTimes(4);
    controller.dispose();
    release(true);
    await settle();
    expect(changed).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(4);
  });
});
