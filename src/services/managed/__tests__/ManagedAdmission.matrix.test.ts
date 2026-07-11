type ServerOutcome = "allowed" | "license_required" | "license_rejected" | "temporarily_unavailable" | "rate_limited";
type EffectiveOutcome = ServerOutcome | "disclosure_required" | "capability_unavailable";

type Operation = {
  alias: string;
  requestContract?: "chat_turn" | "text_generation" | "embeddings";
};

type Evidence = {
  server: ServerOutcome;
  acceptedDisclosureVersion: string | null;
  requiredDisclosureVersion: string | null;
  capabilityAvailability: "available" | "unavailable";
};

function evaluateAdmission(evidence: Evidence): EffectiveOutcome {
  if (evidence.server !== "allowed") return evidence.server;
  if (evidence.requiredDisclosureVersion !== null && evidence.acceptedDisclosureVersion !== evidence.requiredDisclosureVersion) {
    return "disclosure_required";
  }
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

const accepted: Omit<Evidence, "server" | "capabilityAvailability"> = {
  acceptedDisclosureVersion: "disclosure-test-v1",
  requiredDisclosureVersion: "disclosure-test-v1",
};

describe("ManagedAdmission specification matrix", () => {
  it.each(operations)("admits $alias $requestContract when every evidence source allows it", () => {
    expect(evaluateAdmission({ ...accepted, server: "allowed", capabilityAvailability: "available" })).toBe("allowed");
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
      expect(evaluateAdmission({ ...accepted, server, capabilityAvailability: "available" })).toBe(expected);
    },
  );

  it.each(operations)("composes disclosure_required only from disclosure acceptance for $alias $requestContract", () => {
    expect(evaluateAdmission({
      server: "allowed",
      acceptedDisclosureVersion: null,
      requiredDisclosureVersion: "disclosure-test-v1",
      capabilityAvailability: "available",
    })).toBe("disclosure_required");
  });

  it.each(operations)("composes capability_unavailable only from the descriptor for $alias $requestContract", () => {
    expect(evaluateAdmission({ ...accepted, server: "allowed", capabilityAvailability: "unavailable" })).toBe("capability_unavailable");
  });

  it("never masks authoritative or transient server outcomes with client-composed state", () => {
    expect(evaluateAdmission({
      server: "rate_limited",
      acceptedDisclosureVersion: null,
      requiredDisclosureVersion: "disclosure-test-v1",
      capabilityAvailability: "unavailable",
    })).toBe("rate_limited");
  });
});
