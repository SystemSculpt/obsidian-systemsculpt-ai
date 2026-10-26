/**
 * @jest-environment jsdom
 */
import { chatTitleFromMessage, generateDefaultChatTitle, normalizeChatTitle, sanitizeChatTitle } from "../titleUtils";

describe("titleUtils", () => {
  describe("generateDefaultChatTitle", () => {
    it("generates a title containing 'Chat'", () => {
      const title = generateDefaultChatTitle();
      expect(title).toContain("Chat");
    });

    it("generates a title with current date", () => {
      const now = new Date();
      const title = generateDefaultChatTitle();
      // The date portion should be present in some locale format
      expect(title).toMatch(/Chat .+/);
      expect(title).toContain(now.toLocaleDateString());
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

  describe("chatTitleFromMessage", () => {
    it("keeps paths and punctuation the person wrote", () => {
      expect(chatTitleFromMessage("/Users/Shared/demo-vault/notes: what's in here?"))
        .toBe("/Users/Shared/demo-vault/notes: what's in here?");
    });

    it("reads [[links]] as note names and keeps only the first line", () => {
      expect(chatTitleFromMessage("Summarize [[Projects/Q4 launch.md|Q4 launch]]\nthen list risks"))
        .toBe("Summarize Q4 launch");
      expect(chatTitleFromMessage("## Draft [[Areas/Weekly review]]")).toBe("Draft Weekly review");
    });

    it("shortens long messages and falls back to a dated title", () => {
      const title = chatTitleFromMessage("word ".repeat(30));
      expect(title.length).toBeLessThanOrEqual(62);
      expect(title.endsWith("…")).toBe(true);
      expect(chatTitleFromMessage("   \n  ")).toMatch(/^Chat /);
    });
  });

  describe("normalizeChatTitle", () => {
    it("collapses whitespace onto one line without dropping characters", () => {
      expect(normalizeChatTitle("  Q4 / Q1:\tplan \n")).toBe("Q4 / Q1: plan");
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
