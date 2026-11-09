/** @jest-environment jsdom */
import { renderJsonLines } from "../ToolCardBlocks";

describe("renderJsonLines", () => {
  it("lets a long path wrap after a slash, never inside an escape or a short hyphenated name", () => {
    const code = document.createElement("code");
    const text = JSON.stringify({ output: "/Users/me/.trellis/var/T-5957/qa/vault/Notes/Garden.md\n/Users/me/Notes/Launch plan.md" }, null, 2);
    renderJsonLines(code, text);
    // The text stays exactly the JSON, so it copies as it was.
    expect(code.textContent).toBe(text);
    const value = code.querySelectorAll<HTMLElement>(".ss-json-line")[1];
    // A wrapped line may start after each "/" and after a "\n" escape.
    expect(value.querySelectorAll("wbr").length).toBe(14);
    expect(Array.from(value.querySelectorAll(".ss-json-whole"), (token) => token.textContent)).toEqual(["T-5957", "\\n"]);
    // A name with a space moves to the next line whole.
    expect(Array.from(value.querySelectorAll(".ss-json-name"), (name) => name.textContent)).toEqual(["Launch plan.md\""]);
    // A short line has no break points of its own.
    expect(code.querySelectorAll<HTMLElement>(".ss-json-line")[0].querySelector("wbr")).toBeNull();
  });

  it("keeps each saved file's name and date whole in a list of paths", () => {
    const code = document.createElement("code");
    const message = "Saved 2 images: SystemSculpt/Images/2026-11-08 093100 lighthouse take 1.png, SystemSculpt/Images/2026-11-08 093100 lighthouse take 2.png";
    const text = JSON.stringify({ message }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const value = code.querySelectorAll<HTMLElement>(".ss-json-line")[1];
    expect(Array.from(value.querySelectorAll(".ss-json-name"), (name) => name.textContent)).toEqual([
      "2026-11-08 093100 lighthouse take 1.png,",
      "2026-11-08 093100 lighthouse take 2.png\"",
    ]);
    expect(Array.from(value.querySelectorAll(".ss-json-name .ss-json-whole"), (token) => token.textContent)).toEqual(["2026-11-08", "2026-11-08"]);
    // The key that opens the line flows as it is: it is no name of its own.
    expect(value.querySelector(".ss-json-name")?.previousSibling?.nodeName).toBe("WBR");
  });

  it("keeps a command's flags whole on a line with no path", () => {
    const code = document.createElement("code");
    const text = JSON.stringify({ command: "git status --short", run: "npm test -- --run garden" }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    expect(Array.from(code.querySelectorAll(".ss-json-whole"), (word) => word.textContent)).toEqual(["--short\",", "--", "--run"]);
  });

  it("keeps a file name whole when a sentence follows it", () => {
    const code = document.createElement("code");
    const message = "Ran Poster: SystemSculpt/Studio/Outputs/Poster image.png. The chat already shows the picture, so don't repeat it.";
    const text = JSON.stringify({ message }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const value = code.querySelectorAll<HTMLElement>(".ss-json-line")[1];
    expect(value.querySelector(".ss-json-name")?.textContent).toBe("Poster image.png");
  });
});
