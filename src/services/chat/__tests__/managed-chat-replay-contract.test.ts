import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../../../types";
import { projectManagedMessages } from "../AcceptedChatRequestSnapshot";

const fixturePath = join(
  process.cwd(),
  "testing",
  "fixtures",
  "managed",
  "managed-chat-replay-v1.json",
);
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  contract_version: string;
  scenarios: Array<{
    name: string;
    durable_messages: ChatMessage[];
    expected_wire: Array<Record<string, unknown>>;
  }>;
};

describe("managed chat replay consumer contract", () => {
  it("pins the exact cross-repository replay fixture", () => {
    expect(fixture.contract_version).toBe("managed-chat-replay-v1");
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "8c4618dc65cfaa1646a3c4d99daa746bc531918e96f137a5deaf7a0185d8dd3a",
    );
  });

  it.each(fixture.scenarios)("$name projects the website-accepted wire", (scenario) => {
    expect(projectManagedMessages(scenario.durable_messages)).toEqual(
      scenario.expected_wire,
    );
  });

  it("keeps scenario and durable tool-call identities unambiguous", () => {
    expect(new Set(fixture.scenarios.map((scenario) => scenario.name)).size)
      .toBe(fixture.scenarios.length);
    for (const scenario of fixture.scenarios) {
      const ids = scenario.durable_messages.flatMap((message) =>
        (message.tool_calls ?? []).map((call) => call.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    }
  });

  it("fails closed when the shared mixed-history corpus is mutated to duplicate a client call", () => {
    const mixed = fixture.scenarios.find(
      (scenario) => scenario.name === "mixed_server_and_vault_follow_up",
    )!;
    const durable = structuredClone(mixed.durable_messages);
    const assistant = durable.find((message) => message.role === "assistant")!;
    const clientCall = assistant.tool_calls?.find((call) => call.id === "call-vault-mixed")!;
    assistant.tool_calls = [
      ...(assistant.tool_calls ?? []),
      { ...clientCall, timestamp: clientCall.timestamp + 1 },
    ];

    expect(() => projectManagedMessages(durable)).toThrow("duplicate client tool-call id");
  });
});
