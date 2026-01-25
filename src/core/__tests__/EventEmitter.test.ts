/**
 * @jest-environment jsdom
 */
import { EventEmitter } from "../EventEmitter";

describe("EventEmitter", () => {
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  describe("on", () => {
    it("registers an event listener", () => {
      const listener = jest.fn();
      emitter.on("test", listener);
      emitter.emit("test", "arg1", "arg2");
      expect(listener).toHaveBeenCalledWith("arg1", "arg2");
    });

    it("allows multiple listeners for the same event", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      emitter.on("test", listener1);
      emitter.on("test", listener2);
      emitter.emit("test");
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it("returns an unsubscribe function", () => {
      const listener = jest.fn();
      const unsubscribe = emitter.on("test", listener);
      emitter.emit("test");
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit("test");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("tracks namespaced events", () => {
      const listener = jest.fn();
      emitter.on("systemsculpt:modelUpdated", listener);

      const events = emitter.getNamespaceEvents("systemsculpt");
      expect(events).toContain("systemsculpt:modelUpdated");
    });

    it("handles non-namespaced events without tracking namespace", () => {
      const listener = jest.fn();
      emitter.on("simple-event", listener);

      const events = emitter.getNamespaceEvents("simple-event");
      expect(events).toEqual([]);
    });
  });

  describe("once", () => {
    it("registers a one-time listener", () => {
      const listener = jest.fn();
      emitter.once("test", listener);

      emitter.emit("test", "first");
      emitter.emit("test", "second");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("first");
    });

    it("returns an unsubscribe function", () => {
      const listener = jest.fn();
      const unsubscribe = emitter.once("test", listener);

      unsubscribe();
      emitter.emit("test");

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("emit", () => {
    it("calls all listeners for an event", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      emitter.on("test", listener1);
      emitter.on("test", listener2);

      emitter.emit("test", "data");

      expect(listener1).toHaveBeenCalledWith("data");
      expect(listener2).toHaveBeenCalledWith("data");
    });

    it("does nothing when no listeners exist", () => {
      expect(() => emitter.emit("nonexistent", "data")).not.toThrow();
    });

    it("passes multiple arguments to listeners", () => {
      const listener = jest.fn();
      emitter.on("test", listener);

      emitter.emit("test", "arg1", 42, { key: "value" });

      expect(listener).toHaveBeenCalledWith("arg1", 42, { key: "value" });
    });
  });

  describe("off", () => {
    it("removes all listeners for an event", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      emitter.on("test", listener1);
      emitter.on("test", listener2);

      emitter.off("test");
      emitter.emit("test");

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it("does nothing when event has no listeners", () => {
      expect(() => emitter.off("nonexistent")).not.toThrow();
    });
  });

  describe("clear", () => {
    it("removes all event listeners", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      emitter.on("event1", listener1);
      emitter.on("event2", listener2);

      emitter.clear();

      emitter.emit("event1");
      emitter.emit("event2");

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it("clears namespace tracking", () => {
      emitter.on("systemsculpt:event1", jest.fn());
      emitter.on("custom:event1", jest.fn());

      emitter.clear();

      expect(emitter.getNamespaceEvents("systemsculpt")).toEqual([]);
      expect(emitter.getNamespaceEvents("custom")).toEqual([]);
    });
  });

  describe("clearNamespace", () => {
    it("removes all listeners for a specific namespace", () => {
      const ssListener1 = jest.fn();
      const ssListener2 = jest.fn();
      const customListener = jest.fn();

      emitter.on("systemsculpt:event1", ssListener1);
      emitter.on("systemsculpt:event2", ssListener2);
      emitter.on("custom:event1", customListener);

      emitter.clearNamespace("systemsculpt");

      emitter.emit("systemsculpt:event1");
      emitter.emit("systemsculpt:event2");
      emitter.emit("custom:event1");

      expect(ssListener1).not.toHaveBeenCalled();
      expect(ssListener2).not.toHaveBeenCalled();
      expect(customListener).toHaveBeenCalled();
    });

    it("does nothing for non-existent namespace", () => {
      expect(() => emitter.clearNamespace("nonexistent")).not.toThrow();
    });
  });

  describe("getNamespaceEvents", () => {
    it("returns all events in a namespace", () => {
      emitter.on("systemsculpt:event1", jest.fn());
      emitter.on("systemsculpt:event2", jest.fn());
      emitter.on("systemsculpt:event3", jest.fn());

      const events = emitter.getNamespaceEvents("systemsculpt");

      expect(events).toContain("systemsculpt:event1");
      expect(events).toContain("systemsculpt:event2");
      expect(events).toContain("systemsculpt:event3");
      expect(events.length).toBe(3);
    });

    it("returns empty array for non-existent namespace", () => {
      expect(emitter.getNamespaceEvents("nonexistent")).toEqual([]);
    });

    it("updates when events are removed via unsubscribe", () => {
      const unsub = emitter.on("systemsculpt:event1", jest.fn());
      emitter.on("systemsculpt:event2", jest.fn());

      expect(emitter.getNamespaceEvents("systemsculpt").length).toBe(2);

      unsub();

      expect(emitter.getNamespaceEvents("systemsculpt")).toContain("systemsculpt:event2");
      expect(emitter.getNamespaceEvents("systemsculpt")).not.toContain("systemsculpt:event1");
    });
  });

  describe("emitWithProvider", () => {
    it("emits both the original event and a namespaced version", () => {
      const originalListener = jest.fn();
      const namespacedListener = jest.fn();

      emitter.on("modelUpdated", originalListener);
      emitter.on("systemsculpt:modelUpdated", namespacedListener);

      emitter.emitWithProvider("modelUpdated", "systemsculpt", { model: "gpt-4" });

      expect(originalListener).toHaveBeenCalledWith({ model: "gpt-4" });
      expect(namespacedListener).toHaveBeenCalledWith({ model: "gpt-4" });
    });

    it("works with custom provider type", () => {
      const listener = jest.fn();
      emitter.on("custom:event", listener);

      emitter.emitWithProvider("event", "custom", "data");

      expect(listener).toHaveBeenCalledWith("data");
    });
  });

  describe("onProvider", () => {
    it("listens only to events from a specific provider", () => {
      const ssListener = jest.fn();
      const customListener = jest.fn();

      emitter.onProvider("modelUpdated", "systemsculpt", ssListener);
      emitter.onProvider("modelUpdated", "custom", customListener);

      emitter.emitWithProvider("modelUpdated", "systemsculpt", "ss-data");

      expect(ssListener).toHaveBeenCalledWith("ss-data");
      expect(customListener).not.toHaveBeenCalled();
    });

    it("returns an unsubscribe function", () => {
      const listener = jest.fn();
      const unsub = emitter.onProvider("event", "systemsculpt", listener);

      unsub();
      emitter.emitWithProvider("event", "systemsculpt");

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("namespace cleanup", () => {
    it("cleans up namespace tracking when all events are unsubscribed", () => {
      const unsub1 = emitter.on("test:event1", jest.fn());
      const unsub2 = emitter.on("test:event2", jest.fn());

      expect(emitter.getNamespaceEvents("test").length).toBe(2);

      unsub1();
      expect(emitter.getNamespaceEvents("test").length).toBe(1);

      unsub2();
      expect(emitter.getNamespaceEvents("test").length).toBe(0);
    });
  });
});
