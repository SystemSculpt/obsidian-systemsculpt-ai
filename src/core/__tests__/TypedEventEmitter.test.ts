/**
 * @jest-environment node
 */
import { TypedEventEmitter } from "../TypedEventEmitter";

// Define test event map
interface TestEvents {
  userLogin: { userId: string; timestamp: number };
  dataUpdate: { key: string; value: any };
  simpleEvent: string;
  noPayload: void;
}

describe("TypedEventEmitter", () => {
  let emitter: TypedEventEmitter<TestEvents>;

  beforeEach(() => {
    emitter = new TypedEventEmitter<TestEvents>();
  });

  describe("on", () => {
    it("registers an event listener", () => {
      const listener = jest.fn();
      emitter.on("simpleEvent", listener);
      emitter.emit("simpleEvent", "test-data");
      expect(listener).toHaveBeenCalledWith("test-data");
    });

    it("allows multiple listeners for the same event", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      emitter.on("simpleEvent", listener1);
      emitter.on("simpleEvent", listener2);
      emitter.emit("simpleEvent", "data");
      expect(listener1).toHaveBeenCalledWith("data");
      expect(listener2).toHaveBeenCalledWith("data");
    });

    it("returns an unsubscribe function", () => {
      const listener = jest.fn();
      const unsubscribe = emitter.on("simpleEvent", listener);

      emitter.emit("simpleEvent", "first");
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit("simpleEvent", "second");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("handles complex typed payloads", () => {
      const listener = jest.fn();
      emitter.on("userLogin", listener);

      const payload = { userId: "user-123", timestamp: Date.now() };
      emitter.emit("userLogin", payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });
  });

  describe("once", () => {
    it("registers a one-time listener", () => {
      const listener = jest.fn();
      emitter.once("simpleEvent", listener);

      emitter.emit("simpleEvent", "first");
      emitter.emit("simpleEvent", "second");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("first");
    });

    it("returns an unsubscribe function", () => {
      const listener = jest.fn();
      const unsubscribe = emitter.once("simpleEvent", listener);

      unsubscribe();
      emitter.emit("simpleEvent", "data");

      expect(listener).not.toHaveBeenCalled();
    });

    it("works with complex payloads", () => {
      const listener = jest.fn();
      emitter.once("dataUpdate", listener);

      const payload = { key: "test", value: { nested: true } };
      emitter.emit("dataUpdate", payload);
      emitter.emit("dataUpdate", { key: "second", value: null });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);
    });
  });

  describe("emit", () => {
    it("calls all listeners for an event", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      const listener3 = jest.fn();

      emitter.on("simpleEvent", listener1);
      emitter.on("simpleEvent", listener2);
      emitter.on("simpleEvent", listener3);

      emitter.emit("simpleEvent", "test");

      expect(listener1).toHaveBeenCalledWith("test");
      expect(listener2).toHaveBeenCalledWith("test");
      expect(listener3).toHaveBeenCalledWith("test");
    });

    it("does nothing when no listeners exist", () => {
      expect(() => emitter.emit("simpleEvent", "data")).not.toThrow();
    });

    it("passes typed payloads correctly", () => {
      const listener = jest.fn();
      emitter.on("userLogin", listener);

      const payload = { userId: "abc", timestamp: 1234567890 };
      emitter.emit("userLogin", payload);

      expect(listener).toHaveBeenCalledWith(payload);
      expect(listener.mock.calls[0][0].userId).toBe("abc");
      expect(listener.mock.calls[0][0].timestamp).toBe(1234567890);
    });
  });

  describe("off", () => {
    it("removes all listeners for an event", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      emitter.on("simpleEvent", listener1);
      emitter.on("simpleEvent", listener2);

      emitter.off("simpleEvent");
      emitter.emit("simpleEvent", "data");

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it("does nothing when event has no listeners", () => {
      expect(() => emitter.off("simpleEvent")).not.toThrow();
    });

    it("only removes the specified event", () => {
      const simpleListener = jest.fn();
      const userListener = jest.fn();

      emitter.on("simpleEvent", simpleListener);
      emitter.on("userLogin", userListener);

      emitter.off("simpleEvent");

      emitter.emit("simpleEvent", "data");
      emitter.emit("userLogin", { userId: "test", timestamp: 0 });

      expect(simpleListener).not.toHaveBeenCalled();
      expect(userListener).toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("removes all event listeners", () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      const listener3 = jest.fn();

      emitter.on("simpleEvent", listener1);
      emitter.on("userLogin", listener2);
      emitter.on("dataUpdate", listener3);

      emitter.clear();

      emitter.emit("simpleEvent", "data");
      emitter.emit("userLogin", { userId: "test", timestamp: 0 });
      emitter.emit("dataUpdate", { key: "k", value: "v" });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(listener3).not.toHaveBeenCalled();
    });
  });

  describe("listenerCount", () => {
    it("returns 0 when no listeners exist", () => {
      expect(emitter.listenerCount("simpleEvent")).toBe(0);
    });

    it("returns correct count after adding listeners", () => {
      emitter.on("simpleEvent", jest.fn());
      emitter.on("simpleEvent", jest.fn());
      emitter.on("simpleEvent", jest.fn());

      expect(emitter.listenerCount("simpleEvent")).toBe(3);
    });

    it("returns correct count after removing listeners", () => {
      const unsub1 = emitter.on("simpleEvent", jest.fn());
      emitter.on("simpleEvent", jest.fn());

      expect(emitter.listenerCount("simpleEvent")).toBe(2);

      unsub1();
      expect(emitter.listenerCount("simpleEvent")).toBe(1);
    });

    it("returns 0 after off is called", () => {
      emitter.on("simpleEvent", jest.fn());
      emitter.on("simpleEvent", jest.fn());

      emitter.off("simpleEvent");

      expect(emitter.listenerCount("simpleEvent")).toBe(0);
    });

    it("returns 0 after clear is called", () => {
      emitter.on("simpleEvent", jest.fn());
      emitter.on("userLogin", jest.fn());

      emitter.clear();

      expect(emitter.listenerCount("simpleEvent")).toBe(0);
      expect(emitter.listenerCount("userLogin")).toBe(0);
    });
  });

  describe("eventNames", () => {
    it("returns empty array when no listeners exist", () => {
      expect(emitter.eventNames()).toEqual([]);
    });

    it("returns all event names with listeners", () => {
      emitter.on("simpleEvent", jest.fn());
      emitter.on("userLogin", jest.fn());
      emitter.on("dataUpdate", jest.fn());

      const names = emitter.eventNames();

      expect(names).toContain("simpleEvent");
      expect(names).toContain("userLogin");
      expect(names).toContain("dataUpdate");
      expect(names.length).toBe(3);
    });

    it("does not include events after off", () => {
      emitter.on("simpleEvent", jest.fn());
      emitter.on("userLogin", jest.fn());

      emitter.off("simpleEvent");

      const names = emitter.eventNames();
      expect(names).not.toContain("simpleEvent");
      expect(names).toContain("userLogin");
    });

    it("returns empty array after clear", () => {
      emitter.on("simpleEvent", jest.fn());
      emitter.on("userLogin", jest.fn());

      emitter.clear();

      expect(emitter.eventNames()).toEqual([]);
    });
  });

  describe("type safety", () => {
    it("correctly handles void payload events", () => {
      const listener = jest.fn();
      emitter.on("noPayload", listener);

      // TypeScript would enforce that we pass void (undefined)
      emitter.emit("noPayload", undefined as void);

      expect(listener).toHaveBeenCalled();
    });

    it("handles any value type in dataUpdate", () => {
      const listener = jest.fn();
      emitter.on("dataUpdate", listener);

      const payloads = [
        { key: "string", value: "test" },
        { key: "number", value: 42 },
        { key: "object", value: { nested: true } },
        { key: "array", value: [1, 2, 3] },
        { key: "null", value: null },
      ];

      payloads.forEach((payload) => emitter.emit("dataUpdate", payload));

      expect(listener).toHaveBeenCalledTimes(payloads.length);
    });
  });
});
