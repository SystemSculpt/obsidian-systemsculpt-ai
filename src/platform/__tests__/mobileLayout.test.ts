/** @jest-environment jsdom */

import { Platform } from "obsidian";
import {
  isMobileLayout,
  resolveMobileLayoutDocument,
} from "../mobileLayout";

type MutablePlatform = typeof Platform & {
  isDesktopApp?: boolean;
  isMobile?: boolean;
  isMobileApp?: boolean;
};

describe("mobile layout host seam", () => {
  const platform = Platform as MutablePlatform;

  beforeEach(() => {
    platform.isDesktopApp = true;
    delete platform.isMobile;
    delete platform.isMobileApp;
    document.body.className = "";
  });

  afterAll(() => {
    platform.isDesktopApp = true;
    delete platform.isMobile;
    delete platform.isMobileApp;
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
});
