import {
  normalizeLanguageCode,
  getBaseLanguageCode,
  areLanguageCodesEquivalent,
  getLanguageName,
} from "../languages";

describe("language helpers", () => {
  it("normalizes language codes consistently", () => {
    expect(normalizeLanguageCode("EN_us")).toBe("en-us");
    expect(normalizeLanguageCode(" pt-BR ")).toBe("pt-br");
  });

  it("extracts base language codes", () => {
    expect(getBaseLanguageCode("en-US")).toBe("en");
    expect(getBaseLanguageCode("fr")).toBe("fr");
  });

  it("matches equivalent language codes", () => {
    expect(areLanguageCodesEquivalent("en-US", "en")).toBe(true);
    expect(areLanguageCodesEquivalent("pt_BR", "pt")).toBe(true);
    expect(areLanguageCodesEquivalent("en", "ar")).toBe(false);
  });

  it("resolves human-friendly names for regional codes", () => {
    expect(getLanguageName("en-US")).toBe("English");
    expect(getLanguageName("pt_BR")).toBe("Portuguese");
  });
});
