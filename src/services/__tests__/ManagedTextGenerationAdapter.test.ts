import { createHash } from "crypto";
import { readFileSync } from "fs";
import capabilityFixture from "../../../testing/fixtures/managed/managed-capabilities-v2.json";
import routeFixture from "../../../testing/fixtures/managed/managed-text-generation-route-v1.json";
import { ManagedCapabilityCatalog } from "../managed/ManagedCapabilityCatalog";
import {
  ManagedTextGenerationAdapter,
  ManagedTextGenerationError,
} from "../managed/ManagedTextGenerationAdapter";

const catalog = ManagedCapabilityCatalog.parse(capabilityFixture);
const descriptor = catalog.capabilities.find((entry) => entry.alias === "systemsculpt/chat")!;
const textContract = descriptor.request_contracts.find((entry) => entry.capability === "text_generation")!;
const allowedLease = { outcome: "allowed", descriptor, requestContract: textContract } as const;

function jsonResponse(value: unknown, status = 200, requestId = "textreq_1"): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-request-id": requestId },
  });
}

function success(content = "Generated text"): unknown {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "ai-agent",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

function harness(outcome: typeof allowedLease | { outcome: string } = allowedLease) {
  const acquireLease = jest.fn().mockResolvedValue(outcome);
  const request = jest.fn().mockResolvedValue({
    response: jsonResponse(success()),
    diagnostics: { requestId: "textreq_1", status: 200, contentType: "application/json; charset=utf-8" },
  });
  return {
    adapter: new ManagedTextGenerationAdapter({ admission: { acquireLease } as any, transport: { request } as any }),
    acquireLease,
    request,
  };
}

const operation = (buildMessages = jest.fn(() => [
  { role: "system" as const, content: "Be concise." },
  { role: "user" as const, content: "Source" },
])) => ({
  operationId: "workflow:operation_1",
  purpose: "workflow_automation" as const,
  buildMessages,
});

describe("ManagedTextGenerationAdapter", () => {
  it("copies the immutable website route fixture byte-for-byte", () => {
    const bytes = readFileSync("testing/fixtures/managed/managed-text-generation-route-v1.json");
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("7970c0f2fb892fc4b07195db1556caf630a9bc6787d7a941d3ed6b4d8a5d1b59");
    expect(routeFixture).toMatchObject({
      method: "POST",
      path: "/api/v1/chat/completions",
      capability: "text_generation",
      background_eligible: true,
      cancellation_supported: false,
      idempotency: {
        policy: "dedupe_without_result_replay",
        automatic_same_key_poll_or_post_retry: false,
        automatic_new_key_retry: false,
        unknown_outcome: "durable_ambiguous_state",
      },
    });
  });

  it.each(["license_required", "license_rejected", "temporarily_unavailable", "rate_limited", "capability_unavailable"])(
    "does not read or serialize payload when admission is %s",
    async (outcome) => {
      const { adapter, request } = harness({ outcome });
      const buildMessages = jest.fn();
      await expect(adapter.generate(operation(buildMessages))).rejects.toMatchObject({
        name: "ManagedTextGenerationError",
        code: outcome,
        operationId: "workflow:operation_1",
      });
      expect(buildMessages).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("uses only the exact nested contract and immutable non-stream route", async () => {
    const { adapter, acquireLease, request } = harness();
    const buildMessages = operation().buildMessages;
    await expect(adapter.generate(operation(buildMessages))).resolves.toEqual(expect.objectContaining({
      operationId: "workflow:operation_1",
      requestId: "textreq_1",
      text: "Generated text",
      finishReason: "stop",
    }));
    expect(acquireLease).toHaveBeenCalledWith({ alias: "systemsculpt/chat", requestContract: "text_generation" });
    expect(buildMessages).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      path: "/api/v1/chat/completions",
      method: "POST",
      capability: "text_generation",
      idempotencyKey: "workflow:operation_1",
      body: {
        model: "ai-agent",
        stream: false,
        purpose: "workflow_automation",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Source" },
        ],
      },
      signal: undefined,
    });
  });

  it.each([
    ["wrong purpose", { ...operation(), purpose: "chat" }],
    ["invalid operation key", { ...operation(), operationId: "workflow/key" }],
    ["empty messages", operation(jest.fn(() => []))],
    ["too many messages", operation(jest.fn(() => Array.from({ length: 9 }, () => ({ role: "user" as const, content: "x" }))))],
    ["unsupported role", operation(jest.fn(() => [{ role: "assistant" as const, content: "x" }]))],
    ["empty content", operation(jest.fn(() => [{ role: "user" as const, content: "" }]))],
    ["oversized content", operation(jest.fn(() => [{ role: "user" as const, content: "é".repeat(262_145) }]))],
  ])("rejects %s before transport", async (_name, input) => {
    const { adapter, request } = harness();
    await expect(adapter.generate(input as any)).rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a drifted lease before payload construction", async () => {
    const { adapter, request } = harness({
      ...allowedLease,
      requestContract: { ...textContract, background_eligible: false },
    } as any);
    const buildMessages = jest.fn();
    await expect(adapter.generate(operation(buildMessages))).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(buildMessages).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [400, "invalid_request", false],
    [401, "license_required", false],
    [402, "insufficient_credits", false],
    [403, "license_rejected", false],
    [429, "rate_limited", true],
    [500, "internal_error", false],
    [502, "upstream_failed", false],
    [503, "temporarily_unavailable", true],
  ] as const)("preserves exact typed HTTP %s failures", async (status, code, retryable) => {
    const { adapter, request } = harness();
    const extra = status === 402 ? { credits_remaining: 0, cycle_ends_at: null }
      : status === 429 ? { retry_after_ms: 1000 }
      : {};
    request.mockResolvedValueOnce({
      response: jsonResponse({ error: { code, message: "Bounded first-party error", request_id: "textreq_1", retryable, ...extra } }, status),
      diagnostics: { requestId: "textreq_1", status, contentType: "application/json; charset=utf-8" },
    });
    await expect(adapter.generate(operation())).rejects.toMatchObject({
      name: "ManagedTextGenerationError", code, status, requestId: "textreq_1", retryable,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves exact 409 reconciliation disposition without replay", async () => {
    const { adapter, request } = harness();
    request.mockResolvedValueOnce({
      response: jsonResponse({ error: {
        code: "operation_in_progress",
        message: "This generation requires manual reconciliation.",
        request_id: "textreq_1",
        retryable: false,
        disposition: "manual_reconciliation",
        retry_after_ms: null,
      } }, 409),
      diagnostics: { requestId: "textreq_1", status: 409, contentType: "application/json" },
    });
    await expect(adapter.generate(operation())).rejects.toMatchObject({
      code: "operation_in_progress", retryable: false, disposition: "manual_reconciliation",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("marks transport uncertainty as a durable ambiguous outcome and never retries", async () => {
    const { adapter, request } = harness();
    request.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(adapter.generate(operation())).rejects.toMatchObject({
      code: "ambiguous_outcome",
      operationId: "workflow:operation_1",
      ambiguous: true,
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a pre-dispatch local abort from server cancellation", async () => {
    const { adapter, request } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.generate({ ...operation(), signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
      code: "local_aborted",
      ambiguous: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed success envelopes and mismatched request IDs", async () => {
    const { adapter, request } = harness();
    request.mockResolvedValueOnce({
      response: jsonResponse({ ...success(), provider: "leak" }),
      diagnostics: { requestId: "different", status: 200, contentType: "application/json" },
    });
    await expect(adapter.generate(operation())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("exports a closed first-party error type", () => {
    const error = new ManagedTextGenerationError({
      code: "temporarily_unavailable",
      message: "Unavailable",
      operationId: "postprocess:1",
      retryable: true,
    });
    expect(error).toMatchObject({ name: "ManagedTextGenerationError", requestId: null, ambiguous: false });
    expect(error).not.toHaveProperty("provider");
    expect(error).not.toHaveProperty("model");
    expect(error).not.toHaveProperty("body");
  });
});
