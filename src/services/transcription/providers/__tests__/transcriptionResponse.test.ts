import { normalizeTranscriptionResponse } from "../transcriptionResponse";

describe("normalizeTranscriptionResponse", () => {
  it("accepts a raw string body (text/plain self-hosted servers)", () => {
    expect(normalizeTranscriptionResponse("  hello world  ")).toEqual({
      text: "hello world",
      raw: "  hello world  ",
    });
  });

  it("accepts top-level { text } (OpenAI json)", () => {
    const data = { text: "a transcript" };
    expect(normalizeTranscriptionResponse(data)).toMatchObject({ text: "a transcript" });
  });

  it("accepts nested { data: { text } } (managed SystemSculpt wrapper)", () => {
    const data = { data: { text: "wrapped transcript" } };
    expect(normalizeTranscriptionResponse(data)).toMatchObject({ text: "wrapped transcript" });
  });

  it("captures segments alongside top-level text (verbose_json)", () => {
    const data = {
      text: "one two",
      language: "en",
      segments: [
        { start: 0, end: 1.5, text: "one" },
        { start: 1.5, end: 2.5, text: "two" },
      ],
    };
    expect(normalizeTranscriptionResponse(data)).toEqual({
      text: "one two",
      language: "en",
      segments: [
        { text: "one", start: 0, end: 1.5 },
        { text: "two", start: 1.5, end: 2.5 },
      ],
      raw: data,
    });
  });

  it("joins a segments-only payload into text (Groq verbose without top-level text)", () => {
    const data = {
      segments: [
        { start: 0, end: 1, text: " Hello " },
        { start: 1, end: 2, text: "there" },
      ],
    };
    const result = normalizeTranscriptionResponse(data);
    expect(result?.text).toBe("Hello there");
    expect(result?.segments).toHaveLength(2);
  });

  it("ignores malformed segment entries but keeps valid ones", () => {
    const data = {
      segments: [
        { start: 0, end: 1, text: "kept" },
        { start: 1, end: 2 }, // no text -> dropped
        null, // not an object -> dropped
        { start: "x", end: "y", text: "timings-dropped" }, // bad timings, text kept
      ],
    };
    const result = normalizeTranscriptionResponse(data);
    expect(result?.text).toBe("kept timings-dropped");
    expect(result?.segments).toEqual([
      { text: "kept", start: 0, end: 1 },
      { text: "timings-dropped" },
    ]);
  });

  it("treats empty / whitespace-only transcripts as no result (null)", () => {
    expect(normalizeTranscriptionResponse("")).toBeNull();
    expect(normalizeTranscriptionResponse("   ")).toBeNull();
    expect(normalizeTranscriptionResponse({ text: "   " })).toBeNull();
    expect(normalizeTranscriptionResponse({ data: { text: "" } })).toBeNull();
    expect(normalizeTranscriptionResponse({ segments: [{ text: "   " }] })).toBeNull();
  });

  it("returns null for unrecognized shapes", () => {
    expect(normalizeTranscriptionResponse(null)).toBeNull();
    expect(normalizeTranscriptionResponse(undefined)).toBeNull();
    expect(normalizeTranscriptionResponse(42)).toBeNull();
    expect(normalizeTranscriptionResponse({ unexpected: true })).toBeNull();
    expect(normalizeTranscriptionResponse({ text: 123 })).toBeNull();
    expect(normalizeTranscriptionResponse({ data: { notText: "x" } })).toBeNull();
    expect(normalizeTranscriptionResponse([])).toBeNull();
  });

  it("prefers top-level text over nested data.text", () => {
    const data = { text: "top", data: { text: "nested" } };
    expect(normalizeTranscriptionResponse(data)?.text).toBe("top");
  });
});
