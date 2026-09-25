import type SystemSculptPlugin from "../../main";
import type { PlatformRequestClient } from "../PlatformRequestClient";
import { HostedTransportAdapter } from "../managed/adapters/HostedTransportAdapter";
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

/**
 * /config has one client, the managed transport, which shares identical
 * in-flight reads (#386). The plugin's own transport is used unless a test
 * supplies an endpoint or request client.
 */
function configTransport(
  plugin: SystemSculptPlugin,
  options: PluginCapabilityAvailabilityOptions,
  baseUrl: string,
  licenseKey: string,
  pluginVersion: string,
): Pick<HostedTransportAdapter, "getPluginConfigCapabilities"> {
  const graph = !options.requestClient && !options.baseUrl
    ? (plugin as Partial<Pick<SystemSculptPlugin, "getManagedCapabilityGraph">>).getManagedCapabilityGraph?.()
    : undefined;
  return graph?.transport ?? new HostedTransportAdapter({
    baseUrl: new URL(baseUrl).origin,
    pluginVersion,
    licenseKey: () => licenseKey,
    requestClient: options.requestClient,
  });
}

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
        capabilities = await configTransport(plugin, options, baseUrl, licenseKey, pluginVersion)
          .getPluginConfigCapabilities(signal);
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
