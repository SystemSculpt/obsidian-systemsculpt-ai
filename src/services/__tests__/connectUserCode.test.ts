import { deriveConnectUserCode, formatConnectUserCode } from "../connectUserCode";

// The same vectors as the website's tests/plugin-connect/connect-user-code.test.ts:
// the page accepts a sign-in only when both sides derive the same code.
describe("deriveConnectUserCode", () => {
  it.each([
    ["B".repeat(43), "G1JPJTC9"],
    ["c".repeat(43), "W6B025XK"],
  ])("matches the website for %s", async (challenge, code) => {
    await expect(deriveConnectUserCode(challenge)).resolves.toBe(code);
  });

  it("formats the code as the website shows it", () => {
    expect(formatConnectUserCode("G1JPJTC9")).toBe("G1JP-JTC9");
  });
});
