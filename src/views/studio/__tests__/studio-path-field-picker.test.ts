/**
 * @jest-environment jsdom
 */
import type { StudioNodeConfigFieldDefinition } from "../../../studio/types";
import { browseForNodeConfigPath } from "../StudioPathFieldPicker";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidian = require("obsidian");

function createField(
  overrides: Partial<StudioNodeConfigFieldDefinition> = {}
): StudioNodeConfigFieldDefinition {
  return {
    key: "sourcePath",
    label: "Source Path",
    type: "media_path",
    required: false,
    ...overrides,
  } as StudioNodeConfigFieldDefinition;
}

function createHost(): HTMLElement {
  return document.body.createDiv({ cls: "studio-picker-host" });
}

function mockNextSelection(options: {
  files: File[];
  value?: string;
}): jest.SpyInstance {
  return jest.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function mockClick() {
    Object.defineProperty(this, "files", {
      configurable: true,
      value: options.files,
    });
    Object.defineProperty(this, "value", {
      configurable: true,
      get: () => options.value ?? "",
      set: () => {},
    });
    this.dispatchEvent(new Event("change"));
  });
}

describe("browseForNodeConfigPath", () => {
  let noticeSpy: jest.SpyInstance;

  beforeEach(() => {
    noticeSpy = jest
      .spyOn(obsidian as any, "Notice")
      .mockImplementation(function noticeStub() {
        return {};
      } as any);
  });

  afterEach(() => {
    noticeSpy.mockRestore();
    jest.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("imports pathless browser files instead of trusting the bare input value", async () => {
    const file = new File(["png"], "poster.png", { type: "image/png" });
    const importer = jest.fn(async () => "SystemSculpt/Studio/Test.systemsculpt-assets/imports/poster-deadbeefcafe.png");
    const clickSpy = mockNextSelection({
      files: [file],
      value: "poster.png",
    });

    const result = await browseForNodeConfigPath(createField(), createHost(), {
      importFileWithoutOsPath: importer,
    });

    expect(result).toBe(
      "SystemSculpt/Studio/Test.systemsculpt-assets/imports/poster-deadbeefcafe.png"
    );
    expect(importer).toHaveBeenCalledWith(file, expect.objectContaining({ key: "sourcePath" }));
    expect(noticeSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("keeps the desktop filesystem path when File.path is available", async () => {
    const file = new File(["png"], "poster.png", { type: "image/png" });
    Object.defineProperty(file, "path", {
      configurable: true,
      value: "/vault/Assets/poster.png",
    });
    const importer = jest.fn(async () => "should-not-run");
    const clickSpy = mockNextSelection({
      files: [file],
      value: "poster.png",
    });

    const result = await browseForNodeConfigPath(createField(), createHost(), {
      importFileWithoutOsPath: importer,
    });

    expect(result).toBe("/vault/Assets/poster.png");
    expect(importer).not.toHaveBeenCalled();
    expect(noticeSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("blocks directory selection when the browser cannot provide a real path", async () => {
    const file = new File(["nested"], "example.txt", { type: "text/plain" });
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: "Folder/example.txt",
    });
    const clickSpy = mockNextSelection({
      files: [file],
      value: "example.txt",
    });

    const result = await browseForNodeConfigPath(
      createField({ key: "folderPath", label: "Folder", type: "directory_path" }),
      createHost()
    );

    expect(result).toBeNull();
    expect(noticeSpy).toHaveBeenCalledWith("Folder paths require the desktop app.");
    clickSpy.mockRestore();
  });
});
