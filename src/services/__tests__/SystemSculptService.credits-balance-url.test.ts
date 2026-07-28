/**
 * @jest-environment node
 */

import { normalizeCreditsCheckoutUrl } from "../SystemSculptService";

describe("normalizeCreditsCheckoutUrl", () => {
  it("accepts canonical relative paths and owned https destinations", () => {
    expect(normalizeCreditsCheckoutUrl("/checkout?resourceId=abc123")).toBe(
      "https://systemsculpt.com/checkout?resourceId=abc123"
    );
    expect(normalizeCreditsCheckoutUrl("https://systemsculpt.com/pricing")).toBe(
      "https://systemsculpt.com/pricing"
    );
    expect(normalizeCreditsCheckoutUrl("https://www.systemsculpt.com/pricing")).toBe(
      "https://www.systemsculpt.com/pricing"
    );
  });

  it.each([
    "http://systemsculpt.com/pricing",
    "https://systemsculpt.com:444/pricing",
    "https://www.systemsculpt.com:444/pricing",
    "https://api.systemsculpt.com/pricing",
    "https://systemsculpt.com.evil.example/pricing",
    "https://evil.example/pricing",
    "https://user:pass@systemsculpt.com/pricing",
    "//evil.example/pricing",
    "/\\\\evil.example/pricing",
    "javascript:alert(1)",
    "data:text/html,owned",
    "pricing",
    "not a url",
  ])("rejects unsafe checkout destination %s", (value) => {
    expect(normalizeCreditsCheckoutUrl(value)).toBeNull();
  });
});
