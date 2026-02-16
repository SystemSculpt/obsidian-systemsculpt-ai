import {
  deriveCanvasFlowPromptUiDefaults,
  syncCanvasFlowAspectRatioPresetControls,
} from "../CanvasFlowPromptNodeState";

type MockOption = {
  value: string;
  text: string;
};

type MockSelect = HTMLSelectElement & {
  __removeCount: number;
  __createCount: number;
  __optionsRef: MockOption[];
};

function createMockSelect(initialOptions: MockOption[] = []): MockSelect {
  const options = initialOptions.map((opt) => ({ ...opt }));
  const select: any = {
    options,
    value: options[0]?.value || "",
    dataset: {},
    ownerDocument: {
      activeElement: null as unknown,
    },
    __removeCount: 0,
    __createCount: 0,
    __optionsRef: options,
    remove(index: number) {
      this.__removeCount += 1;
      this.options.splice(index, 1);
    },
    createEl(_tag: string, attrs: { value: string; text: string }) {
      this.__createCount += 1;
      const option = { value: String(attrs.value || ""), text: String(attrs.text || "") };
      this.options.push(option);
      return option;
    },
  };
  return select as MockSelect;
}

function createMockHelpElement(): HTMLElement {
  const helpEl: any = {
    textContent: "",
    setText(text: string) {
      this.textContent = String(text || "");
      return this;
    },
  };
  return helpEl as HTMLElement;
}

describe("CanvasFlowPromptNodeState", () => {
  it("derives image defaults from frontmatter and prompt config", () => {
    const defaults = deriveCanvasFlowPromptUiDefaults({
      frontmatter: {
        ss_image_width: 1280,
        ss_image_height: 720,
        ss_image_options: {
          aspect_ratio: "16:9",
          resolution: "2K",
          output_format: "png",
          safety_filter_level: "block_medium_and_above",
        },
      },
      promptConfig: {
        kind: "prompt",
        backend: "openrouter",
        imageModelId: "openai/gpt-5-image-mini",
        imageCount: 3,
        aspectRatio: null,
        seed: null,
      },
    });

    expect(defaults.imageCount).toBe(3);
    expect(defaults.width).toBe(1280);
    expect(defaults.height).toBe(720);
    expect(defaults.preferredAspectRatio).toBe("16:9");
    expect(defaults.nanoDefaults.aspect_ratio).toBe("16:9");
    expect(defaults.nanoDefaults.resolution).toBe("2K");
    expect(defaults.nanoDefaults.output_format).toBe("png");
    expect(defaults.nanoDefaults.safety_filter_level).toBe("block_medium_and_above");
  });

  it("uses prompt-config aspect ratio and clamps image count", () => {
    const defaults = deriveCanvasFlowPromptUiDefaults({
      frontmatter: {
        ss_image_options: {
          width: 1024,
          height: 1024,
        },
      },
      promptConfig: {
        kind: "prompt",
        backend: "openrouter",
        imageModelId: "openai/gpt-5-image-mini",
        imageCount: 20,
        aspectRatio: "9:16",
        seed: null,
      },
    });

    expect(defaults.imageCount).toBe(4);
    expect(defaults.width).toBe(1024);
    expect(defaults.height).toBe(1024);
    expect(defaults.preferredAspectRatio).toBe("9:16");
  });

  it("falls back to nano defaults when image options are absent", () => {
    const defaults = deriveCanvasFlowPromptUiDefaults({
      frontmatter: {},
      promptConfig: {
        kind: "prompt",
        backend: "openrouter",
        imageModelId: "openai/gpt-5-image-mini",
        imageCount: 1,
        aspectRatio: null,
        seed: null,
      },
    });

    expect(defaults.nanoDefaults).toEqual({
      aspect_ratio: "match_input_image",
      resolution: "4K",
      output_format: "jpg",
      safety_filter_level: "block_only_high",
    });
  });

  it("keeps aspect-ratio select sync idempotent when options are unchanged", () => {
    const select = createMockSelect();
    const helpEl = createMockHelpElement();

    syncCanvasFlowAspectRatioPresetControls({
      select,
      modelId: "openai/gpt-5-image-mini",
      preferred: "1:1",
      helpEl,
    });
    const removeCountAfterFirstSync = select.__removeCount;
    const createCountAfterFirstSync = select.__createCount;

    syncCanvasFlowAspectRatioPresetControls({
      select,
      modelId: "openai/gpt-5-image-mini",
      preferred: "1:1",
      helpEl,
    });

    expect(select.__removeCount).toBe(removeCountAfterFirstSync);
    expect(select.__createCount).toBe(createCountAfterFirstSync);
    expect(select.value).toBe("1:1");
  });

  it("defers option mutation while the aspect-ratio select is focused", () => {
    const select = createMockSelect([{ value: "1:1", text: "1:1 Square" }]);
    const helpEl = createMockHelpElement();
    (select.ownerDocument as any).activeElement = select;

    syncCanvasFlowAspectRatioPresetControls({
      select,
      modelId: "openai/gpt-5-image-mini",
      preferred: "16:9",
      helpEl,
      deferWhileFocused: true,
    });

    expect(select.dataset.ssCanvasflowAspectSyncDeferred).toBe("true");
    expect(select.__removeCount).toBe(0);
    expect(select.__createCount).toBe(0);
    expect(select.__optionsRef).toEqual([{ value: "1:1", text: "1:1 Square" }]);

    (select.ownerDocument as any).activeElement = null;

    syncCanvasFlowAspectRatioPresetControls({
      select,
      modelId: "openai/gpt-5-image-mini",
      preferred: "16:9",
      helpEl,
      deferWhileFocused: true,
    });

    expect(select.dataset.ssCanvasflowAspectSyncDeferred).toBeUndefined();
    expect(select.__removeCount).toBeGreaterThan(0);
    expect(select.__createCount).toBeGreaterThan(0);
    expect(select.options.length).toBeGreaterThan(1);
    expect(select.value).toBe("16:9");
  });
});
