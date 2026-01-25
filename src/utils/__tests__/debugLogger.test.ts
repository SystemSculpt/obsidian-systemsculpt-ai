/**
 * @jest-environment node
 */
import { App } from "obsidian";

// Mock obsidian
jest.mock("obsidian", () => ({
  App: jest.fn(),
}));

import { DebugLogger, debugLog } from "../debugLogger";

describe("debugLogger", () => {
  describe("DebugLogger", () => {
    describe("getInstance", () => {
      it("returns singleton instance", () => {
        const instance1 = DebugLogger.getInstance();
        const instance2 = DebugLogger.getInstance();

        expect(instance1).toBe(instance2);
      });

      it("returns DebugLogger instance", () => {
        const instance = DebugLogger.getInstance();

        expect(instance).toBeInstanceOf(DebugLogger);
      });
    });

    describe("initialize", () => {
      it("can be called with App", () => {
        const mockApp = {} as App;

        expect(() => DebugLogger.initialize(mockApp)).not.toThrow();
      });
    });

    describe("logging methods", () => {
      let instance: DebugLogger;

      beforeEach(() => {
        instance = DebugLogger.getInstance();
      });

      it("log does not throw", () => {
        expect(() => instance.log("test message")).not.toThrow();
      });

      it("logToolCall does not throw", () => {
        expect(() => instance.logToolCall("tool", "action")).not.toThrow();
      });

      it("logStreamChunk does not throw", () => {
        expect(() => instance.logStreamChunk("chunk data")).not.toThrow();
      });

      it("logUserAction does not throw", () => {
        expect(() => instance.logUserAction("click", "button")).not.toThrow();
      });

      it("logAPIRequest does not throw", () => {
        expect(() => instance.logAPIRequest("GET", "/api/test")).not.toThrow();
      });

      it("logAPIResponse does not throw", () => {
        expect(() => instance.logAPIResponse(200, { data: "test" })).not.toThrow();
      });

      it("logToolApproval does not throw", () => {
        expect(() => instance.logToolApproval("tool", true)).not.toThrow();
      });

      it("logToolExecution does not throw", () => {
        expect(() => instance.logToolExecution("tool", "result")).not.toThrow();
      });

      it("logChatViewLoad does not throw", () => {
        expect(() => instance.logChatViewLoad()).not.toThrow();
      });

      it("logChatViewRender does not throw", () => {
        expect(() => instance.logChatViewRender()).not.toThrow();
      });

      it("logChatViewStructure does not throw", () => {
        expect(() => instance.logChatViewStructure({ messages: [] })).not.toThrow();
      });

      it("logChatSave does not throw", () => {
        expect(() => instance.logChatSave("path/to/file")).not.toThrow();
      });

      it("logError does not throw", () => {
        expect(() => instance.logError(new Error("test"))).not.toThrow();
      });

      it("logMobileError does not throw", () => {
        expect(() => instance.logMobileError(new Error("mobile error"))).not.toThrow();
      });

      it("logMobilePerformance does not throw", () => {
        expect(() => instance.logMobilePerformance("operation", 100)).not.toThrow();
      });

      it("logGlobalUncaughtError does not throw", () => {
        expect(() => instance.logGlobalUncaughtError(new Error("uncaught"))).not.toThrow();
      });
    });

    describe("utility methods", () => {
      let instance: DebugLogger;

      beforeEach(() => {
        instance = DebugLogger.getInstance();
      });

      it("setEnabled does not throw", () => {
        expect(() => instance.setEnabled(true)).not.toThrow();
        expect(() => instance.setEnabled(false)).not.toThrow();
      });

      it("clearLog does not throw", () => {
        expect(() => instance.clearLog()).not.toThrow();
      });

      it("exportMobileLogs returns empty string", async () => {
        const result = await instance.exportMobileLogs();

        expect(result).toBe("");
      });
    });
  });

  describe("debugLog", () => {
    it("is a function", () => {
      expect(typeof debugLog).toBe("function");
    });

    it("returns a promise", () => {
      const result = debugLog("test");

      expect(result).toBeInstanceOf(Promise);
    });

    it("resolves to undefined", async () => {
      const result = await debugLog("test message");

      expect(result).toBeUndefined();
    });

    it("handles multiple arguments", async () => {
      await expect(debugLog("arg1", "arg2", { key: "value" })).resolves.toBeUndefined();
    });
  });
});
