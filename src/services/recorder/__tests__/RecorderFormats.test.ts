/**
 * @jest-environment jsdom
 */

import {
  pickRecorderFormat,
  recorderFormatForMimeType,
  type RecorderFormat,
} from "../RecorderFormats";

function ownerWindowWithSupportedTypes(...supportedTypes: string[]): Window {
  const isTypeSupported = jest.fn((mimeType: string) => supportedTypes.includes(mimeType));
  return {
    MediaRecorder: { isTypeSupported },
  } as unknown as Window;
}

describe("RecorderFormats", () => {
  describe("pickRecorderFormat", () => {
    it("probes only the initiating window's MediaRecorder realm", () => {
      const original = window.MediaRecorder;
      const globalProbe = jest.fn(() => true);
      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        value: { isTypeSupported: globalProbe },
      });
      const ownerWindow = ownerWindowWithSupportedTypes("audio/mp4");

      try {
        expect(pickRecorderFormat(ownerWindow)).toEqual({
          mimeType: "audio/mp4",
          extension: "m4a",
        });
        expect(globalProbe).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(window, "MediaRecorder", {
          configurable: true,
          value: original,
        });
      }
    });

    it("prefers Opus WebM when the host supports it", () => {
      const ownerWindow = ownerWindowWithSupportedTypes(
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      );

      expect(pickRecorderFormat(ownerWindow)).toEqual({
        mimeType: "audio/webm;codecs=opus",
        extension: "webm",
      });
    });

    it("uses MP4/M4A when WebM is unavailable in the mobile host", () => {
      const ownerWindow = ownerWindowWithSupportedTypes("audio/mp4");

      expect(pickRecorderFormat(ownerWindow)).toEqual({
        mimeType: "audio/mp4",
        extension: "m4a",
      });
    });

    it("falls through to Ogg and WAV after WebM and MP4", () => {
      expect(pickRecorderFormat(ownerWindowWithSupportedTypes("audio/ogg;codecs=opus"))).toEqual({
        mimeType: "audio/ogg;codecs=opus",
        extension: "ogg",
      });
      expect(pickRecorderFormat(ownerWindowWithSupportedTypes("audio/wav"))).toEqual({
        mimeType: "audio/wav",
        extension: "wav",
      });
    });

    it("returns a safe fallback when support probing is unavailable or throws", () => {
      expect(pickRecorderFormat({} as Window)).toEqual({
        mimeType: "audio/webm",
        extension: "webm",
      });
      const throwingWindow = {
        MediaRecorder: { isTypeSupported: () => { throw new Error("host failure"); } },
      } as unknown as Window;
      expect(pickRecorderFormat(throwingWindow)).toEqual({
        mimeType: "audio/webm",
        extension: "webm",
      });
    });
  });

  describe("recorderFormatForMimeType", () => {
    it.each([
      ["audio/webm;codecs=opus", "webm"],
      ["audio/mp4", "m4a"],
      ["audio/x-m4a", "m4a"],
      ["video/mp4;codecs=mp4a.40.2", "m4a"],
      ["audio/ogg;codecs=opus", "ogg"],
      ["audio/x-wav", "wav"],
      ["audio/mpeg", "mp3"],
    ])("maps %s to .%s", (mimeType, extension) => {
      expect(recorderFormatForMimeType(mimeType).extension).toBe(extension);
    });

    it("preserves the full normalized MIME type and uses the requested fallback for unknown types", () => {
      expect(recorderFormatForMimeType(" Audio/MP4;Codecs=MP4A.40.2 ")).toEqual({
        mimeType: "audio/mp4;codecs=mp4a.40.2",
        extension: "m4a",
      });
      const fallback: RecorderFormat = { mimeType: "audio/custom", extension: "custom" };
      expect(recorderFormatForMimeType("application/octet-stream", fallback)).toBe(fallback);
      expect(recorderFormatForMimeType("", fallback)).toBe(fallback);
    });
  });
});
