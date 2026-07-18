/** @jest-environment jsdom */

import { Platform } from "obsidian";
import {
  getCurrentHostPreferredMicrophoneId,
  seedCurrentHostPreferredMicrophoneId,
  setCurrentHostPreferredMicrophoneId,
} from "../RecorderPreferenceStore";

describe("RecorderPreferenceStore", () => {
  afterEach(() => {
    window.localStorage.clear();
    Object.assign(Platform, {
      isDesktopApp: true,
      isMobile: false,
      isMobileApp: false,
    });
  });

  it("keeps a session fallback when a private WebView rejects localStorage writes", () => {
    const owner = {
      localStorage: {
        getItem: jest.fn(() => null),
        setItem: jest.fn(() => { throw new Error("quota disabled"); }),
      },
    } as unknown as Window;

    setCurrentHostPreferredMicrophoneId(owner, "private-vault", "usb-mic");

    expect(getCurrentHostPreferredMicrophoneId(owner, "private-vault")).toBe("usb-mic");
  });

  it("separates vault and host preferences in device-local storage", () => {
    setCurrentHostPreferredMicrophoneId(window, "vault-a", "desktop-a");
    setCurrentHostPreferredMicrophoneId(window, "vault-b", "desktop-b");

    Object.assign(Platform, {
      isDesktopApp: false,
      isMobile: true,
      isMobileApp: true,
    });
    setCurrentHostPreferredMicrophoneId(window, "vault-a", "mobile-a");

    expect(getCurrentHostPreferredMicrophoneId(window, "vault-a")).toBe("mobile-a");
    Object.assign(Platform, {
      isDesktopApp: true,
      isMobile: false,
      isMobileApp: false,
    });
    expect(getCurrentHostPreferredMicrophoneId(window, "vault-a")).toBe("desktop-a");
    expect(getCurrentHostPreferredMicrophoneId(window, "vault-b")).toBe("desktop-b");
  });

  it("seeds a migrated preference without replacing an existing local choice", () => {
    expect(seedCurrentHostPreferredMicrophoneId(
      window,
      "migration-vault",
      " legacy-usb-mic ",
    )).toBe(true);
    expect(getCurrentHostPreferredMicrophoneId(window, "migration-vault")).toBe("legacy-usb-mic");

    setCurrentHostPreferredMicrophoneId(window, "explicit-default-vault", "");
    expect(seedCurrentHostPreferredMicrophoneId(
      window,
      "explicit-default-vault",
      "legacy-usb-mic",
    )).toBe(false);
    expect(getCurrentHostPreferredMicrophoneId(window, "explicit-default-vault")).toBe("");
  });
});
