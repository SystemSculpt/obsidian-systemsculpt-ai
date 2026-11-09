/**
 * @jest-environment jsdom
 */
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
    // A short line has no break points of its own.
    expect(code.querySelectorAll<HTMLElement>(".ss-json-line")[0].querySelector("wbr")).toBeNull();
  });
});
