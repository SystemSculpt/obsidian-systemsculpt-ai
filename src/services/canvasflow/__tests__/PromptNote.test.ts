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
    it("parses a replicate prompt note", () => {
      const md = [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: replicate",
        "ss_replicate_model: acme/my-model",
        "ss_replicate_version: ver123",
        "ss_replicate_prompt_key: prompt",
        "ss_replicate_image_key: image",
        "ss_image_count: 3",
        "ss_replicate_input:",
        "  width: 512",
        "  height: 768",
        "---",
        "",
        "A cute cat astronaut",
        "",
      ].join("\n");

      const res = parseCanvasFlowPromptNote(md);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.config.backend).toBe("replicate");
      expect(res.config.replicateModelSlug).toBe("acme/my-model");
      expect(res.config.replicateVersionId).toBe("ver123");
      expect(res.config.replicatePromptKey).toBe("prompt");
      expect(res.config.replicateImageKey).toBe("image");
      expect(res.config.imageCount).toBe(3);
      expect(res.config.replicateInput.width).toBe(512);
      expect(res.config.replicateInput.height).toBe(768);
      expect(res.body).toContain("A cute cat astronaut");
    });

    it("rejects non-prompt notes", () => {
      const md = [
        "---",
        "ss_flow_kind: not-prompt",
        "---",
        "",
        "Hello",
      ].join("\n");

      const res = parseCanvasFlowPromptNote(md);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe("not-canvasflow-prompt");
    });
  });

  describe("replaceMarkdownBodyPreservingFrontmatter", () => {
    it("preserves frontmatter and replaces body", () => {
      const original = [
        "---",
        "ss_flow_kind: prompt",
        "ss_flow_backend: replicate",
        "---",
        "",
        "Old prompt",
        "",
      ].join("\n");

      const updated = replaceMarkdownBodyPreservingFrontmatter(original, "New prompt");
      expect(updated).toContain("ss_flow_kind: prompt");
      expect(updated).toContain("ss_flow_backend: replicate");
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
        "ss_flow_backend: replicate",
        "---",
        "",
        "Old prompt",
        "",
      ].join("\n");

      const updated = replaceMarkdownFrontmatterAndBody(
        original,
        {
          ss_flow_kind: "prompt",
          ss_flow_backend: "replicate",
          ss_replicate_model: "acme/model",
          ss_replicate_input: { width: 512 },
        },
        "New prompt"
      );

      expect(updated).toContain("ss_replicate_model: acme/model");
      expect(updated).toContain("width: 512");
      expect(updated).toContain("New prompt");
      expect(updated).not.toContain("Old prompt");
    });
  });
});
