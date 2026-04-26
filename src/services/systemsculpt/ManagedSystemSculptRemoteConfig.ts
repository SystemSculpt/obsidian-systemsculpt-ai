import type SystemSculptPlugin from "../../main";
import { WEBSITE_API_BASE_URL } from "../../constants/api";
import { PlatformRequestClient } from "../PlatformRequestClient";
import {
  MANAGED_SYSTEMSCULPT_MODEL_CONTRACT,
  type ManagedSystemSculptModelContract,
} from "./ManagedSystemSculptContract";

type PluginConfigManagedModel = {
  display_name?: unknown;
  context_window?: unknown;
  max_completion_tokens?: unknown;
  capabilities?: unknown;
  modality?: unknown;
};

type PluginConfigResponse = {
  api?: {
    configured_managed_model?: PluginConfigManagedModel | null;
  };
};

type ContractCacheEntry = {
  licenseKey: string;
  expiresAt: number;
  contract: ManagedSystemSculptModelContract;
};

const SUCCESS_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 60 * 1000;

let cachedContract: ContractCacheEntry | null = null;

function toPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);
}

function normalizeRemoteManagedModel(
  remote: PluginConfigManagedModel | null | undefined
): ManagedSystemSculptModelContract | null {
  if (!remote || typeof remote !== "object") {
    return null;
  }

  const contextLength = toPositiveInteger(remote.context_window);
  const maxCompletionTokens = toPositiveInteger(remote.max_completion_tokens);
  if (!contextLength || !maxCompletionTokens) {
    return null;
  }

  const capabilities = toStringList(remote.capabilities);
  const modality = String(remote.modality || "").trim();

  return {
    ...MANAGED_SYSTEMSCULPT_MODEL_CONTRACT,
    contextLength,
    maxCompletionTokens,
    capabilities: capabilities.length > 0
      ? capabilities
      : MANAGED_SYSTEMSCULPT_MODEL_CONTRACT.capabilities,
    modality: modality || MANAGED_SYSTEMSCULPT_MODEL_CONTRACT.modality,
  };
}

async function fetchRemoteManagedModelContract(
  plugin: Pick<SystemSculptPlugin, "settings" | "manifest">
): Promise<ManagedSystemSculptModelContract | null> {
  const licenseKey = String(plugin.settings?.licenseKey || "").trim();
  if (!licenseKey || plugin.settings?.licenseValid !== true) {
    return null;
  }

  const requestClient = new PlatformRequestClient();
  const response = await requestClient.request({
    url: `${WEBSITE_API_BASE_URL}/config`,
    method: "GET",
    licenseKey,
    headers: {
      "X-SystemSculpt-Client": "obsidian-plugin",
      "x-plugin-version": String(plugin.manifest?.version || "0.0.0"),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as PluginConfigResponse;
  return normalizeRemoteManagedModel(payload?.api?.configured_managed_model);
}

export async function resolveManagedSystemSculptModelContract(
  plugin: Pick<SystemSculptPlugin, "settings" | "manifest">
): Promise<ManagedSystemSculptModelContract> {
  const licenseKey = String(plugin.settings?.licenseKey || "").trim();
  if (!licenseKey || plugin.settings?.licenseValid !== true) {
    return MANAGED_SYSTEMSCULPT_MODEL_CONTRACT;
  }

  const now = Date.now();
  if (
    cachedContract &&
    cachedContract.licenseKey === licenseKey &&
    cachedContract.expiresAt > now
  ) {
    return cachedContract.contract;
  }

  const remoteContract = await fetchRemoteManagedModelContract(plugin).catch(() => null);
  const contract = remoteContract || MANAGED_SYSTEMSCULPT_MODEL_CONTRACT;
  cachedContract = {
    licenseKey,
    expiresAt: now + (remoteContract ? SUCCESS_CACHE_TTL_MS : FALLBACK_CACHE_TTL_MS),
    contract,
  };
  return contract;
}

export function clearManagedSystemSculptModelContractCacheForTests(): void {
  cachedContract = null;
}
