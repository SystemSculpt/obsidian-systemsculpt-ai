/**
 * Comprehensive Mobile Device Detection Utility
 * Provides detailed information about mobile devices, their capabilities, and limitations
 */

import { Platform } from 'obsidian';

export interface MobileDeviceInfo {
  isMobile: boolean;
  platform: {
    name: string;
    version: string;
    os: 'iOS' | 'Android' | 'Windows' | 'macOS' | 'Linux' | 'Unknown';
  };
  device: {
    type: 'smartphone' | 'tablet' | 'desktop' | 'unknown';
    model: string;
    vendor: string;
    screenSize: string;
  };
  capabilities: {
    touchSupport: boolean;
    hasCamera: boolean;
    hasGeolocation: boolean;
    hasAccelerometer: boolean;
    hasGyroscope: boolean;
    hasVibration: boolean;
    hasServiceWorker: boolean;
    hasWebGL: boolean;
    hasWebRTC: boolean;
    hasFileAPI: boolean;
    hasClipboardAPI: boolean;
    hasNotificationAPI: boolean;
  };
  network: {
    type: string;
    effectiveType: string;
    downlink: number;
    rtt: number;
    saveData: boolean;
  };
  performance: {
    memoryLimit: number;
    processorCores: number;
    maxTouchPoints: number;
    pixelRatio: number;
  };
  limitations: {
    resourceConstrained: boolean;
    functionalityLimited: boolean;
    networkConstrained: boolean;
    storageConstrained: boolean;
    reasons: string[];
  };
  npm: {
    problematicPackages: string[];
    unavailableFeatures: string[];
    recommendedAlternatives: { [key: string]: string };
  };
}

export class MobileDetection {
  private static instance: MobileDetection;
  private cachedInfo: MobileDeviceInfo | null = null;
  private lastUpdate: number = 0;
  private readonly CACHE_DURATION = 30000; // 30 seconds

  public static getInstance(): MobileDetection {
    if (!MobileDetection.instance) {
      MobileDetection.instance = new MobileDetection();
    }
    return MobileDetection.instance;
  }

  /**
   * Get comprehensive mobile device information
   */
  public getDeviceInfo(): MobileDeviceInfo {
    const now = Date.now();
    if (this.cachedInfo && (now - this.lastUpdate) < this.CACHE_DURATION) {
      return this.cachedInfo;
    }

    this.cachedInfo = this.detectDeviceInfo();
    this.lastUpdate = now;
    return this.cachedInfo;
  }

  /**
   * Quick mobile detection check
   */
  public isMobileDevice(): boolean {
    return this.getDeviceInfo().isMobile;
  }

  /**
   * Check if device has resource constraints
   */
  public isResourceConstrained(): boolean {
    return this.getDeviceInfo().limitations.resourceConstrained;
  }

  /**
   * Check if device has functionality limitations
   */
  public hasFunctionalityLimitations(): boolean {
    return this.getDeviceInfo().limitations.functionalityLimited;
  }

  private detectDeviceInfo(): MobileDeviceInfo {
    const userAgent = navigator.userAgent;
    const platform = this.detectPlatform(userAgent);
    const device = this.detectDevice(userAgent);
    const mobileUserAgent = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
    const appAny = (typeof window !== 'undefined' ? (window as any)?.app : undefined);
    const isMobileEmulation = Boolean(appAny?.isMobile && typeof appAny?.emulateMobile === 'function');
    const capabilities = this.detectCapabilities();
    const network = this.detectNetwork();
    const performance = this.detectPerformance();
    const limitations = this.detectLimitations(device, capabilities, network, performance);
    const npm = this.detectNpmIssues(platform.os, device.type, limitations);

    const platformSignals = Boolean(
      Platform?.isMobileApp ||
      Platform?.isAndroidApp ||
      Platform?.isIosApp ||
      Platform?.isMobile === true ||
      (Platform?.isMobile && (Platform?.isDesktopApp !== true || isMobileEmulation || mobileUserAgent)) ||
      isMobileEmulation
    );

    const isMobile = platformSignals ||
                    device.type === 'smartphone' ||
                    device.type === 'tablet' ||
                    platform.os === 'iOS' ||
                    platform.os === 'Android' ||
                    mobileUserAgent;

    try {
      console.debug('[SystemSculpt][MobileDetection] detectDeviceInfo result', {
        platformSignals,
        platformFlags: {
          isMobileApp: Platform?.isMobileApp,
          isAndroidApp: Platform?.isAndroidApp,
          isIosApp: Platform?.isIosApp,
          isMobile: Platform?.isMobile,
          isDesktopApp: Platform?.isDesktopApp,
        },
        deviceType: device.type,
        os: platform.os,
        uaSnippet: userAgent.slice(0, 120),
        isMobile
      });
    } catch {}

    return {
      isMobile,
      platform,
      device,
      capabilities,
      network,
      performance,
      limitations,
      npm
    };
  }

