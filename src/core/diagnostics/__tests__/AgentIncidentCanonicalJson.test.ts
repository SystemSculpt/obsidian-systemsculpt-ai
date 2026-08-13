import { canonicalJsonStringify, utf8ByteLength } from "../AgentIncidentCanonicalJson";

function numberFromIeee754Hex(hex: string): number {
  const bytes = new Uint8Array(8);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return new DataView(bytes.buffer).getFloat64(0, false);
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => (
    byte.toString(16).padStart(2, "0")
  )).join("");
}

describe("incident canonical JSON", () => {
  it("matches the complete RFC 8785 representative serialization vector", () => {
    const value = {
      numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: "€$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    };
    const expected = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA'B\\"\\\\\\\\\\"/"}`;

    const serialized = canonicalJsonStringify(value);

    expect(serialized).toBe(expected);
    expect(utf8ByteLength(serialized)).toBe(118);
    expect(utf8Hex(serialized)).toBe([
      "7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c",
      "226e756d62657273223a5b3333333333333333332e333333333333332c3165",
      "2b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22",
      "e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d",
    ].join(""));
  });

  it("recursively sorts property names by raw UTF-16 code units without reordering arrays", () => {
    const officialSortingVector = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    const value = {
      z: [officialSortingVector, { ab: 3, a: 1, aa: 2, "": 0 }],
      a: { z: 2, a: 1 },
    };

    expect(canonicalJsonStringify(value)).toBe('{"a":{"a":1,"z":2},"z":[{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"},{"":0,"a":1,"aa":2,"ab":3}]}');
  });

  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ])("matches the RFC 8785 number vector %s", (hex, expected) => {
    expect(canonicalJsonStringify(numberFromIeee754Hex(hex))).toBe(expected);
  });

  it.each([
    ["7fffffffffffffff", "NaN"],
    ["7ff0000000000000", "positive infinity"],
    ["fff0000000000000", "negative infinity"],
  ])("rejects the unsupported RFC 8785 number vector %s (%s)", (hex) => {
    expect(() => canonicalJsonStringify(numberFromIeee754Hex(hex))).toThrow(
      "Incident JSON contains a non-finite number.",
    );
  });

  it.each([
    ["lone high surrogate string", "\ud800"],
    ["lone low surrogate string", "\udc00"],
    ["high surrogate followed by text", "prefix\ud800suffix"],
    ["two high surrogates", "\ud800\ud800"],
    ["low surrogate before a valid pair", "\udc00😀"],
    ["nested array string", ["valid", ["\udfff"]]],
    ["object property name", { ["bad\ud800"]: "value" }],
    ["nested object value", { valid: { text: "bad\udc00" } }],
  ])("rejects malformed Unicode in %s", (_name, value) => {
    expect(() => canonicalJsonStringify(value)).toThrow(
      "Incident JSON contains malformed Unicode.",
    );
  });

  it("preserves valid surrogate pairs without Unicode normalization", () => {
    expect(canonicalJsonStringify({ "é": "e\u0301", "😀": "\ud83d\ude00" }))
      .toBe('{"é":"é","😀":"😀"}');
  });
});
