/**
 * @jest-environment node
 */
import { deterministicId } from "../id";

describe("deterministicId", () => {
  it("returns consistent ID for same input and prefix", () => {
    const id1 = deterministicId("test-input", "msg");
    const id2 = deterministicId("test-input", "msg");
    expect(id1).toBe(id2);
  });

  it("returns ID with correct prefix", () => {
    const id = deterministicId("test-input", "msg");
    expect(id).toMatch(/^msg_/);
  });

  it("returns different IDs for different inputs", () => {
    const id1 = deterministicId("input1", "msg");
    const id2 = deterministicId("input2", "msg");
    expect(id1).not.toBe(id2);
  });

  it("returns different IDs for different prefixes", () => {
    const id1 = deterministicId("same-input", "msg");
    const id2 = deterministicId("same-input", "call");
    expect(id1).not.toBe(id2);
  });

  it("returns ID with hex suffix", () => {
    const id = deterministicId("test", "prefix");
    const suffix = id.replace(/^prefix_/, "");
    expect(suffix).toMatch(/^[0-9a-f]+$/);
    expect(suffix.length).toBeGreaterThanOrEqual(16);
  });

  it("handles empty input", () => {
    const id = deterministicId("", "msg");
    expect(id).toMatch(/^msg_[0-9a-f]+$/);
  });

  it("handles empty prefix", () => {
    const id = deterministicId("test", "");
    expect(id).toMatch(/^_[0-9a-f]+$/);
  });

  it("handles unicode input", () => {
    const id = deterministicId("こんにちは世界", "msg");
    expect(id).toMatch(/^msg_[0-9a-f]+$/);
  });

  it("handles long input", () => {
    const longInput = "a".repeat(10000);
    const id = deterministicId(longInput, "msg");
    expect(id).toMatch(/^msg_[0-9a-f]+$/);
  });

  it("handles special characters in input", () => {
    const id = deterministicId("!@#$%^&*()_+-=[]{}|;':\",./<>?", "msg");
    expect(id).toMatch(/^msg_[0-9a-f]+$/);
  });

  it("handles newlines and whitespace in input", () => {
    const id = deterministicId("hello\nworld\t!", "msg");
    expect(id).toMatch(/^msg_[0-9a-f]+$/);
  });

  it("produces distinct IDs for similar inputs", () => {
    const ids = new Set([
      deterministicId("test", "msg"),
      deterministicId("test1", "msg"),
      deterministicId("1test", "msg"),
      deterministicId("TEST", "msg"),
    ]);
    expect(ids.size).toBe(4);
  });

  it("handles prefix with special characters", () => {
    const id = deterministicId("test", "my-prefix");
    expect(id.startsWith("my-prefix_")).toBe(true);
  });

  it("handles prefix with numbers", () => {
    const id = deterministicId("test", "msg123");
    expect(id.startsWith("msg123_")).toBe(true);
  });
});
