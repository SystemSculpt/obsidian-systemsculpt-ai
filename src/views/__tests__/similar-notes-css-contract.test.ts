import fs from "node:fs";
import path from "node:path";

describe("Similar Notes CSS contract", () => {
  it("responds to the sidebar container instead of the app viewport", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "src/css/views/similar-notes.css"),
      "utf8",
    );

    expect(css).toMatch(/container:\s*systemsculpt-similar-notes\s*\/\s*inline-size/);
    expect(css).toMatch(/@container\s+systemsculpt-similar-notes\s*\(max-width:\s*480px\)/);
    expect(css).not.toMatch(/@media\s*\(max-width:/);
  });
});
