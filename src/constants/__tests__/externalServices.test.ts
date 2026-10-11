import { withPluginAttribution } from "../externalServices";

describe("purchase attribution", () => {
  it("keeps a checkout offer and overwrites attribution once for the initiating surface", () => {
    const href = withPluginAttribution(
      "https://systemsculpt.com/checkout?resourceId=offer&ref=pricing&utm_source=dashboard#details",
      "account",
    );
    const url = new URL(withPluginAttribution(href, "account"));
    expect(url.searchParams.get("resourceId")).toBe("offer");
    expect(url.searchParams.get("ref")).toBe("pricing");
    expect(url.searchParams.getAll("utm_source")).toEqual(["obsidian-plugin"]);
    expect(url.searchParams.get("utm_medium")).toBe("account");
    expect(url.hash).toBe("#details");
  });

  it.each(["https://systemsculpt.com/buy-credits", "https://www.systemsculpt.com/pricing"])("attributes supported first-party purchase destinations: %s", (href) => {
    expect(new URL(withPluginAttribution(href, "credits")).searchParams.get("utm_source")).toBe("obsidian-plugin");
  });

  it.each([
    "https://checkout.stripe.com/c/pay/session?token=original",
    "https://example.com/pricing",
    "https://systemsculpt.com/docs",
    "javascript:alert(1)",
    "not a URL",
  ])("leaves non-purchase destinations unchanged: %s", (url) => {
    expect(withPluginAttribution(url, "account")).toBe(url);
  });
});
