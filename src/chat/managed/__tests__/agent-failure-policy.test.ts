import { isAgentAuthorizationRejection, isAgentBillingFailure } from "../AgentFailurePolicy";

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

describe("managed authorization rejection classification", () => {
  it.each([401, 403])("recognizes HTTP %s whatever the code", (status) => {
    expect(isAgentAuthorizationRejection({ status })).toBe(true);
    expect(isAgentAuthorizationRejection({ status, code: "license_invalid" })).toBe(true);
  });

  it.each([
    undefined, null, false, 401, "401",
    {}, { status: "401" }, { status: 402 }, { status: 429 }, { status: 500 }, { status: 503 },
    { code: "license_invalid" },
  ])("does not treat %p as an authorization rejection", (failure) => {
    expect(isAgentAuthorizationRejection(failure)).toBe(false);
  });
});
