/** @jest-environment jsdom */

import { createUiRadioGroup } from "../SurfaceRadioGroup";

function createFixture(onChange?: jest.Mock) {
  const group = document.body.createDiv();
  const values = ["one", "two", "three"] as const;
  const bindings = values.map((value) => ({
    value,
    button: group.createEl("button", { text: value }),
  }));
  const handle = createUiRadioGroup(group, bindings, {
    value: "one",
    label: "Choice",
    onChange,
  });
  return { group, bindings, handle };
}

describe("createUiRadioGroup", () => {
  afterEach(() => document.body.empty());

  it("owns labelled radio semantics and one roving tab stop", () => {
    const { group, bindings } = createFixture();

    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Choice");
    expect(bindings.map(({ button }) => button.getAttribute("role"))).toEqual([
      "radio",
      "radio",
      "radio",
    ]);
    expect(bindings.map(({ button }) => button.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(bindings.map(({ button }) => button.tabIndex)).toEqual([0, -1, -1]);
    expect(new Set(bindings.map(({ button }) => button.id)).size).toBe(3);
  });

  it("selects and focuses with arrows, wrapping and honoring Home/End", async () => {
    const onChange = jest.fn(() => true);
    const { bindings, handle } = createFixture(onChange);

    bindings[0].button.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
    }));
    await Promise.resolve();
    expect(handle.value).toBe("three");
    expect(document.activeElement).toBe(bindings[2].button);
    expect(onChange).toHaveBeenLastCalledWith("three", "one", "keyboard");

    bindings[2].button.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await Promise.resolve();
    expect(handle.value).toBe("one");

    bindings[0].button.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await Promise.resolve();
    expect(handle.value).toBe("three");
  });

  it("exposes busy state and rolls rejected async selection back", async () => {
    let reject!: (error: Error) => void;
    const onError = jest.fn();
    const promise = new Promise<void>((_resolve, nextReject) => { reject = nextReject; });
    const group = document.body.createDiv();
    const one = group.createEl("button");
    const two = group.createEl("button");
    const handle = createUiRadioGroup(group, [
      { value: "one", button: one },
      { value: "two", button: two },
    ], {
      value: "one",
      onChange: () => promise,
      onError,
    });

    two.click();
    expect(group.getAttribute("aria-busy")).toBe("true");
    expect(two.getAttribute("aria-checked")).toBe("true");
    expect(one.disabled).toBe(true);

    reject(new Error("nope"));
    await promise.catch(() => undefined);
    await Promise.resolve();

    expect(handle.value).toBe("one");
    expect(one.getAttribute("aria-checked")).toBe("true");
    expect(group.hasAttribute("aria-busy")).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("disables the whole group and removes behavior on destroy", async () => {
    const onChange = jest.fn();
    const { group, bindings, handle } = createFixture(onChange);

    handle.setDisabled(true);
    expect(group.getAttribute("aria-disabled")).toBe("true");
    expect(bindings.every(({ button }) => button.disabled)).toBe(true);

    handle.setDisabled(false);
    handle.destroy();
    bindings[1].button.click();
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });
});
