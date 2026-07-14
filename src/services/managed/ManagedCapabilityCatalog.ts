import {
  MANAGED_CAPABILITY_CONTRACT,
  ManagedCapabilityAlias,
  ManagedCapabilityCatalogContract,
  ManagedRequestContractId,
} from "./ManagedTypes";

type DescriptorRule = {
  alias: ManagedCapabilityAlias;
  endpoint: string;
  mode: "stream" | "request" | "job";
  metering: "metered_turn" | "metered_operation" | "metered_job";
  cancellation: boolean;
  background: boolean;
  contracts: ManagedRequestContractId[];
};

const RULES: DescriptorRule[] = [
  { alias: "systemsculpt/chat", endpoint: "/api/plugin/chat/completions", mode: "stream", metering: "metered_turn", cancellation: false, background: false, contracts: ["chat_turn", "text_generation"] },
  { alias: "systemsculpt/embeddings", endpoint: "/api/plugin/embeddings", mode: "request", metering: "metered_operation", cancellation: false, background: true, contracts: ["embeddings"] },
  { alias: "systemsculpt/transcription", endpoint: "/api/plugin/audio/transcriptions/jobs", mode: "job", metering: "metered_job", cancellation: false, background: true, contracts: [] },
  { alias: "systemsculpt/documents", endpoint: "/api/plugin/documents/jobs", mode: "job", metering: "metered_job", cancellation: false, background: true, contracts: [] },
  { alias: "systemsculpt/images", endpoint: "/api/plugin/images/generations/jobs", mode: "job", metering: "metered_job", cancellation: false, background: true, contracts: [] },
];

const CONTRACT_FINGERPRINTS: Record<ManagedRequestContractId, string> = {
  chat_turn: "5173:b6e243cc:41dcfd00",
  text_generation: "221:3f90c440:a11ba950",
  embeddings: "874:870ba7d5:c9804f95",
};
const CATALOG_KEYS = ["cache_ttl_seconds", "capabilities", "contract_version", "disclosure_version", "status"];
const DESCRIPTOR_KEYS = ["alias", "auth", "availability", "background_eligible", "cancellation_supported", "endpoint", "limits", "metering", "mode", "request_contracts"];
const EMBEDDINGS_DESCRIPTOR_KEYS = [...DESCRIPTOR_KEYS, "generation"].sort();

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  const serialized = stableJson(value);
  let fnv = 2166136261 >>> 0;
  let djb = 5381 >>> 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
    djb = (Math.imul(djb, 33) ^ code) >>> 0;
  }
  return `${serialized.length}:${fnv.toString(16)}:${djb.toString(16)}`;
}

function validLimits(value: unknown): value is Record<string, string | number | boolean> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((entry) => ["string", "number", "boolean"].includes(typeof entry) && (typeof entry !== "number" || Number.isFinite(entry)));
}

function validEmbeddingGeneration(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const generation = value as Record<string, unknown>;
  return exactKeys(generation, ["id", "index_namespace", "index_schema_version"])
    && typeof generation.id === "string"
    && typeof generation.index_namespace === "string"
    && Number.isInteger(generation.index_schema_version);
}

export class ManagedCapabilityCatalog {
  static parse(value: unknown): ManagedCapabilityCatalogContract {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed managed capability catalog");
    const catalog = value as Record<string, any>;
    if (!exactKeys(catalog, CATALOG_KEYS) || catalog.contract_version !== MANAGED_CAPABILITY_CONTRACT || catalog.cache_ttl_seconds !== 300) {
      throw new Error("Unsupported managed capability contract");
    }
    if (catalog.status !== "available" && catalog.status !== "temporarily_unavailable") throw new Error("Malformed catalog status");
    if (!(catalog.disclosure_version === null || (typeof catalog.disclosure_version === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(catalog.disclosure_version)))) {
      throw new Error("Malformed disclosure version");
    }
    if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length !== RULES.length) throw new Error("Incomplete managed capability catalog");

    RULES.forEach((rule, index) => {
      const descriptor = catalog.capabilities[index];
      const descriptorKeys = rule.alias === "systemsculpt/embeddings"
        ? EMBEDDINGS_DESCRIPTOR_KEYS
        : DESCRIPTOR_KEYS;
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) || !exactKeys(descriptor, descriptorKeys)) throw new Error("Malformed capability descriptor");
      if (
        descriptor.alias !== rule.alias || descriptor.endpoint !== rule.endpoint || descriptor.mode !== rule.mode ||
        descriptor.auth !== "license" || descriptor.metering !== rule.metering ||
        descriptor.cancellation_supported !== rule.cancellation || descriptor.background_eligible !== rule.background ||
        !["available", "unavailable"].includes(descriptor.availability) || !validLimits(descriptor.limits) ||
        !Array.isArray(descriptor.request_contracts) || descriptor.request_contracts.length !== rule.contracts.length
      ) throw new Error(`Malformed descriptor ${rule.alias}`);
      if (rule.alias === "systemsculpt/embeddings" && !validEmbeddingGeneration(descriptor.generation)) {
        throw new Error("Malformed embeddings generation");
      }

      rule.contracts.forEach((contractId, contractIndex) => {
        const contract = descriptor.request_contracts[contractIndex];
        if (!contract || contract.capability !== contractId || fingerprint(contract) !== CONTRACT_FINGERPRINTS[contractId]) {
          throw new Error(`Malformed request contract ${contractId}`);
        }
      });
    });
    return catalog as unknown as ManagedCapabilityCatalogContract;
  }

}
