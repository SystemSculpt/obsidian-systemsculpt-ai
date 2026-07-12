type ServerOutcome = "allowed" | "license_required" | "license_rejected" | "temporarily_unavailable" | "rate_limited";
type EffectiveOutcome = ServerOutcome | "capability_unavailable";

type Operation = {
  alias: string;
  requestContract?: "chat_turn" | "text_generation" | "embeddings";
};

type Evidence = {
  server: ServerOutcome;
  capabilityAvailability: "available" | "unavailable";
  disclosureMetadata: string | null;
};

function evaluateAdmission(evidence: Evidence): EffectiveOutcome {
  if (evidence.server !== "allowed") return evidence.server;
  if (evidence.capabilityAvailability === "unavailable") return "capability_unavailable";
  return "allowed";
}

const operations: Operation[] = [
  { alias: "systemsculpt/chat", requestContract: "chat_turn" },
  { alias: "systemsculpt/chat", requestContract: "text_generation" },
  { alias: "systemsculpt/embeddings", requestContract: "embeddings" },
  { alias: "systemsculpt/transcription" },
  { alias: "systemsculpt/documents" },
  { alias: "systemsculpt/images" },
];

describe("ManagedAdmission specification matrix", () => {
  it.each(operations)("admits $alias $requestContract when every evidence source allows it", () => {
    expect(evaluateAdmission({ server: "allowed", capabilityAvailability: "available", disclosureMetadata: null })).toBe("allowed");
  });

  const serverRows: Array<[ServerOutcome, EffectiveOutcome]> = [
    ["allowed", "allowed"],
    ["license_required", "license_required"],
    ["license_rejected", "license_rejected"],
    ["temporarily_unavailable", "temporarily_unavailable"],
    ["rate_limited", "rate_limited"],
  ];

  it.each(operations.flatMap((operation) => serverRows.map(([server, expected]) => [operation, server, expected] as const)))(
    "preserves server admission-v1 outcome $server for $operation.alias $operation.requestContract",
    (_operation, server, expected) => {
      expect(evaluateAdmission({ server, capabilityAvailability: "available", disclosureMetadata: "compatibility-only" })).toBe(expected);
    },
  );

  it.each(operations)("never turns disclosure metadata into admission state for $alias $requestContract", () => {
    expect(evaluateAdmission({ server: "allowed", capabilityAvailability: "available", disclosureMetadata: "compatibility-only" })).toBe("allowed");
  });

  it.each(operations)("composes capability_unavailable only from the descriptor for $alias $requestContract", () => {
    expect(evaluateAdmission({ server: "allowed", capabilityAvailability: "unavailable", disclosureMetadata: null })).toBe("capability_unavailable");
  });

  it("never masks authoritative or transient server outcomes with client-composed state", () => {
    expect(evaluateAdmission({
      server: "rate_limited",
      capabilityAvailability: "unavailable",
      disclosureMetadata: "compatibility-only",
    })).toBe("rate_limited");
  });
});
