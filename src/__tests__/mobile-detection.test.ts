import { describe, expect, it, afterEach, beforeEach } from '@jest/globals';

const g = globalThis as any;
const originalNavigator = g.navigator;
const originalWindow = g.window;
const originalScreen = g.screen;
const originalDocument = g.document;

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function configureBrowserEnvironment(userAgent: string, innerWidth: number, overrides: Record<string, any> = {}) {
  const navigatorMock: Record<string, any> = {
    userAgent,
    maxTouchPoints: overrides.maxTouchPoints ?? 0,
    hardwareConcurrency: overrides.hardwareConcurrency ?? 8,
    mediaDevices: overrides.mediaDevices ?? {},
    geolocation: overrides.geolocation ?? {},
    clipboard: overrides.clipboard,
    vibrate: overrides.vibrate,
    connection: overrides.connection,
    storage: overrides.storage,
  };

  g.navigator = navigatorMock;

  g.window = {
    innerWidth,
    innerHeight: overrides.innerHeight ?? 800,
    devicePixelRatio: overrides.devicePixelRatio ?? 2,
    navigator: navigatorMock,
    ontouchstart: overrides.ontouchstart,
    WebGLRenderingContext: function WebGLRenderingContext() {},
  };

  g.screen = {
    width: innerWidth,
    height: overrides.innerHeight ?? 800,
  };

  g.document = {
    createElement: () => ({
      getContext: () => null,
    }),
  };
}

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  g.navigator = originalNavigator;
  g.window = originalWindow;
  g.screen = originalScreen;
  g.document = originalDocument;
});

describe('MobileDetection heuristics', () => {
  it('keeps desktop electron panes in streaming mode even when narrow', () => {
    configureBrowserEnvironment(DESKTOP_UA, 480);

    const { Platform } = require('obsidian');
    const originalPlatform = { ...Platform };
    try {
      Object.assign(Platform, {
        isDesktop: true,
        isDesktopApp: true,
        isMobile: false,
        isMobileApp: false,
        isPhone: false,
        isIosApp: false,
        isAndroidApp: false,
      });

      const { MobileDetection } = require('../utils/MobileDetection');
      const detection = MobileDetection.getInstance();

      expect(detection.getDeviceInfo().isMobile).toBe(false);
    } finally {
      Object.assign(Platform, originalPlatform);
    }
  });

  it('detects native mobile environments', () => {
    configureBrowserEnvironment(MOBILE_UA, 390, { maxTouchPoints: 5 });

    const { Platform } = require('obsidian');
    const originalPlatform = { ...Platform };
    try {
      Object.assign(Platform, {
        isDesktop: false,
        isDesktopApp: false,
        isMobile: true,
        isMobileApp: true,
        isPhone: true,
        isIosApp: true,
        isAndroidApp: false,
      });

      const { MobileDetection } = require('../utils/MobileDetection');
      const detection = MobileDetection.getInstance();

      expect(detection.getDeviceInfo().isMobile).toBe(true);
    } finally {
      Object.assign(Platform, originalPlatform);
    }
  });

  it('treats desktop mobile emulation as mobile transport', () => {
    configureBrowserEnvironment(DESKTOP_UA, 480);

    const { Platform } = require('obsidian');
    const originalPlatform = { ...Platform };
    try {
      Object.assign(Platform, {
        isDesktop: true,
        isDesktopApp: true,
        isMobile: true,
        isMobileApp: false,
        isPhone: true,
        isIosApp: false,
        isAndroidApp: false,
      });

      const { MobileDetection } = require('../utils/MobileDetection');
      const detection = MobileDetection.getInstance();

      expect(detection.getDeviceInfo().isMobile).toBe(true);
    } finally {
      Object.assign(Platform, originalPlatform);
    }
  });
});
