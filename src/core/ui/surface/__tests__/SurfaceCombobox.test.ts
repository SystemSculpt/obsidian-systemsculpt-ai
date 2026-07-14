/** @jest-environment jsdom */

import { SurfaceCombobox } from "../SurfaceCombobox";

type Item = { id: string; label: string; selected?: boolean };

const key = (value: string): KeyboardEvent =>
  new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });

describe("SurfaceCombobox", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("owns stable semantics, filtering, navigation, commit focus, busy state, and teardown", () => {
    const input = document.body.createEl("input");
    const listbox = document.body.createDiv();
    const focusTarget = document.body.createEl("button");
    const onCommit = jest.fn();
    const onOpenChange = jest.fn();
    const filterItems = jest.fn(
      (source: readonly Item[], query: string) => source.filter((item) =>
        item.label.toLowerCase().includes(query.trim().toLowerCase())),
    );
    const scrollById = new Map<string, jest.Mock>();
    const items: Item[] = [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta", selected: true },
      { id: "gamma", label: "Gamma" },
    ];

    const combobox = new SurfaceCombobox<Item>({
      input,
      listbox,
      listboxLabel: "Example options",
      initiallyOpen: true,
      activeMode: "selected",
      getItemKey: (item) => item.id,
      filterItems,
      isSelected: (item) => item.selected === true,
      renderOption: ({ item, ownerDocument }) => {
        const option = ownerDocument.createElement("div");
        option.textContent = item.label;
        const scroll = jest.fn();
        option.scrollIntoView = scroll;
        scrollById.set(item.id, scroll);
        return option;
      },
      onCommit,
      closeOnCommit: true,
      focusTargetAfterClose: focusTarget,
      onOpenChange,
    });

    combobox.setItems(items);

    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(listbox.getAttribute("aria-label")).toBe("Example options");
    const betaBeforeFilter = Array.from(listbox.children).find((option) =>
      option.textContent === "Beta") as HTMLElement;
    expect(betaBeforeFilter.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(betaBeforeFilter.id);

    input.value = "bet";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const betaAfterFilter = listbox.firstElementChild as HTMLElement;
    expect(betaAfterFilter.textContent).toBe("Beta");
    expect(betaAfterFilter.id).toBe(betaBeforeFilter.id);

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(key("End"));
    expect(combobox.activeItem?.id).toBe("gamma");
    expect(scrollById.get("gamma")).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "auto",
    });
    input.dispatchEvent(key("Home"));
    expect(combobox.activeItem?.id).toBe("alpha");

    input.dispatchEvent(key("Enter"));
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
      item: items[0],
      index: 0,
    }));
    expect(combobox.isOpen).toBe(false);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(document.activeElement).toBe(focusTarget);

    combobox.setOpen(true);
    input.focus();
    input.dispatchEvent(key("Escape"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(focusTarget);

    combobox.setBusy(true);
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect(listbox.getAttribute("aria-busy")).toBe("true");

    combobox.destroy();
    expect(input.getAttribute("aria-busy")).toBe("false");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    const filtersBeforeDetachedInput = filterItems.mock.calls.length;
    input.value = "alpha";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(filterItems).toHaveBeenCalledTimes(filtersBeforeDetachedInput);
    expect(() => combobox.setItems(items)).toThrow("has been destroyed");
  });

  it("supports a no-selection, wrapping adapter and pointer activation", () => {
    const input = document.body.createEl("input");
    const listbox = document.body.createDiv();
    const onCommit = jest.fn();
    const items: Item[] = [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
    ];
    const combobox = new SurfaceCombobox<Item>({
      input,
      listbox,
      initiallyOpen: true,
      activeMode: "none",
      navigation: "wrap",
      selectionFollowsActive: true,
      activeClass: "is-selected",
      getItemKey: (item) => item.id,
      filterItems: (source) => source,
      renderOption: ({ item, ownerDocument }) => {
        const option = ownerDocument.createElement("div");
        option.textContent = item.label;
        option.scrollIntoView = jest.fn();
        return option;
      },
      onCommit,
    });
    combobox.setItems(items);

    expect(combobox.activeIndex).toBe(-1);
    input.dispatchEvent(key("ArrowUp"));
    expect(combobox.activeItem?.id).toBe("two");
    expect(listbox.lastElementChild?.getAttribute("aria-selected")).toBe("true");

    const first = listbox.firstElementChild as HTMLElement;
    first.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(combobox.activeItem?.id).toBe("one");
    first.click();
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ item: items[0] }));
  });

  it("preserves keyed option focus and scroll across dynamic collection replacement", () => {
    const input = document.body.createEl("input");
    const listbox = document.body.createDiv();
    const group = (): HTMLElement => {
      const existing = listbox.querySelector<HTMLElement>(".group");
      return existing ?? listbox.createDiv("group");
    };
    const combobox = new SurfaceCombobox<Item>({
      input,
      listbox,
      initiallyOpen: true,
      activeMode: "none",
      focusMode: "options",
      returnInputOnFirstArrowUp: true,
      optionActivationEvent: false,
      selectionFollowsActive: true,
      getItemKey: (item) => item.id,
      filterItems: (source) => source,
      renderOption: ({ item, ownerDocument }) => {
        const option = ownerDocument.createElement("button");
        option.textContent = item.label;
        option.scrollIntoView = jest.fn();
        group().appendChild(option);
        return option;
      },
      onCommit: jest.fn(),
    });
    combobox.setItems([
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
    ]);

    input.focus();
    input.dispatchEvent(key("ArrowDown"));
    const first = listbox.querySelector("button") as HTMLButtonElement;
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(key("ArrowDown"));
    expect(combobox.activeItem?.id).toBe("two");
    expect((document.activeElement as HTMLElement).textContent).toBe("Two");
    listbox.scrollTop = 42;

    combobox.setItems([
      { id: "two", label: "Two updated" },
      { id: "three", label: "Three" },
    ], {
      preserveActive: true,
      preserveFocus: true,
      preserveScroll: true,
    });
    expect(combobox.activeItem?.id).toBe("two");
    expect((document.activeElement as HTMLElement).textContent).toBe("Two updated");
    expect(listbox.scrollTop).toBe(42);
    expect(listbox.querySelector(".group button")?.parentElement?.className).toBe("group");

    (document.activeElement as HTMLElement).dispatchEvent(key("ArrowUp"));
    expect(document.activeElement).toBe(input);
    expect(combobox.activeIndex).toBe(-1);

    combobox.showState((container) => {
      container.textContent = "Loading";
    }, {
      busy: true,
      open: false,
      retainListboxRole: false,
    });
    expect(listbox.getAttribute("role")).toBeNull();
    expect(listbox.getAttribute("aria-busy")).toBe("true");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    combobox.setItems([{ id: "one", label: "One" }]);
    expect(listbox.getAttribute("role")).toBe("listbox");
  });
});