  private detectPlatform(userAgent: string): MobileDeviceInfo['platform'] {
    let os: MobileDeviceInfo['platform']['os'] = 'Unknown';
    let name = 'Unknown';
    let version = 'Unknown';

    if (/iPhone|iPad|iPod/i.test(userAgent)) {
      os = 'iOS';
      name = 'iOS';
      const match = userAgent.match(/OS (\d+_\d+)/);
      if (match) {
        version = match[1].replace('_', '.');
      }
    } else if (/Android/i.test(userAgent)) {
      os = 'Android';
      name = 'Android';
      const match = userAgent.match(/Android (\d+\.?\d*)/);
      if (match) {
        version = match[1];
      }
    } else if (/Windows/i.test(userAgent)) {
      os = 'Windows';
      name = 'Windows';
      if (/Windows NT (\d+\.\d+)/i.test(userAgent)) {
        const match = userAgent.match(/Windows NT (\d+\.\d+)/i);
        if (match) version = match[1];
      }
    } else if (/Mac OS X/i.test(userAgent)) {
      os = 'macOS';
      name = 'macOS';
      const match = userAgent.match(/Mac OS X (\d+[_\d]*)/i);
      if (match) {
        version = match[1].replace(/_/g, '.');
      }
    } else if (/Linux/i.test(userAgent)) {
      os = 'Linux';
      name = 'Linux';
    }

    return { name, version, os };
  }

  private detectDevice(userAgent: string): MobileDeviceInfo['device'] {
    let type: MobileDeviceInfo['device']['type'] = 'unknown';
    let model = 'Unknown';
    let vendor = 'Unknown';

    if (/iPhone/i.test(userAgent)) {
      type = 'smartphone';
      vendor = 'Apple';
      const match = userAgent.match(/iPhone[^;]*/i);
      if (match) model = match[0];
    } else if (/iPad/i.test(userAgent)) {
      type = 'tablet';
      vendor = 'Apple';
      model = 'iPad';
    } else if (/Android/i.test(userAgent)) {
      if (/Mobile/i.test(userAgent)) {
        type = 'smartphone';
      } else {
        type = 'tablet';
      }
      
      // Try to extract device model
      const samsungMatch = userAgent.match(/SM-[A-Z0-9]+/i);
      const pixelMatch = userAgent.match(/Pixel [0-9a-zA-Z ]+/i);
      
      if (samsungMatch) {
        vendor = 'Samsung';
        model = samsungMatch[0];
      } else if (pixelMatch) {
        vendor = 'Google';
        model = pixelMatch[0];
      } else if (/Huawei/i.test(userAgent)) {
        vendor = 'Huawei';
      } else if (/OnePlus/i.test(userAgent)) {
        vendor = 'OnePlus';
      }
    } else {
      type = 'desktop';
    }

    const screenSize = `${screen.width}x${screen.height}`;

    return { type, model, vendor, screenSize };
  }

