import {
  parseThinAgentCapabilityManifest,
  ThinAgentContractError,
} from "../ThinAgentV1Contract";

describe("ThinAgentV1Contract", () => {
  it("rejects duplicate vault capabilities instead of negotiating ambiguous support", () => {
    expect(() => parseThinAgentCapabilityManifest({
      contract_version: "thin-agent-capabilities-v1",
      capabilities: [
        { id: "obsidian.vault", version: 1 },
        { id: "obsidian.vault", version: 1 },
      ],
    })).toThrow(new ThinAgentContractError(
      "invalid_capabilities",
      "Client capabilities must be unique.",
    ));
  });
});
