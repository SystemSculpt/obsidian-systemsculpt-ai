import type SystemSculptPlugin from "../../main";
import { PlatformRequestClient } from "../PlatformRequestClient";
import { SystemSculptEnvironment } from "./SystemSculptEnvironment";

type JsonRecord = Record<string, unknown>;

export interface PluginCapabilityAvailabilityResolution {
  canOpen: boolean;
  authoritative: boolean;
}

export interface PluginCapabilityAvailabilityOptions {
  baseUrl?: string;
  now?: () => number;
  requestClient?: PlatformRequestClient;
}

interface CacheEntry {
  licenseKey: string;
  pluginVersion: string;
  baseUrl: string;
  expiresAt: number;
  capabilities: JsonRecord | null;
}

const availabilityCache = new WeakMap<SystemSculptPlugin, CacheEntry>();
const latestProbe = new WeakMap<SystemSculptPlugin, object>();
const CACHE_TTL_MS = 5 * 60_000;
const MAX_JSON_RESPONSE_CHARS = 1024 * 1024;

/** Read the server's additive capability catalogue; older/unavailable servers fail open. */
export async function getPluginCapabilityAvailability(
  plugin: SystemSculptPlugin,
  capability: "hosted_audio_processor" | "hosted_videos",
  options: PluginCapabilityAvailabilityOptions = {},
  signal?: AbortSignal,
): Promise<PluginCapabilityAvailabilityResolution> {
  const licenseKey = typeof plugin.settings?.licenseKey === "string" ? plugin.settings.licenseKey.trim() : "";
  const pluginVersion = typeof plugin.manifest?.version === "string" ? plugin.manifest.version.trim() : "";
  const baseUrl = (options.baseUrl ?? SystemSculptEnvironment.resolveBaseUrl()).replace(/\/+$/, "");
  const now = (options.now ?? Date.now)();
  const cached = availabilityCache.get(plugin);
  let capabilities: JsonRecord | null;
  if (cached && cached.expiresAt > now && cached.licenseKey === licenseKey
    && cached.pluginVersion === pluginVersion && cached.baseUrl === baseUrl) {
    latestProbe.delete(plugin);
    capabilities = cached.capabilities;
  } else {
    if (signal?.aborted) return { canOpen: true, authoritative: false };
    const probe = {};
    latestProbe.set(plugin, probe);
    capabilities = null;
    if (licenseKey && pluginVersion && !signal?.aborted) {
      try {
        const response = await (options.requestClient ?? new PlatformRequestClient()).request({
          url: `${baseUrl}/config`,
          method: "GET",
          headers: {
            ...SystemSculptEnvironment.buildHeaders(licenseKey),
            "x-plugin-version": pluginVersion,
          },
          licenseKey,
          preserveResponseHeaders: true,
          signal,
        });
        if (response.ok) {
          const text = await response.text();
          if (text && text.length <= MAX_JSON_RESPONSE_CHARS) {
            const payload: unknown = JSON.parse(text);
            if (isRecord(payload) && payload.contract === "systemsculpt-plugin-config-v1"
              && isRecord(payload.capabilities)) {
              capabilities = payload.capabilities;
            }
          }
        }
      } catch {
        // Config is advisory; the execution endpoint remains authoritative.
      }
    }
    // Cancelled or superseded probes must not overwrite a newer surface decision.
    if (!signal?.aborted && latestProbe.get(plugin) === probe) {
      availabilityCache.set(plugin, { licenseKey, pluginVersion, baseUrl, expiresAt: now + CACHE_TTL_MS, capabilities });
    }
  }
  return capabilities === null
    ? { canOpen: true, authoritative: false }
    : { canOpen: capabilities[capability] === true, authoritative: true };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
