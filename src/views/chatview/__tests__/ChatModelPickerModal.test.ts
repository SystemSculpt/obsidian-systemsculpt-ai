/**
 * @jest-environment jsdom
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

const ensureDomHelpers = () => {
  const proto = (global as any).window.HTMLElement?.prototype;
  if (!proto) return;
  if (!proto.addClass) {
    proto.addClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
        });
      return this;
    };
  }
  if (!proto.setText) {
    proto.setText = function (text: string) {
      this.textContent = text ?? "";
      return this;
    };
  }
  if (!proto.setAttr) {
    proto.setAttr = function (name: string, value: any) {
      if (value === null || value === undefined || value === false) {
        this.removeAttribute(name);
      } else if (value === true) {
        this.setAttribute(name, "");
      } else {
        this.setAttribute(name, `${value}`);
      }
      return this;
    };
  }
  if (!proto.createEl) {
    proto.createEl = function (tag: string, options?: any) {
      const el = (this.ownerDocument ?? document).createElement(tag);
      if (options?.cls) {
        `${options.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
      }
      if (options?.text !== undefined) {
        el.textContent = `${options.text}`;
      }
      if (options?.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          (el as any).setAttr?.(key, value as any);
        });
      }
      if (options?.type) {
        (el as HTMLInputElement).type = `${options.type}`;
      }
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.createDiv) {
    proto.createDiv = function (options?: any) {
      return this.createEl("div", options);
    };
  }
  if (!proto.createSpan) {
    proto.createSpan = function (options?: any) {
      return this.createEl("span", options);
    };
  }
  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
      return this;
    };
  }
};

ensureDomHelpers();

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(),
    setIcon: jest.fn(),
  };
});

jest.mock("../../../core/ui/modals/standard/StandardModal", () => ({
  StandardModal: class MockStandardModal {
    app: any;
    modalEl: HTMLElement;
    headerEl: HTMLElement;
    contentEl: HTMLElement;
    footerEl: HTMLElement;

    constructor(app: any) {
      this.app = app;
      this.modalEl = document.createElement("div");
      this.headerEl = document.createElement("div");
      this.contentEl = document.createElement("div");
      this.footerEl = document.createElement("div");
    }

    setSize() {}

    addTitle(title: string, description?: string) {
      this.headerEl.empty();
      this.headerEl.createEl("h2", { text: title });
      if (description) {
        this.headerEl.createDiv({ text: description });
      }
    }

    onOpen() {
      this.modalEl.empty();
      this.headerEl = this.modalEl.createDiv();
      this.contentEl = this.modalEl.createDiv();
      this.footerEl = this.modalEl.createDiv();
    }

    onClose() {
      this.modalEl.empty();
    }

    registerDomEvent(element: HTMLElement, type: string, listener: EventListener) {
      element.addEventListener(type, listener);
    }

    open() {
      this.onOpen();
    }

    close() {
      this.onClose();
    }
  },
}));

import { App } from "obsidian";
import { ChatModelPickerModal } from "../ChatModelPickerModal";
import type { ChatModelPickerOption } from "../modelSelection";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const buildOption = (
  overrides: Partial<ChatModelPickerOption> & Pick<ChatModelPickerOption, "value" | "label">
): ChatModelPickerOption => ({
  value: overrides.value,
  label: overrides.label,
  description: overrides.description,
  badge: overrides.badge,
  keywords: overrides.keywords || [],
  providerAuthenticated: overrides.providerAuthenticated ?? true,
  providerId: overrides.providerId || "openai",
  providerLabel: overrides.providerLabel || "OpenAI",
  contextLabel: overrides.contextLabel,
  section: overrides.section || "pi",
  icon: overrides.icon || "cloud",
  setupSurface: overrides.setupSurface || {
    targetTab: "providers",
    title: "Finish Pi setup",
    primaryButton: "Open Providers",
  },
});

describe("ChatModelPickerModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders sectioned and sorted model groups", async () => {
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "anthropic@@claude-3-7-sonnet",
      loadOptions: async () => [
        buildOption({
          value: "local-ollama@@qwen2.5-coder",
          label: "Qwen 2.5 Coder",
          providerLabel: "Ollama",
          providerId: "ollama",
          section: "local",
          icon: "hard-drive",
        }),
        buildOption({
          value: "openai@@gpt-4.1",
          label: "GPT-4.1",
          providerAuthenticated: false,
          providerLabel: "OpenAI",
          providerId: "openai",
          section: "pi",
        }),
        buildOption({
          value: "systemsculpt@@systemsculpt/ai-agent",
          label: "SystemSculpt Agent",
          providerLabel: "SystemSculpt",
          providerId: "systemsculpt",
          section: "systemsculpt",
          icon: "sparkles",
          setupSurface: {
            targetTab: "account",
            title: "Finish setup",
            primaryButton: "Open Account",
          },
        }),
        buildOption({
          value: "anthropic@@claude-3-7-sonnet",
          label: "Claude 3.7 Sonnet",
          providerAuthenticated: true,
          providerLabel: "Anthropic",
          providerId: "anthropic",
          section: "pi",
        }),
      ],
      onSelect: jest.fn(),
      onOpenSetup: jest.fn(),
    });

    modal.onOpen();
    await flush();

    const sectionLabels = Array.from(
      modal.contentEl.querySelectorAll(".systemsculpt-chat-model-modal-section")
    ).map((el) => el.textContent?.trim());
    const optionLabels = Array.from(
      modal.contentEl.querySelectorAll(".systemsculpt-chat-model-modal-option-title")
    ).map((el) => el.textContent?.trim());

    expect(sectionLabels).toEqual(["SystemSculpt", "Pi Providers", "Local Models"]);
    expect(optionLabels).toEqual([
      "SystemSculpt Agent",
      "Claude 3.7 Sonnet",
      "GPT-4.1",
      "Qwen 2.5 Coder",
    ]);
    expect(
      modal.contentEl.querySelector(".systemsculpt-chat-model-modal-summary-value")?.textContent
    ).toContain("Claude 3.7 Sonnet");
  });

  it("selects a ready model when clicked", async () => {
    const onSelect = jest.fn().mockResolvedValue(undefined);
    const onOpenSetup = jest.fn();
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "systemsculpt@@systemsculpt/ai-agent",
      loadOptions: async () => [
        buildOption({
          value: "systemsculpt@@systemsculpt/ai-agent",
          label: "SystemSculpt Agent",
          providerLabel: "SystemSculpt",
          providerId: "systemsculpt",
          section: "systemsculpt",
          icon: "sparkles",
          setupSurface: {
            targetTab: "account",
            title: "Finish setup",
            primaryButton: "Open Account",
          },
        }),
        buildOption({
          value: "openai@@gpt-4.1",
          label: "GPT-4.1",
          providerLabel: "OpenAI",
          providerId: "openai",
          section: "pi",
        }),
      ],
      onSelect,
      onOpenSetup,
    });

    modal.onOpen();
    await flush();

    (
      modal.contentEl.querySelector('[data-model-value="openai@@gpt-4.1"]') as HTMLElement
    ).click();
    await flush();

    expect(onSelect).toHaveBeenCalledWith("openai@@gpt-4.1");
    expect(onOpenSetup).not.toHaveBeenCalled();
  });

  it("routes blocked models to setup instead of selecting them", async () => {
    const onSelect = jest.fn();
    const onOpenSetup = jest.fn();
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "systemsculpt@@systemsculpt/ai-agent",
      loadOptions: async () => [
        buildOption({
          value: "systemsculpt@@systemsculpt/ai-agent",
          label: "SystemSculpt Agent",
          providerLabel: "SystemSculpt",
          providerId: "systemsculpt",
          section: "systemsculpt",
          icon: "sparkles",
          setupSurface: {
            targetTab: "account",
            title: "Finish setup",
            primaryButton: "Open Account",
          },
        }),
        buildOption({
          value: "openai@@gpt-4.1",
          label: "GPT-4.1",
          providerAuthenticated: false,
          providerLabel: "OpenAI",
          providerId: "openai",
          section: "pi",
          setupSurface: {
            targetTab: "providers",
            title: "Finish Pi setup",
            primaryButton: "Open Providers",
          },
        }),
      ],
      onSelect,
      onOpenSetup,
    });

    modal.onOpen();
    await flush();

    (
      modal.contentEl.querySelector('[data-model-value="openai@@gpt-4.1"]') as HTMLElement
    ).click();
    await flush();

    expect(onOpenSetup).toHaveBeenCalledWith("providers");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("supports keyboard selection for the active option", async () => {
    const onSelect = jest.fn().mockResolvedValue(undefined);
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "missing-model",
      loadOptions: async () => [
        buildOption({
          value: "anthropic@@claude-3-7-sonnet",
          label: "Claude 3.7 Sonnet",
          providerLabel: "Anthropic",
          providerId: "anthropic",
          section: "pi",
        }),
        buildOption({
          value: "local-ollama@@qwen2.5-coder",
          label: "Qwen 2.5 Coder",
          providerLabel: "Ollama",
          providerId: "ollama",
          section: "local",
          icon: "hard-drive",
        }),
      ],
      onSelect,
      onOpenSetup: jest.fn(),
    });

    modal.onOpen();
    await flush();

    modal.modalEl.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    modal.modalEl.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(onSelect).toHaveBeenCalledWith("local-ollama@@qwen2.5-coder");
  });

  it("activates the first filtered match when searching", async () => {
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "missing-model",
      loadOptions: async () => [
        buildOption({
          value: "anthropic@@claude-3-7-sonnet",
          label: "Claude 3.7 Sonnet",
          providerLabel: "Anthropic",
          providerId: "anthropic",
          section: "pi",
        }),
        buildOption({
          value: "openai@@gpt-4.1",
          label: "GPT-4.1",
          providerLabel: "OpenAI",
          providerId: "openai",
          section: "pi",
        }),
      ],
      onSelect: jest.fn(),
      onOpenSetup: jest.fn(),
    });

    modal.onOpen();
    await flush();

    const searchInput = modal.contentEl.querySelector(
      ".systemsculpt-chat-model-modal-search-input"
    ) as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    searchInput!.value = "gpt";
    searchInput!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await flush();

    const activeOption = modal.contentEl.querySelector(
      ".systemsculpt-chat-model-modal-option.is-active"
    ) as HTMLElement | null;
    expect(activeOption?.dataset.modelValue).toBe("openai@@gpt-4.1");
  });

  it("shows an empty state with a retry action when the model list loads without options", async () => {
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "missing-model",
      loadOptions: async () => [],
      onSelect: jest.fn(),
      onOpenSetup: jest.fn(),
    });

    modal.onOpen();
    await flush();

    expect(
      modal.contentEl.querySelector(".systemsculpt-chat-model-modal-empty-text")?.textContent
    ).toContain("No chat models are available right now.");
    expect(
      (modal.contentEl.querySelector(".systemsculpt-chat-model-modal-list") as HTMLElement | null)?.style.display
    ).toBe("none");
    // An empty dropdown must never be a dead end — it must offer a retry (#206).
    expect(
      modal.contentEl.querySelector(".systemsculpt-chat-model-modal-empty-retry")
    ).not.toBeNull();
  });

  it("shows the failure reason and a working Retry action when loading fails (#206)", async () => {
    const loadOptions = jest
      .fn()
      .mockRejectedValueOnce(new Error("OpenRouter endpoint unreachable"))
      .mockResolvedValueOnce([buildOption({ value: "openai@@gpt-4.1", label: "GPT-4.1" })]);

    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "openai@@gpt-4.1",
      loadOptions,
      onSelect: jest.fn(),
      onOpenSetup: jest.fn(),
    });

    modal.onOpen();
    await flush();

    // The reason is visible, not a generic "unavailable".
    expect(
      modal.contentEl.querySelector(".systemsculpt-chat-model-modal-empty-text")?.textContent
    ).toContain("OpenRouter endpoint unreachable");

    const retryButton = modal.contentEl.querySelector(
      ".systemsculpt-chat-model-modal-empty-retry"
    ) as HTMLButtonElement | null;
    expect(retryButton).not.toBeNull();

    retryButton!.dispatchEvent(new window.Event("click", { bubbles: true }));
    await flush();

    expect(loadOptions).toHaveBeenCalledTimes(2);
    const optionTitles = Array.from(
      modal.contentEl.querySelectorAll(".systemsculpt-chat-model-modal-option-title")
    ).map((el) => el.textContent?.trim());
    expect(optionTitles).toContain("GPT-4.1");
  });

  it("surfaces favorites: a favorites-only toggle plus per-row stars that reflect state", async () => {
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "anthropic@@claude-3-7-sonnet",
      loadOptions: async () => [
        buildOption({
          value: "anthropic@@claude-3-7-sonnet",
          label: "Claude 3.7 Sonnet",
          providerLabel: "Anthropic",
          providerId: "anthropic",
          section: "pi",
        }),
        buildOption({
          value: "openai@@gpt-4.1",
          label: "GPT-4.1",
          providerLabel: "OpenAI",
          providerId: "openai",
          section: "pi",
        }),
      ],
      onSelect: jest.fn(),
      onOpenSetup: jest.fn(),
      favorites: {
        state: {
          favoriteIds: new Set(["openai@@gpt-4.1"]),
          showFavoritesOnly: false,
          favoritesFirst: true,
        },
        onToggleFavorite: jest.fn().mockResolvedValue(undefined),
        onToggleFavoritesOnly: jest.fn().mockResolvedValue(true),
      },
    });

    modal.onOpen();
    await flush();

    expect(
      modal.contentEl.querySelector(".systemsculpt-chat-model-modal-favorites-toggle"),
    ).not.toBeNull();

    const gptStar = modal.contentEl.querySelector(
      '[data-model-value="openai@@gpt-4.1"] .systemsculpt-chat-model-modal-option-favorite',
    );
    const claudeStar = modal.contentEl.querySelector(
      '[data-model-value="anthropic@@claude-3-7-sonnet"] .systemsculpt-chat-model-modal-option-favorite',
    );
    expect(gptStar).not.toBeNull();
    expect(gptStar?.classList.contains("is-favorite")).toBe(true);
    expect(claudeStar?.classList.contains("is-favorite")).toBe(false);
  });

  it("toggles a model's favorite when its star is clicked, without selecting the model", async () => {
    const onSelect = jest.fn();
    const onToggleFavorite = jest.fn().mockResolvedValue(undefined);
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "anthropic@@claude-3-7-sonnet",
      loadOptions: async () => [
        buildOption({
          value: "anthropic@@claude-3-7-sonnet",
          label: "Claude 3.7 Sonnet",
          providerLabel: "Anthropic",
          providerId: "anthropic",
          section: "pi",
        }),
      ],
      onSelect,
      onOpenSetup: jest.fn(),
      favorites: {
        state: {
          favoriteIds: new Set<string>(),
          showFavoritesOnly: false,
          favoritesFirst: true,
        },
        onToggleFavorite,
        onToggleFavoritesOnly: jest.fn().mockResolvedValue(false),
      },
    });

    modal.onOpen();
    await flush();

    const star = modal.contentEl.querySelector(
      '[data-model-value="anthropic@@claude-3-7-sonnet"] .systemsculpt-chat-model-modal-option-favorite',
    ) as HTMLElement;
    star.click();
    await flush();

    expect(onToggleFavorite).toHaveBeenCalledWith("anthropic@@claude-3-7-sonnet");
    // Optimistic: the star now reflects the favorited state…
    expect(
      modal.contentEl
        .querySelector(
          '[data-model-value="anthropic@@claude-3-7-sonnet"] .systemsculpt-chat-model-modal-option-favorite',
        )
        ?.classList.contains("is-favorite"),
    ).toBe(true);
    // …and starring must never double as selecting the model.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("filters to favorites (keeping the toggle) when the favorites-only control is activated", async () => {
    const onToggleFavoritesOnly = jest.fn().mockResolvedValue(true);
    const modal = new ChatModelPickerModal(new App(), {
      currentValue: "openai@@gpt-4.1",
      loadOptions: async () => [
        buildOption({
          value: "openai@@gpt-4.1",
          label: "GPT-4.1",
          providerLabel: "OpenAI",
          providerId: "openai",
          section: "pi",
        }),
        buildOption({
          value: "anthropic@@claude-3-7-sonnet",
          label: "Claude 3.7 Sonnet",
          providerLabel: "Anthropic",
          providerId: "anthropic",
          section: "pi",
        }),
      ],
      onSelect: jest.fn(),
      onOpenSetup: jest.fn(),
      favorites: {
        state: {
          favoriteIds: new Set(["openai@@gpt-4.1"]),
          showFavoritesOnly: false,
          favoritesFirst: true,
        },
        onToggleFavorite: jest.fn().mockResolvedValue(undefined),
        onToggleFavoritesOnly,
      },
    });

    modal.onOpen();
    await flush();

    expect(
      modal.contentEl.querySelectorAll(".systemsculpt-chat-model-modal-option").length,
    ).toBe(2);

    (
      modal.contentEl.querySelector(
        ".systemsculpt-chat-model-modal-favorites-toggle",
      ) as HTMLElement
    ).click();
    await flush();

    expect(onToggleFavoritesOnly).toHaveBeenCalled();
    const remaining = Array.from(
      modal.contentEl.querySelectorAll(".systemsculpt-chat-model-modal-option"),
    ).map((el) => (el as HTMLElement).dataset.modelValue);
    expect(remaining).toEqual(["openai@@gpt-4.1"]);
  });
});
