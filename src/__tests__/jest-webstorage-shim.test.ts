/**
 * @jest-environment node
 */

describe("Jest webstorage shim", () => {
  it("does not emit Node webstorage warnings when localStorage is touched", () => {
    const emitSpy = jest.spyOn(process, "emitWarning");

    const sym = Symbol.for("$$jest-protect-from-deletion");
    Reflect.get((globalThis as any).localStorage, sym);

    const messages = emitSpy.mock.calls.map((call) => String(call?.[0] ?? ""));
    expect(messages.some((m) => m.includes("--localstorage-file"))).toBe(false);
  });
});

