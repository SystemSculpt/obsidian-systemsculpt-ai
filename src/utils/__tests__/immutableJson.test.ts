import {
  contentKeys,
  deepFreeze,
  isDeeplyFrozen,
  sameContentKeys,
  sameJsonValue,
} from "../immutableJson";

describe("immutableJson", () => {
  it("detects deep immutability and freezes owned graphs in place", () => {
    const shallow = Object.freeze({ nested: { value: 1 } });
    expect(isDeeplyFrozen(shallow)).toBe(false);
    expect(isDeeplyFrozen("text")).toBe(true);
    expect(isDeeplyFrozen(null)).toBe(true);

    const owned = { list: [{ value: 1 }], label: "a" };
    expect(deepFreeze(owned)).toBe(owned);
    expect(Object.isFrozen(owned.list[0])).toBe(true);
    expect(isDeeplyFrozen(owned)).toBe(true);

    const reused = deepFreeze({ shared: owned });
    expect(reused.shared).toBe(owned);
    expect(isDeeplyFrozen(reused)).toBe(true);
  });

  it("compares JSON values structurally like their serialization", () => {
    expect(sameJsonValue({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
    expect(sameJsonValue({ a: 1, gone: undefined }, { a: 1 })).toBe(true);
    expect(sameJsonValue({ a: 1 }, { a: 1, b: undefined, c: 2 })).toBe(false);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
    expect(sameJsonValue([1], { 0: 1 })).toBe(false);
    expect(sameJsonValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameJsonValue("1", 1)).toBe(false);
    expect(sameJsonValue(null, {})).toBe(false);
  });

  it("keys frozen values by identity and captures mutable ones as JSON", () => {
    const frozen = deepFreeze({ id: "a", text: "one" });
    const mutable = { id: "b", text: "two" };
    const before = contentKeys([frozen, mutable]);
    expect(before[0]).toBe(frozen);
    expect(sameContentKeys(before, contentKeys([frozen, mutable]))).toBe(true);

    // An equal frozen copy still matches; an in-place edit of a mutable
    // message does not, because its content was captured when keyed.
    expect(sameContentKeys(before, contentKeys([deepFreeze({ text: "one", id: "a" }), mutable])))
      .toBe(true);
    mutable.text = "edited";
    expect(sameContentKeys(before, contentKeys([frozen, mutable]))).toBe(false);
    expect(sameContentKeys(before, contentKeys([frozen]))).toBe(false);
  });
});
