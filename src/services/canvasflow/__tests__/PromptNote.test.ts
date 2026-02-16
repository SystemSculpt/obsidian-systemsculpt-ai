import {
  parseCanvasFlowPromptNote,
  parseMarkdownFrontmatter,
  replaceMarkdownBodyPreservingFrontmatter,
  replaceMarkdownFrontmatterAndBody,
} from "../PromptNote";

describe("PromptNote", () => {
  describe("parseMarkdownFrontmatter", () => {
    it("returns empty frontmatter when none present", () => {
      const res = parseMarkdownFrontmatter("hello\nworld\n");
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.frontmatter).toEqual({});
      expect(res.frontmatterText).toBeNull();
      expect(res.body).toBe("hello\nworld\n");
    });
  });

  describe("parseCanvasFlowPromptNote", () => {
    it("parses an openrouter-backed image prompt note", () => {
      const md = [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: openrouter",
        "ss_image_model: openai/gpt-5-image-mini",
        "ss_image_count: 3",
        "ss_image_aspect_ratio: 16:9",
        "ss_seed: 42",
        "---",
        "",
        "A cinematic city at dawn",
        "",
      ].join("\n");

      const res = parseCanvasFlowPromptNote(md);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.config.backend).toBe("openrouter");
      expect(res.config.imageModelId).toBe("openai/gpt-5-image-mini");
      expect(res.config.imageCount).toBe(3);
      expect(res.config.aspectRatio).toBe("16:9");
      expect(res.config.seed).toBe(42);
      expect(res.body).toContain("A cinematic city at dawn");
    });

    it("rejects non-prompt notes", () => {
      const md = ["---", "ss_flow_kind: not-prompt", "---", "", "Hello"].join("\n");

      const res = parseCanvasFlowPromptNote(md);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe("not-canvasflow-prompt");
    });

    it("rejects unsupported backend", () => {
      const md = [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: replicate",
        "---",
        "",
        "Hello",
      ].join("\n");

      const res = parseCanvasFlowPromptNote(md);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toContain("unsupported backend");
    });
  });

  describe("replaceMarkdownBodyPreservingFrontmatter", () => {
    it("preserves frontmatter and replaces body", () => {
      const original = [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: openrouter",
        "---",
        "",
        "Old prompt",
        "",
      ].join("\n");

      const updated = replaceMarkdownBodyPreservingFrontmatter(original, "New prompt");
      expect(updated).toContain("ss_flow_kind: prompt");
      expect(updated).toContain("ss_flow_backend: openrouter");
      expect(updated).toContain("New prompt");
      expect(updated).not.toContain("Old prompt");
    });

    it("replaces whole content when no frontmatter", () => {
      const updated = replaceMarkdownBodyPreservingFrontmatter("Old", "New");
      expect(updated).toBe("New\n");
    });
  });

  describe("replaceMarkdownFrontmatterAndBody", () => {
    it("replaces both frontmatter and body", () => {
      const original = [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: openrouter",
        "---",
        "",
        "Old prompt",
        "",
      ].join("\n");

      const updated = replaceMarkdownFrontmatterAndBody(
        original,
        {
          ss_flow_kind: "prompt",
          ss_flow_backend: "openrouter",
          ss_image_model: "openai/gpt-5-image-mini",
          ss_image_count: 2,
        },
        "New prompt"
      );

      expect(updated).toContain("ss_image_model: openai/gpt-5-image-mini");
      expect(updated).toContain("ss_image_count: 2");
      expect(updated).toContain("New prompt");
      expect(updated).not.toContain("Old prompt");
    });
  });
});
