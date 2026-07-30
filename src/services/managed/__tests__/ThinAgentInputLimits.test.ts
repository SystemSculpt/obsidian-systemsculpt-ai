import {
  DEFAULT_THIN_AGENT_INPUT_LIMITS,
  parseThinAgentInputLimits,
  thinAgentInputLimitsWireValue,
} from "../ThinAgentInputLimits";

describe("ThinAgentInputLimits", () => {
  it("parses the stable bootstrap picker limits", () => {
    expect(parseThinAgentInputLimits(
      thinAgentInputLimitsWireValue(DEFAULT_THIN_AGENT_INPUT_LIMITS),
    )).toEqual(DEFAULT_THIN_AGENT_INPUT_LIMITS);
  });

  it("fails closed on malformed, unsupported, or unsafe server values", () => {
    const valid = thinAgentInputLimitsWireValue(DEFAULT_THIN_AGENT_INPUT_LIMITS);
    expect(() => parseThinAgentInputLimits({
      ...valid,
      max_image_bytes: 0,
    })).toThrow("maxImageBytes");
    expect(() => parseThinAgentInputLimits({
      ...valid,
      image_mime_types: ["image/gif"],
    })).toThrow("image MIME");
    expect(() => parseThinAgentInputLimits({
      ...valid,
      max_document_bytes: 101 * 1024 * 1024,
    })).toThrow("maxDocumentBytes");
  });
});
