import admissionFixture from "../../../../testing/fixtures/managed/admission-v1.json";
import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { ManagedCapabilityCatalog } from "../ManagedCapabilityCatalog";
import type { ManagedAdmissionContract, ManagedCapabilityCatalogContract } from "../ManagedTypes";

const typedCatalog: ManagedCapabilityCatalogContract = fixture as ManagedCapabilityCatalogContract;
const typedAdmission: ManagedAdmissionContract = admissionFixture as ManagedAdmissionContract;

describe("ManagedCapabilityCatalog", () => {
  it("parses the canonical admission and capability files under their exact type and filename contracts", () => {
    expect(typedAdmission.negotiation_header).toEqual({ name: "x-systemsculpt-admission-contract", value: "admission-v1" });
    expect(typedAdmission.forbidden_response_fields).toEqual(["license_key", "licenseKey", "credential", "token"]);
    expect(typedCatalog.contract_version).toBe("managed-capabilities-v2");
  });

  it("parses the canonical five aliases and three deeply nested request contracts without renaming", () => {
    const catalog = ManagedCapabilityCatalog.parse(fixture);
    expect(catalog.capabilities.map((entry) => entry.alias)).toEqual([
      "systemsculpt/chat", "systemsculpt/embeddings", "systemsculpt/transcription",
      "systemsculpt/documents", "systemsculpt/images",
    ]);
    expect(catalog.capabilities.flatMap((entry) => entry.request_contracts.map((contract) => contract.capability))).toEqual([
      "chat_turn", "text_generation", "embeddings",
    ]);
    const chat = catalog.capabilities[0].request_contracts[0];
    expect(chat.request?.body).toEqual(fixture.capabilities[0].request_contracts[0].request.body);
    expect(chat.response?.definitions).toEqual(fixture.capabilities[0].request_contracts[0].response.definitions);
    expect(catalog.capabilities[1].generation).toEqual({
      id: "semantic-v1",
      index_schema_version: 2,
      index_namespace: "systemsculpt:managed:semantic-v1:v2:<dimensions>",
    });
  });

  it("rejects malformed or wrong-version contracts rather than manufacturing support", () => {
    expect(() => ManagedCapabilityCatalog.parse({ ...fixture, contract_version: "managed-capabilities-v1" })).toThrow();
    expect(() => ManagedCapabilityCatalog.parse({ ...fixture, capabilities: fixture.capabilities.slice(0, 4) })).toThrow();
  });

  it("rejects moved, duplicated, extra, and deeply malformed request contracts", () => {
    const moved = structuredClone(fixture) as any;
    moved.capabilities[0].request_contracts.splice(0, 1);
    moved.capabilities[1].request_contracts.push(fixture.capabilities[0].request_contracts[0]);
    expect(() => ManagedCapabilityCatalog.parse(moved)).toThrow();

    const extra = structuredClone(fixture) as any;
    extra.capabilities[0].request_contracts.push({ ...fixture.capabilities[0].request_contracts[1], capability: "extra" });
    expect(() => ManagedCapabilityCatalog.parse(extra)).toThrow();

    const malformed = structuredClone(fixture) as any;
    malformed.capabilities[0].request_contracts[0].response.definitions.managed_chat_delta_v1.allowed_delta_fields.push("provider");
    expect(() => ManagedCapabilityCatalog.parse(malformed)).toThrow();

    const malformedEmbedding = structuredClone(fixture) as any;
    malformedEmbedding.capabilities[1].request_contracts[0].response.one_of[0].required_fields.pop();
    expect(() => ManagedCapabilityCatalog.parse(malformedEmbedding)).toThrow();

    const missingGeneration = structuredClone(fixture) as any;
    delete missingGeneration.capabilities[1].generation;
    expect(() => ManagedCapabilityCatalog.parse(missingGeneration)).toThrow();

    const malformedGeneration = structuredClone(fixture) as any;
    malformedGeneration.capabilities[1].generation.extra = true;
    expect(() => ManagedCapabilityCatalog.parse(malformedGeneration)).toThrow();
  });

  it("rejects descriptor field, placement, metering, background, limits, or extra-property drift", () => {
    for (const mutate of [
      (copy: any) => { copy.capabilities.reverse(); },
      (copy: any) => { copy.capabilities[0].metering = "metered_job"; },
      (copy: any) => { copy.capabilities[0].background_eligible = true; },
      (copy: any) => { copy.capabilities[0].limits = []; },
      (copy: any) => { copy.capabilities[0].extra = true; },
      (copy: any) => { copy.extra = true; },
    ]) {
      const copy = structuredClone(fixture) as any;
      mutate(copy);
      expect(() => ManagedCapabilityCatalog.parse(copy)).toThrow();
    }
  });

  it.each([undefined, null, false, "300", {}, [], 0, -1, 1, 299, 301, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])(
    "rejects noncanonical cache_ttl_seconds %p as contract drift",
    (cacheTTL) => {
      const drifted = { ...fixture, cache_ttl_seconds: cacheTTL } as any;
      if (typeof cacheTTL === "undefined") delete drifted.cache_ttl_seconds;
      expect(() => ManagedCapabilityCatalog.parse(drifted)).toThrow();
    },
  );
});
