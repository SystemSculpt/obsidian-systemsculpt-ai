import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { ManagedCapabilityClient } from "../ManagedCapabilityClient";
import type { ManagedAllowedLease } from "../ManagedTypes";
import { HostedTransportAdapter } from "../adapters/HostedTransportAdapter";

describe("ManagedCapabilityClient accepted Chat dispatch", () => {
  function setup() {
    const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6", licenseKey: () => "key" });
    const admission = { acquireLease: jest.fn(() => { throw new Error("must not admit"); }), withLease: jest.fn(() => { throw new Error("must not admit"); }) };
    const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
    const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
    const lease = { outcome: "allowed", descriptor, requestContract } as ManagedAllowedLease;
    return { client: new ManagedCapabilityClient({ admission: admission as never, transport }), transport, admission, lease };
  }

  it("binds and dispatches the exact accepted lease without admission", async () => {
    const { client, transport, admission, lease } = setup();
    const response = new Response("data: [DONE]\n\n");
    const dispatch = jest.spyOn(transport, "streamAcceptedChat").mockResolvedValue({ response, diagnostics: {
      status: 200, requestId: null, contentType: "text/event-stream", rateLimitLimit: null, rateLimitRemaining: null,
      rateLimitReset: null, retryAfter: null, errorText: "",
    } });
    const body = { model: "ai-agent", stream: true, messages: [] } as const;
    await client.streamAcceptedChat(lease, body, "key-1");
    expect(dispatch).toHaveBeenCalledWith({ path: "/api/v1/chat/completions", method: "POST", capability: "chat_turn", idempotencyKey: "key-1", body, signal: undefined });
    expect(admission.acquireLease).not.toHaveBeenCalled();
    expect(admission.withLease).not.toHaveBeenCalled();
  });

  it("rejects a mismatched accepted lease before transport", async () => {
    const { client, transport, lease } = setup();
    const dispatch = jest.spyOn(transport, "streamAcceptedChat");
    const mismatched = { ...lease, requestContract: { ...lease.requestContract, background_eligible: true } } as ManagedAllowedLease;
    await expect(client.streamAcceptedChat(mismatched, { model: "ai-agent" }, "key")).rejects.toThrow("required contract");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
