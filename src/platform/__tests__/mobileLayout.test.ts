/** @jest-environment jsdom */

import { Platform } from "obsidian";
import {
  isMobileLayout,
  isTabletLayout,
  resolveMobileLayoutDocument,
} from "../mobileLayout";

type MutablePlatform = Omit<typeof Platform, "isDesktopApp" | "isMobile" | "isMobileApp" | "isTablet"> & {
  isDesktopApp?: boolean;
  isMobile?: boolean;
  isMobileApp?: boolean;
  isTablet?: boolean;
};

describe("mobile layout host seam", () => {
  const platform: MutablePlatform = Platform;

  beforeEach(() => {
    platform.isDesktopApp = true;
    delete platform.isMobile;
    delete platform.isMobileApp;
    delete platform.isTablet;
    document.body.className = "";
  });

  afterAll(() => {
    platform.isDesktopApp = true;
    delete platform.isMobile;
    delete platform.isMobileApp;
    delete platform.isTablet;
  });

  it.each([
    ["isMobile", () => { platform.isMobile = true; }],
    ["isMobileApp", () => { platform.isMobileApp = true; }],
    ["isDesktopApp=false", () => { platform.isDesktopApp = false; }],
  ])("recognizes Obsidian's %s mobile signal", (_label, arrange) => {
    arrange();

    expect(isMobileLayout(document)).toBe(true);
  });

  it("recognizes Obsidian's official desktop mobile-layout emulator", () => {
    document.body.classList.add("is-mobile");

    expect(isMobileLayout(document.body)).toBe(true);
  });

  it("does not classify an ordinary desktop window as mobile", () => {
    expect(isMobileLayout(document)).toBe(false);
  });

  it("uses the initiating surface's document instead of the global document", () => {
    const foreignDocument = document.implementation.createHTMLDocument("popout");
    foreignDocument.body.classList.add("is-mobile");

    expect(resolveMobileLayoutDocument(foreignDocument.body)).toBe(foreignDocument);
    expect(isMobileLayout(foreignDocument.body)).toBe(true);
    expect(isMobileLayout(document.body)).toBe(false);
  });

  it("recognizes tablets from the platform or the emulated tablet layout", () => {
    expect(isTabletLayout(document)).toBe(false);

    document.body.classList.add("is-tablet");
    expect(isTabletLayout(document.body)).toBe(true);

    document.body.className = "";
    platform.isTablet = true;
    expect(isTabletLayout(document)).toBe(true);
  });
});
