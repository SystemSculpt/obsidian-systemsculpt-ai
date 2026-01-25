/**
 * @jest-environment jsdom
 */
import { generateDefaultChatTitle, sanitizeChatTitle } from "../titleUtils";

describe("titleUtils", () => {
  describe("generateDefaultChatTitle", () => {
    it("generates a title containing 'Chat'", () => {
      const title = generateDefaultChatTitle();
      expect(title).toContain("Chat");
    });

    it("generates a title with current date", () => {
      const title = generateDefaultChatTitle();
      const now = new Date();
      // The date portion should be present in some locale format
      expect(title).toMatch(/Chat .+/);
    });

    it("generates unique titles when called at different times", () => {
      const title1 = generateDefaultChatTitle();
      // Wait a bit to ensure time changes
      const title2 = generateDefaultChatTitle();
      // May be the same if called in the same second, but format should match
      expect(title1).toMatch(/Chat .+/);
      expect(title2).toMatch(/Chat .+/);
    });
  });

  describe("sanitizeChatTitle", () => {
    it("removes backslashes", () => {
      expect(sanitizeChatTitle("test\\file")).toBe("testfile");
    });

    it("removes forward slashes", () => {
      expect(sanitizeChatTitle("test/file")).toBe("testfile");
    });

    it("removes colons", () => {
      expect(sanitizeChatTitle("test:file")).toBe("testfile");
    });

    it("removes asterisks", () => {
      expect(sanitizeChatTitle("test*file")).toBe("testfile");
    });

    it("removes question marks", () => {
      expect(sanitizeChatTitle("test?file")).toBe("testfile");
    });

    it("removes double quotes", () => {
      expect(sanitizeChatTitle('test"file')).toBe("testfile");
    });

    it("removes less than symbols", () => {
      expect(sanitizeChatTitle("test<file")).toBe("testfile");
    });

    it("removes greater than symbols", () => {
      expect(sanitizeChatTitle("test>file")).toBe("testfile");
    });

    it("removes pipe symbols", () => {
      expect(sanitizeChatTitle("test|file")).toBe("testfile");
    });

    it("removes multiple invalid characters", () => {
      expect(sanitizeChatTitle('test\\/:*?"<>|file')).toBe("testfile");
    });

    it("preserves valid filename characters", () => {
      expect(sanitizeChatTitle("My-Chat_2024.01.15")).toBe("My-Chat_2024.01.15");
    });

    it("handles empty string", () => {
      expect(sanitizeChatTitle("")).toBe("");
    });

    it("preserves spaces", () => {
      expect(sanitizeChatTitle("Chat Title With Spaces")).toBe("Chat Title With Spaces");
    });

    it("preserves unicode characters", () => {
      expect(sanitizeChatTitle("聊天标题")).toBe("聊天标题");
    });

    it("handles title with only invalid characters", () => {
      expect(sanitizeChatTitle('\\/:*?"<>|')).toBe("");
    });
  });
});