  private detectCapabilities(): MobileDeviceInfo['capabilities'] {
    const touchSupport = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    
    return {
      touchSupport,
      hasCamera: 'mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices,
      hasGeolocation: 'geolocation' in navigator,
      hasAccelerometer: 'DeviceMotionEvent' in window,
      hasGyroscope: 'DeviceOrientationEvent' in window,
      hasVibration: 'vibrate' in navigator,
      hasServiceWorker: 'serviceWorker' in navigator,
      hasWebGL: this.detectWebGL(),
      hasWebRTC: 'RTCPeerConnection' in window,
      hasFileAPI: 'File' in window && 'FileReader' in window,
      hasClipboardAPI: 'clipboard' in navigator,
      hasNotificationAPI: 'Notification' in window
    };
  }

  private detectWebGL(): boolean {
    try {
      const canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && canvas.getContext('webgl'));
    } catch (e) {
      return false;
    }
  }

  private detectNetwork(): MobileDeviceInfo['network'] {
    const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
    
    return {
      type: connection?.type || 'unknown',
      effectiveType: connection?.effectiveType || 'unknown',
      downlink: connection?.downlink || 0,
      rtt: connection?.rtt || 0,
      saveData: connection?.saveData || false
    };
  }

  private detectPerformance(): MobileDeviceInfo['performance'] {
    const memory = (performance as any).memory;
    
    return {
      memoryLimit: memory?.usedJSHeapSize ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : 0,
      processorCores: navigator.hardwareConcurrency || 1,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      pixelRatio: window.devicePixelRatio || 1
    };
  }

  private detectLimitations(
    device: MobileDeviceInfo['device'],
    capabilities: MobileDeviceInfo['capabilities'],
    network: MobileDeviceInfo['network'],
    performance: MobileDeviceInfo['performance']
  ): MobileDeviceInfo['limitations'] {
    const reasons: string[] = [];
    let resourceConstrained = false;
    let functionalityLimited = false;
    let networkConstrained = false;
    let storageConstrained = false;

    // Check resource constraints
    if (performance.memoryLimit > 0 && performance.memoryLimit < 100) {
      resourceConstrained = true;
      reasons.push('Low memory available (< 100MB)');
    }
    
    if (performance.processorCores <= 2) {
      resourceConstrained = true;
      reasons.push('Limited CPU cores (≤ 2)');
    }

    if (device.type === 'smartphone') {
      resourceConstrained = true;
      reasons.push('Smartphone has inherent resource limitations');
    }

    // Check functionality limitations
    if (!capabilities.hasFileAPI) {
      functionalityLimited = true;
      reasons.push('File API not available');
    }

    if (!capabilities.hasClipboardAPI) {
      functionalityLimited = true;
      reasons.push('Clipboard API limited or unavailable');
    }

    if (!capabilities.hasServiceWorker) {
      functionalityLimited = true;
      reasons.push('Service Worker not supported');
    }

    // Check network constraints
    if (network.effectiveType === 'slow-2g' || network.effectiveType === '2g') {
      networkConstrained = true;
      reasons.push('Slow network connection detected');
    }

    if (network.saveData) {
      networkConstrained = true;
      reasons.push('Data saver mode enabled');
    }

    if (network.downlink > 0 && network.downlink < 1) {
      networkConstrained = true;
      reasons.push('Low bandwidth connection');
    }

    // Storage constraints (basic heuristic)
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        // This is async, so we can't use it here, but we note the constraint
        storageConstrained = true;
        reasons.push('Storage may be limited on mobile device');
      }
    } catch (e) {
      // Storage API not available
    }

    return {
      resourceConstrained,
      functionalityLimited,
      networkConstrained,
      storageConstrained,
      reasons
    };
  }

  private detectNpmIssues(
    os: MobileDeviceInfo['platform']['os'],
    deviceType: MobileDeviceInfo['device']['type'],
    limitations: MobileDeviceInfo['limitations']
  ): MobileDeviceInfo['npm'] {
    const problematicPackages: string[] = [];
    const unavailableFeatures: string[] = [];
    const recommendedAlternatives: { [key: string]: string } = {};

    // Packages that commonly don't work on mobile
    if (os === 'iOS') {
      problematicPackages.push(
        'fs-extra', 'child_process', 'crypto (Node.js)', 'path', 'os',
        'node-fetch (older versions)', 'jsdom', 'puppeteer', 'playwright'
      );
      unavailableFeatures.push(
        'File system access', 'Process spawning', 'Node.js crypto module',
        'Server-side rendering packages', 'Headless browsers'
      );
      recommendedAlternatives['node-fetch'] = 'native fetch API';
      recommendedAlternatives['fs-extra'] = 'File API / FileSystem Access API';
      recommendedAlternatives['crypto'] = 'Web Crypto API';
    }

    if (os === 'Android') {
      problematicPackages.push(
        'fs-extra', 'child_process', 'node-fetch (older versions)',
        'jsdom', 'puppeteer', 'playwright', 'native modules'
      );
      unavailableFeatures.push(
        'File system access', 'Process spawning', 'Native module compilation',
        'Headless browsers', 'System-level APIs'
      );
    }

    // General mobile limitations
    if (deviceType === 'smartphone' || deviceType === 'tablet') {
      problematicPackages.push(
        'webpack-dev-server', 'nodemon', 'pm2', 'sharp (native)',
        'sqlite3 (native)', 'bcrypt (native)', 'canvas (native)'
      );
      
      unavailableFeatures.push(
        'Hot module replacement', 'File watching', 'Process management',
        'Native image processing', 'Native database drivers'
      );

      recommendedAlternatives['sharp'] = 'canvas API or browser-compatible image libraries';
      recommendedAlternatives['sqlite3'] = 'IndexedDB or WebSQL';
      recommendedAlternatives['bcrypt'] = 'Web Crypto API with PBKDF2';
      recommendedAlternatives['canvas'] = 'HTML5 Canvas API';
    }

    // Network-related issues
    if (limitations.networkConstrained) {
      problematicPackages.push('large bundled packages', 'moment.js (large)', 'lodash (full)');
      recommendedAlternatives['moment.js'] = 'date-fns or dayjs (smaller)';
      recommendedAlternatives['lodash'] = 'lodash-es with tree shaking';
    }

    // Resource-constrained issues
    if (limitations.resourceConstrained) {
      problematicPackages.push(
        'large UI frameworks', 'heavy computation libraries',
        'memory-intensive packages', 'large ML/AI libraries'
      );
      unavailableFeatures.push(
        'Heavy computations', 'Large data processing',
        'Memory-intensive operations', 'Complex ML models'
      );
    }

    return {
      problematicPackages,
      unavailableFeatures,
      recommendedAlternatives
    };
  }

  /**
   * Get a formatted summary of device information for display
   */
  public getDeviceSummary(): string {
    const info = this.getDeviceInfo();
    const parts = [];

    if (info.isMobile) {
      parts.push(`📱 ${info.device.type.charAt(0).toUpperCase() + info.device.type.slice(1)}`);
    } else {
      parts.push('🖥️ Desktop');
    }

    parts.push(`${info.platform.name} ${info.platform.version}`);
    
    if (info.device.vendor !== 'Unknown') {
      parts.push(info.device.vendor);
    }

    if (info.device.model !== 'Unknown') {
      parts.push(info.device.model);
    }

    return parts.join(' • ');
  }

  /**
   * Get critical warnings for mobile users
   */
  public getCriticalWarnings(): string[] {
    const info = this.getDeviceInfo();
    const warnings: string[] = [];

    if (info.limitations.resourceConstrained) {
      warnings.push('⚠️ Device has limited resources - some features may be slower');
    }

    if (info.limitations.functionalityLimited) {
      warnings.push('⚠️ Some browser APIs are not available on this device');
    }

    if (info.limitations.networkConstrained) {
      warnings.push('⚠️ Network connection may affect performance');
    }

    if (info.npm.problematicPackages.length > 5) {
      warnings.push('⚠️ Many NPM packages may not work properly on this platform');
    }

    return warnings;
  }

  public resetCache(): void {
    this.cachedInfo = null;
    this.lastUpdate = 0;
  }
}
