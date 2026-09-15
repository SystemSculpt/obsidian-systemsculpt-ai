import type SystemSculptPlugin from "../../main";
import { PlatformRequestClient } from "../PlatformRequestClient";
import { SystemSculptEnvironment } from "../api/SystemSculptEnvironment";

type JsonRecord = Record<string, unknown>;

export interface VideoGenerationAvailabilityResolution {
  canOpen: boolean;
  authoritative: boolean;
}

export interface VideoGenerationAvailabilityOptions {
  baseUrl?: string;
  now?: () => number;
  requestClient?: PlatformRequestClient;
}

type CacheEntry = VideoGenerationAvailabilityResolution & Readonly<{
  expiresAt: number;
}>;

const PLUGIN_CONFIG_CONTRACT = "systemsculpt-plugin-config-v1";
const CACHE_TTL_MS = 5 * 60_000;
const MAX_JSON_RESPONSE_CHARS = 1024 * 1024;
const FAIL_OPEN: VideoGenerationAvailabilityResolution = Object.freeze({
  canOpen: true,
  authoritative: false,
});
const NOT_ADVERTISED: VideoGenerationAvailabilityResolution = Object.freeze({
  canOpen: false,
  authoritative: true,
});

const availabilityCache = new WeakMap<SystemSculptPlugin, CacheEntry>();

export async function canRunVideoGeneration(
  plugin: SystemSculptPlugin,
  options: VideoGenerationAvailabilityOptions = {},
  signal?: AbortSignal,
): Promise<boolean> {
  const resolution = await getVideoGenerationAvailability(plugin, options, signal);
  return resolution.canOpen;
}

export async function getVideoGenerationAvailability(
  plugin: SystemSculptPlugin,
  options: VideoGenerationAvailabilityOptions = {},
  signal?: AbortSignal,
): Promise<VideoGenerationAvailabilityResolution> {
  const now = options.now ?? Date.now;
  const currentTime = now();
  const cached = availabilityCache.get(plugin);
  if (cached && cached.expiresAt > currentTime) {
    return { canOpen: cached.canOpen, authoritative: cached.authoritative };
  }

  const licenseKey = plugin.settings?.licenseKey;
  const pluginVersion = plugin.manifest?.version;
  if (
    typeof licenseKey !== "string"
    || !licenseKey.trim()
    || typeof pluginVersion !== "string"
    || !pluginVersion.trim()
  ) {
    return remember(plugin, FAIL_OPEN, currentTime);
  }

  const requestClient = options.requestClient ?? new PlatformRequestClient();
  const baseUrl = (options.baseUrl ?? SystemSculptEnvironment.resolveBaseUrl()).replace(/\/+$/, "");

  try {
    const response = await requestClient.request({
      url: `${baseUrl}/config`,
      method: "GET",
      headers: {
        ...SystemSculptEnvironment.buildHeaders(licenseKey.trim()),
        "x-plugin-version": pluginVersion.trim(),
      },
      licenseKey: licenseKey.trim(),
      preserveResponseHeaders: true,
      signal,
    });

    if (!response.ok) {
      return remember(plugin, FAIL_OPEN, currentTime);
    }

    const text = await response.text();
    if (text.length > MAX_JSON_RESPONSE_CHARS) {
      return remember(plugin, FAIL_OPEN, currentTime);
    }

    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      return remember(plugin, FAIL_OPEN, currentTime);
    }

    return remember(plugin, parseAvailability(payload), currentTime);
  } catch {
    return remember(plugin, FAIL_OPEN, currentTime);
  }
}

function remember(
  plugin: SystemSculptPlugin,
  resolution: VideoGenerationAvailabilityResolution,
  now: number,
): VideoGenerationAvailabilityResolution {
  availabilityCache.set(plugin, {
    canOpen: resolution.canOpen,
    authoritative: resolution.authoritative,
    expiresAt: now + CACHE_TTL_MS,
  });
  return resolution;
}

function parseAvailability(value: unknown): VideoGenerationAvailabilityResolution {
  if (!isRecord(value) || value.contract !== PLUGIN_CONFIG_CONTRACT) {
    return FAIL_OPEN;
  }

  const capabilities = value.capabilities;
  if (!isRecord(capabilities)) return FAIL_OPEN;
  if (capabilities.hosted_videos === false) {
    return { canOpen: false, authoritative: true };
  }
  if (capabilities.hosted_videos === true) {
    return { canOpen: true, authoritative: true };
  }
  // A valid first-party config is the capability catalogue. If the additive
  // capability is absent, this deployment does not serve video generation yet.
  return NOT_ADVERTISED;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
