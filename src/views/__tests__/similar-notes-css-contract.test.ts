import fs from "node:fs";
import path from "node:path";

describe("Similar notes CSS contract", () => {
  it("adapts to the mounted Plugin surface container", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "src/css/views/similar-notes.css"),
      "utf8",
    );

    expect(css).toMatch(/@container\s+ss-surface\s*\(max-width:\s*480px\)/);
    expect(css).not.toContain("container: systemsculpt-similar-notes");
  });

  it("keeps spinner motion scoped to the compact lifecycle strip", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "src/css/views/similar-notes.css"),
      "utf8",
    );

    expect(css).toContain(".ss-embeddings-view__index-status.is-processing .ss-embeddings-view__index-icon svg");
    expect(css).toContain(".ss-embeddings-view__index-status.is-initializing .ss-embeddings-view__index-icon svg");
    expect(css).not.toContain(".ss-embeddings-view__state--processing > .ss-ui-state__icon");
  });
});
