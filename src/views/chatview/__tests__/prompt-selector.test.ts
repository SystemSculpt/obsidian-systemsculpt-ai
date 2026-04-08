import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

// Ensure createDiv/createSpan helpers exist
const proto = (global as any).window.HTMLElement?.prototype;
if (proto && !proto.createDiv) {
  proto.createDiv = function (options?: any) {
    const el = document.createElement("div");
    if (typeof options === "string") {
      el.className = options;
    } else if (options?.cls) {
      `${options.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
    }
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };
}
if (proto && !proto.createSpan) {
  proto.createSpan = function (options?: any) {
    const el = document.createElement("span");
    if (typeof options === "string") {
      el.className = options;
    } else if (options?.cls) {
      `${options.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
    }
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };
}

jest.mock("obsidian", () => ({
  setIcon: jest.fn((el: HTMLElement, icon: string) => {
    el.dataset.icon = icon;
  }),
}));

import { createPromptChip, updatePromptChip } from "../PromptSelector";

describe("createPromptChip", () => {
  it("renders with 'No prompt' when no prompt is selected", () => {
    const container = document.createElement("div");
    const chip = createPromptChip(container, {
      currentPromptName: null,
      onClick: jest.fn(),
    });

    expect(chip.textContent).toContain("No prompt");
    expect(chip.classList.contains("mod-empty")).toBe(true);
  });

  it("renders the prompt name when selected", () => {
    const container = document.createElement("div");
    const chip = createPromptChip(container, {
      currentPromptName: "Python Expert",
      onClick: jest.fn(),
    });

    expect(chip.textContent).toContain("Python Expert");
    expect(chip.classList.contains("mod-empty")).toBe(false);
  });

  it("calls onClick when clicked", () => {
    const container = document.createElement("div");
    const onClick = jest.fn();
    const chip = createPromptChip(container, {
      currentPromptName: null,
      onClick,
    });

    chip.click();
    expect(onClick).toHaveBeenCalled();
  });
});

describe("updatePromptChip", () => {
  it("updates the label and class", () => {
    const container = document.createElement("div");
    const chip = createPromptChip(container, {
      currentPromptName: null,
      onClick: jest.fn(),
    });

    expect(chip.classList.contains("mod-empty")).toBe(true);

    updatePromptChip(chip, "Concise");
    const label = chip.querySelector(".systemsculpt-prompt-chip-label");
    expect(label?.textContent).toBe("Concise");
    expect(chip.classList.contains("mod-empty")).toBe(false);

    updatePromptChip(chip, null);
    expect(label?.textContent).toBe("No prompt");
    expect(chip.classList.contains("mod-empty")).toBe(true);
  });
});
