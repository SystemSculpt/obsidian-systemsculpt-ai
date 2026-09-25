import {
  MAX_VAULT_FILE_NAME_BYTES,
  isSafeVaultFileName,
  toSafeVaultFileName,
} from "../vaultFileName";

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

describe("toSafeVaultFileName", () => {
  it("keeps names that already work on every device", () => {
    for (const name of [
      "Meeting notes.md",
      "2026-09-25 14-03-00.webm",
      "Plan v1.2",
      "聊天标题",
      "Café (draft) — final.md",
      "archive.tar.gz",
    ]) {
      expect(toSafeVaultFileName(name)).toBe(name);
      expect(isSafeVaultFileName(name)).toBe(true);
    }
  });

  it("replaces characters Windows, iOS, Android and Obsidian Sync reject", () => {
    expect(toSafeVaultFileName("Title (23:11).md")).toBe("Title (23 11).md");
    expect(toSafeVaultFileName("Meeting: notes.md")).toBe("Meeting notes.md");
    expect(toSafeVaultFileName('a<b>c"d|e?f*g\\h/i.md')).toBe("a b c d e f g h i.md");
    expect(toSafeVaultFileName("Title (23:11).md", { replacement: "-" })).toBe("Title (23-11).md");
    expect(toSafeVaultFileName("test:file", { replacement: "" })).toBe("testfile");
  });

  it("replaces characters that break Obsidian links", () => {
    expect(toSafeVaultFileName("Issue #42 [draft] ^ref.md")).toBe("Issue 42 draft ref.md");
  });

  it("turns line breaks into spaces and removes other control characters", () => {
    expect(toSafeVaultFileName("First\nSecond\tThird.md")).toBe("First Second Third.md");
    expect(toSafeVaultFileName("bell\u0007name\u0085.md")).toBe("bell name.md");
  });

  it("removes leading and trailing dots and spaces", () => {
    expect(toSafeVaultFileName("  .hidden note. ")).toBe("hidden note");
    expect(toSafeVaultFileName("Draft...")).toBe("Draft");
    expect(toSafeVaultFileName("Report. ")).toBe("Report");
    expect(toSafeVaultFileName("..")).toBe("Untitled");
  });

  it("avoids reserved Windows device names, with or without an extension", () => {
    expect(toSafeVaultFileName("CON")).toBe("CON_");
    expect(toSafeVaultFileName("con.md")).toBe("con_.md");
    expect(toSafeVaultFileName("Lpt1.txt.md")).toBe("Lpt1_.txt.md");
    expect(toSafeVaultFileName("Console.md")).toBe("Console.md");
  });

  it("uses the fallback when nothing safe remains and keeps the extension", () => {
    expect(toSafeVaultFileName("???.md")).toBe("Untitled.md");
    expect(toSafeVaultFileName("::", { fallback: "Audio note" })).toBe("Audio note");
    expect(toSafeVaultFileName("::", { fallback: "" })).toBe("");
  });

  it("bounds the UTF-8 length without splitting characters or dropping the extension", () => {
    const long = `${"é".repeat(300)}.md`;
    const safe = toSafeVaultFileName(long);
    expect(utf8Length(safe)).toBeLessThanOrEqual(MAX_VAULT_FILE_NAME_BYTES);
    expect(safe.endsWith(".md")).toBe(true);
    expect(safe).toMatch(/^é+\.md$/);

    const bounded = toSafeVaultFileName(`${"a".repeat(150)}`, { maxBytes: 120 });
    expect(bounded).toBe("a".repeat(120));
  });

  it("is idempotent", () => {
    for (const name of [
      "Title (23:11).md",
      " .CON.md",
      "a: [b] #c ^d.md",
      `${"x".repeat(400)}:.md`,
      "\u0000\u0001",
    ]) {
      const once = toSafeVaultFileName(name);
      expect(toSafeVaultFileName(once)).toBe(once);
      expect(isSafeVaultFileName(once)).toBe(true);
    }
  });

  it("reports unsafe names", () => {
    expect(isSafeVaultFileName("Title (23:11).md")).toBe(false);
    expect(isSafeVaultFileName("nul")).toBe(false);
    expect(isSafeVaultFileName(".obsidian")).toBe(false);
    expect(isSafeVaultFileName("")).toBe(false);
  });
});
