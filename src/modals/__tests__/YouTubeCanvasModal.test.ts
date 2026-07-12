/** @jest-environment jsdom */

import { App } from "obsidian";
import { YouTubeCanvasModal } from "../YouTubeCanvasModal";

const buildPluginStub = () =>
  ({
    settings: {
      youtubeCanvasToggles: null,
      youtubeNotesFolder: "",
      licenseKey: "license-key",
      licenseValid: true,
      selectedModelId: "test-model",
    },
    getSettingsManager: () => ({
      updateSettings: jest.fn().mockResolvedValue(undefined),
    }),
    aiService: {
      streamMessage: jest.fn(),
    },
  }) as any;

describe("YouTubeCanvasModal", () => {
  it("shows Get Transcript even when the captions list is empty", () => {
    const app = new App();
    const modal = new YouTubeCanvasModal(app, buildPluginStub());
    modal.open();

    (modal as any).availableLanguages = [];
    (modal as any).setState("preview_ready");

    const getTranscriptBtn = (modal as any).getTranscriptBtn as HTMLButtonElement;
    expect(getTranscriptBtn.style.display).toBe("inline-flex");
  });

  it("attempts transcript fetch even when no captions were detected up front", async () => {
    const app = new App();
    const modal = new YouTubeCanvasModal(app, buildPluginStub());
    modal.open();

    const transcriptSpy = jest.fn().mockResolvedValue({ text: "hello", lang: "en" });
    (modal as any).transcriptService.getTranscript = transcriptSpy;

    (modal as any).currentUrl = "https://youtu.be/dQw4w9WgXcQ";
    (modal as any).availableLanguages = [];
    (modal as any).selectedLanguage = null;

    await (modal as any).fetchTranscript();

    expect(transcriptSpy).toHaveBeenCalled();
  });

  it("renders a local icon placeholder instead of a remote thumbnail", () => {
    const app = new App();
    const modal = new YouTubeCanvasModal(app, buildPluginStub());
    modal.open();

    (modal as any).metadata = {
      title: "YouTube video",
      author_name: "Video ID dQw4w9WgXcQ",
      author_url: "",
      thumbnailDataUrl: null,
      videoId: "dQw4w9WgXcQ",
    };
    (modal as any).renderPreview();

    const preview = (modal as any).previewSection as HTMLElement;
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.querySelector(".ss-youtube-canvas-modal__thumbnail-placeholder")).not.toBeNull();
    expect(preview.textContent).toContain("YouTube video");
    expect(preview.textContent).toContain("Video ID dQw4w9WgXcQ");
  });
});
