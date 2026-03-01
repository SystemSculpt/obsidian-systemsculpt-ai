import { isOAuthCodePrompt } from "../oauthUiHelpers";

describe("oauthUiHelpers", () => {
  it("detects authorization-code prompts", () => {
    expect(isOAuthCodePrompt({ message: "Paste the authorization code:" })).toBe(true);
    expect(isOAuthCodePrompt({ placeholder: "Paste the redirect URL" })).toBe(true);
    expect(isOAuthCodePrompt({ message: "Enter oauth code" })).toBe(true);
  });

  it("ignores unrelated prompts", () => {
    expect(isOAuthCodePrompt({ message: "Enter your API key" })).toBe(false);
    expect(isOAuthCodePrompt({ placeholder: "sk-..." })).toBe(false);
    expect(isOAuthCodePrompt({})).toBe(false);
  });
});
