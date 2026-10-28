import { isAgentBillingFailure } from "../AgentFailurePolicy";

describe("managed billing failure classification", () => {
  it.each(["insufficient_credits", "payment_required", "out_of_credits"])(
    "recognizes the authoritative %s code without an HTTP status",
    (code) => {
      expect(isAgentBillingFailure({ code })).toBe(true);
    },
  );

  it("recognizes HTTP 402 even when the server adds an unknown code", () => {
    expect(isAgentBillingFailure({ status: 402, code: "new_billing_code" })).toBe(true);
  });

  it.each([
    undefined, null, false, "payment_required", 402,
    {}, { status: "402" }, { status: 401 }, { status: 403 },
    { code: "rate_limited" }, { code: "PAYMENT_REQUIRED" }, { code: 402 },
  ])("does not reinterpret unrelated or malformed failures as billing: %p", (failure) => {
    expect(isAgentBillingFailure(failure)).toBe(false);
  });
});
