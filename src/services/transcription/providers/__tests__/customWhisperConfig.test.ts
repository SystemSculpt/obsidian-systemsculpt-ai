import {
  CUSTOM_WHISPER_CONTRACT,
  validateCustomWhisperConfig,
} from "../customWhisperConfig";

describe("validateCustomWhisperConfig", () => {
  it("errors when the endpoint is missing", () => {
    const result = validateCustomWhisperConfig({ endpoint: "" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/required/i);
  });

  it("errors on a non-URL endpoint", () => {
    const result = validateCustomWhisperConfig({ endpoint: "not a url" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/full URL/i);
  });

  it("errors on a non-http(s) protocol", () => {
    const result = validateCustomWhisperConfig({ endpoint: "ftp://host/audio/transcriptions" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/http/i);
  });

  it("passes a well-formed hosted endpoint with a key and model", () => {
    const result = validateCustomWhisperConfig({
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      apiKey: "gsk_x",
      model: "whisper-large-v3",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("warns (not errors) when a remote endpoint uses http", () => {
    const result = validateCustomWhisperConfig({
      endpoint: "http://example.com/v1/audio/transcriptions",
      apiKey: "k",
      model: "whisper-1",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /unencrypted|http/i.test(w))).toBe(true);
  });

  it("does not warn about http for localhost", () => {
    const result = validateCustomWhisperConfig({
      endpoint: "http://localhost:9000/v1/audio/transcriptions",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /unencrypted/i.test(w))).toBe(false);
  });

  it("treats the IPv6 loopback [::1] as local (URL.hostname is bracketed)", () => {
    const result = validateCustomWhisperConfig({
      endpoint: "http://[::1]:9000/v1/audio/transcriptions",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /unencrypted/i.test(w))).toBe(false);
    expect(result.warnings.some((w) => /API key/i.test(w))).toBe(false);
  });

  it("treats a 127.x.x.x address as local but not a domain that merely starts with 127.", () => {
    const loopback = validateCustomWhisperConfig({
      endpoint: "http://127.0.0.53:9000/v1/audio/transcriptions",
    });
    expect(loopback.warnings.some((w) => /unencrypted/i.test(w))).toBe(false);

    const spoof = validateCustomWhisperConfig({
      endpoint: "http://127.example.com/v1/audio/transcriptions",
    });
    expect(spoof.warnings.some((w) => /unencrypted/i.test(w))).toBe(true);
  });

  it("does not warn about a missing key for localhost", () => {
    const result = validateCustomWhisperConfig({
      endpoint: "http://localhost:9000/v1/audio/transcriptions",
      model: "base",
    });
    expect(result.warnings.some((w) => /API key/i.test(w))).toBe(false);
  });

  it("warns when no model is set", () => {
    const result = validateCustomWhisperConfig({
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      apiKey: "sk-x",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /model/i.test(w))).toBe(true);
  });

  it("warns when no API key is set on a remote endpoint", () => {
    const result = validateCustomWhisperConfig({
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      model: "whisper-1",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /API key/i.test(w))).toBe(true);
  });

  it('warns when the path lacks a "transcriptions" segment', () => {
    const result = validateCustomWhisperConfig({
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-x",
      model: "whisper-1",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /transcription/i.test(w))).toBe(true);
  });

  it("exposes a documented contract string covering request + response shapes", () => {
    expect(CUSTOM_WHISPER_CONTRACT).toMatch(/multipart\/form-data/);
    expect(CUSTOM_WHISPER_CONTRACT).toMatch(/\{ text \}/);
    expect(CUSTOM_WHISPER_CONTRACT).toMatch(/segments/);
  });
});
