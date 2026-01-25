/**
 * @jest-environment jsdom
 */

import { KeyboardNavigationService, KeyboardNavigationOptions } from "../KeyboardNavigationService";

// Mock Component from obsidian
jest.mock("obsidian", () => ({
  Component: class MockComponent {
    private domEventHandlers: Array<{ el: HTMLElement; type: string; handler: EventListener }> = [];

    registerDomEvent(el: HTMLElement, type: string, handler: EventListener) {
      el.addEventListener(type, handler);
      this.domEventHandlers.push({ el, type, handler });
    }

    unload() {
      for (const { el, type, handler } of this.domEventHandlers) {
        el.removeEventListener(type, handler);
      }
      this.domEventHandlers = [];
    }
  },
}));

describe("KeyboardNavigationService", () => {
  let container: HTMLElement;
  let service: KeyboardNavigationService;

  const createKeyboardEvent = (key: string, options: Partial<KeyboardEventInit> = {}): KeyboardEvent => {
    return new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (service) {
      service.unload();
    }
    container.remove();
  });

  describe("constructor", () => {
    it("creates instance with default options", () => {
      service = new KeyboardNavigationService(container);

      expect(service).toBeInstanceOf(KeyboardNavigationService);
      expect(service.getFocusedIndex()).toBe(-1);
    });

    it("creates instance with custom options", () => {
      const options: KeyboardNavigationOptions = {
        multiSelect: true,
        closeOnSelect: false,
        allowSpaceToggle: true,
      };

      service = new KeyboardNavigationService(container, options);

      expect(service).toBeInstanceOf(KeyboardNavigationService);
    });

    it("registers keydown event listener on container", () => {
      const addEventListenerSpy = jest.spyOn(container, "addEventListener");

      service = new KeyboardNavigationService(container);

      expect(addEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    });
  });

  describe("setItemCount", () => {
    beforeEach(() => {
      service = new KeyboardNavigationService(container);
    });

    it("sets item count", () => {
      service.setItemCount(5);

      // Verify by navigating to last item
      service.setFocusedIndex(4);
      expect(service.getFocusedIndex()).toBe(4);
    });

    it("resets focus if index exceeds new count", () => {
      service.setItemCount(10);
      service.setFocusedIndex(8);

      service.setItemCount(5);

      expect(service.getFocusedIndex()).toBe(4);
    });

    it("sets focus to -1 when count is 0", () => {
      service.setItemCount(5);
      service.setFocusedIndex(2);

      service.setItemCount(0);

      expect(service.getFocusedIndex()).toBe(-1);
    });
  });

  describe("getFocusedIndex", () => {
    beforeEach(() => {
      service = new KeyboardNavigationService(container);
    });

    it("returns -1 initially", () => {
      expect(service.getFocusedIndex()).toBe(-1);
    });

    it("returns current focused index", () => {
      service.setItemCount(5);
      service.setFocusedIndex(3);

      expect(service.getFocusedIndex()).toBe(3);
    });
  });

  describe("setFocusedIndex", () => {
    let onFocus: jest.Mock;

    beforeEach(() => {
      onFocus = jest.fn();
      service = new KeyboardNavigationService(container, { onFocus });
      service.setItemCount(5);
    });

    it("sets focused index within bounds", () => {
      service.setFocusedIndex(2);

      expect(service.getFocusedIndex()).toBe(2);
    });

    it("calls onFocus callback when index is valid", () => {
      service.setFocusedIndex(3);

      expect(onFocus).toHaveBeenCalledWith(3);
    });

    it("does not set index beyond item count", () => {
      service.setFocusedIndex(10);

      expect(service.getFocusedIndex()).toBe(-1);
    });

    it("allows setting to -1", () => {
      service.setFocusedIndex(2);
      service.setFocusedIndex(-1);

      expect(service.getFocusedIndex()).toBe(-1);
    });

    it("does not call onFocus for -1", () => {
      service.setFocusedIndex(-1);

      expect(onFocus).not.toHaveBeenCalled();
    });

    it("does not set negative indices other than -1", () => {
      service.setFocusedIndex(-5);

      expect(service.getFocusedIndex()).toBe(-1);
    });
  });

  describe("clearFocus", () => {
    beforeEach(() => {
      service = new KeyboardNavigationService(container);
      service.setItemCount(5);
    });

    it("clears the focused index", () => {
      service.setFocusedIndex(3);
      service.clearFocus();

      expect(service.getFocusedIndex()).toBe(-1);
    });
  });

  describe("keyboard navigation", () => {
    let onFocus: jest.Mock;

    beforeEach(() => {
      onFocus = jest.fn();
      service = new KeyboardNavigationService(container, { onFocus });
      service.setItemCount(5);
    });

    describe("ArrowDown", () => {
      it("moves focus down from -1 to 0", () => {
        container.dispatchEvent(createKeyboardEvent("ArrowDown"));

        expect(service.getFocusedIndex()).toBe(0);
      });

      it("moves focus down incrementally", () => {
        service.setFocusedIndex(2);
        onFocus.mockClear();

        container.dispatchEvent(createKeyboardEvent("ArrowDown"));

        expect(service.getFocusedIndex()).toBe(3);
        expect(onFocus).toHaveBeenCalledWith(3);
      });

      it("does not exceed item count", () => {
        service.setFocusedIndex(4);
        onFocus.mockClear();

        container.dispatchEvent(createKeyboardEvent("ArrowDown"));

        expect(service.getFocusedIndex()).toBe(4);
      });

      it("prevents default", () => {
        const event = createKeyboardEvent("ArrowDown");
        const preventDefaultSpy = jest.spyOn(event, "preventDefault");

        container.dispatchEvent(event);

        expect(preventDefaultSpy).toHaveBeenCalled();
      });
    });

    describe("ArrowUp", () => {
      it("moves focus up from -1 to 0", () => {
        container.dispatchEvent(createKeyboardEvent("ArrowUp"));

        expect(service.getFocusedIndex()).toBe(0);
      });

      it("moves focus up incrementally", () => {
        service.setFocusedIndex(3);
        onFocus.mockClear();

        container.dispatchEvent(createKeyboardEvent("ArrowUp"));

        expect(service.getFocusedIndex()).toBe(2);
      });

      it("does not go below 0", () => {
        service.setFocusedIndex(0);
        onFocus.mockClear();

        container.dispatchEvent(createKeyboardEvent("ArrowUp"));

        expect(service.getFocusedIndex()).toBe(0);
      });

      it("prevents default", () => {
        const event = createKeyboardEvent("ArrowUp");
        const preventDefaultSpy = jest.spyOn(event, "preventDefault");

        container.dispatchEvent(event);

        expect(preventDefaultSpy).toHaveBeenCalled();
      });
    });

    describe("when itemCount is 0", () => {
      it("does not process ArrowDown", () => {
        service.setItemCount(0);

        container.dispatchEvent(createKeyboardEvent("ArrowDown"));

        expect(service.getFocusedIndex()).toBe(-1);
      });

      it("does not process ArrowUp", () => {
        service.setItemCount(0);

        container.dispatchEvent(createKeyboardEvent("ArrowUp"));

        expect(service.getFocusedIndex()).toBe(-1);
      });
    });
  });

  describe("Enter key selection", () => {
    let onSelect: jest.Mock;
    let onToggle: jest.Mock;
    let onConfirm: jest.Mock;

    beforeEach(() => {
      onSelect = jest.fn();
      onToggle = jest.fn();
      onConfirm = jest.fn();
    });

    it("calls onSelect when Enter is pressed with focused item", () => {
      service = new KeyboardNavigationService(container, { onSelect });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      container.dispatchEvent(createKeyboardEvent("Enter"));

      expect(onSelect).toHaveBeenCalledWith(2);
    });

    it("does not call onSelect when no item is focused", () => {
      service = new KeyboardNavigationService(container, { onSelect });
      service.setItemCount(5);

      container.dispatchEvent(createKeyboardEvent("Enter"));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("calls onToggle in multiSelect mode", () => {
      service = new KeyboardNavigationService(container, { onSelect, onToggle, multiSelect: true });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      container.dispatchEvent(createKeyboardEvent("Enter"));

      expect(onSelect).toHaveBeenCalledWith(2);
      expect(onToggle).toHaveBeenCalledWith(2);
    });

    it("calls onConfirm with Cmd+Enter in multiSelect mode", () => {
      service = new KeyboardNavigationService(container, { onConfirm, multiSelect: true });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      container.dispatchEvent(createKeyboardEvent("Enter", { metaKey: true }));

      expect(onConfirm).toHaveBeenCalled();
    });

    it("calls onConfirm with Ctrl+Enter in multiSelect mode", () => {
      service = new KeyboardNavigationService(container, { onConfirm, multiSelect: true });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      container.dispatchEvent(createKeyboardEvent("Enter", { ctrlKey: true }));

      expect(onConfirm).toHaveBeenCalled();
    });

    it("does not call onConfirm in single select mode", () => {
      service = new KeyboardNavigationService(container, { onSelect, onConfirm });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      container.dispatchEvent(createKeyboardEvent("Enter", { metaKey: true }));

      expect(onSelect).toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("prevents default on Enter", () => {
      service = new KeyboardNavigationService(container, { onSelect });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      const event = createKeyboardEvent("Enter");
      const preventDefaultSpy = jest.spyOn(event, "preventDefault");

      container.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });
  });

  describe("Space key toggle", () => {
    let onToggle: jest.Mock;

    beforeEach(() => {
      onToggle = jest.fn();
    });

    it("calls onToggle when Space is pressed with allowSpaceToggle", () => {
      service = new KeyboardNavigationService(container, { onToggle, allowSpaceToggle: true });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      container.dispatchEvent(createKeyboardEvent(" ", { code: "Space" }));

      expect(onToggle).toHaveBeenCalledWith(2);
    });

    it("does not call onToggle when allowSpaceToggle is false", () => {
      service = new KeyboardNavigationService(container, { onToggle, allowSpaceToggle: false });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      container.dispatchEvent(createKeyboardEvent(" ", { code: "Space" }));

      expect(onToggle).not.toHaveBeenCalled();
    });

    it("does not call onToggle when no item is focused", () => {
      service = new KeyboardNavigationService(container, { onToggle, allowSpaceToggle: true });
      service.setItemCount(5);

      container.dispatchEvent(createKeyboardEvent(" ", { code: "Space" }));

      expect(onToggle).not.toHaveBeenCalled();
    });

    it("prevents default on Space toggle", () => {
      service = new KeyboardNavigationService(container, { onToggle, allowSpaceToggle: true });
      service.setItemCount(5);
      service.setFocusedIndex(2);

      const event = createKeyboardEvent(" ", { code: "Space" });
      const preventDefaultSpy = jest.spyOn(event, "preventDefault");

      container.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });
  });

  describe("Tab key navigation", () => {
    let onFocus: jest.Mock;

    beforeEach(() => {
      onFocus = jest.fn();
      service = new KeyboardNavigationService(container, { onFocus });
      service.setItemCount(5);
    });

    it("moves focus to next item on Tab", () => {
      service.setFocusedIndex(2);
      onFocus.mockClear();

      container.dispatchEvent(createKeyboardEvent("Tab"));

      expect(service.getFocusedIndex()).toBe(3);
    });

    it("wraps around to first item from last", () => {
      service.setFocusedIndex(4);
      onFocus.mockClear();

      container.dispatchEvent(createKeyboardEvent("Tab"));

      expect(service.getFocusedIndex()).toBe(0);
    });

    it("moves focus to previous item on Shift+Tab", () => {
      service.setFocusedIndex(2);
      onFocus.mockClear();

      container.dispatchEvent(createKeyboardEvent("Tab", { shiftKey: true }));

      expect(service.getFocusedIndex()).toBe(1);
    });

    it("wraps around to last item from first on Shift+Tab", () => {
      service.setFocusedIndex(0);
      onFocus.mockClear();

      container.dispatchEvent(createKeyboardEvent("Tab", { shiftKey: true }));

      expect(service.getFocusedIndex()).toBe(4);
    });

    it("does not prevent default for Tab", () => {
      service.setFocusedIndex(2);

      const event = createKeyboardEvent("Tab");
      const preventDefaultSpy = jest.spyOn(event, "preventDefault");

      container.dispatchEvent(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });
  });

  describe("unload", () => {
    it("removes event listeners on unload", () => {
      const removeEventListenerSpy = jest.spyOn(container, "removeEventListener");
      service = new KeyboardNavigationService(container);

      service.unload();

      expect(removeEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    });
  });
});
