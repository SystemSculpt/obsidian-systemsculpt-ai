/** @jest-environment jsdom */
import { renderJsonLines, renderRawDetails } from "../ToolCardBlocks";

describe("renderRawDetails", () => {
  const input = { prompt: "A lighthouse at dusk", aspect_ratio: "3:2" };
  const lineTexts = (code: HTMLElement): string[] => Array.from(code.querySelectorAll<HTMLElement>(".ss-json-line"), (line) => line.textContent ?? "");

  it("holds a result's place while it is made, on the lines the result lands on", () => {
    const running = renderRawDetails(document.createElement("div"), () => ({ input }), { open: true, awaitingResult: true });
    const code = running.querySelector("code")!;
    // The request, then the result's key and its close, with shimmering lines between them.
    expect(lineTexts(code)).toEqual(["{\n", '  "input": {\n', '    "prompt": "A lighthouse at dusk",\n', '    "aspect_ratio": "3:2"\n', "  },\n", '  "output": {\n', "  }\n", "}"]);
    expect(Array.from(code.querySelectorAll(".ss-json-line.is-pending"), (line) => line.textContent)).toEqual(['  "output": {\n', "  }\n"]);
    const pending = code.querySelector<HTMLElement>(".ss-json-pending")!;
    expect(pending.getAttribute("aria-hidden")).toBe("true");
    expect(pending.children).toHaveLength(12);
    expect(pending.previousElementSibling?.textContent).toBe('  "output": {\n');
    expect(pending.nextElementSibling?.textContent).toBe("  }\n");
    // The result starts on the line its place held.
    const done = renderRawDetails(document.createElement("div"), () => ({ input, output: { ok: true } }), { open: true }).querySelector("code")!;
    expect(lineTexts(done).indexOf('  "output": {\n')).toBe(lineTexts(code).indexOf('  "output": {\n'));
    expect(done.querySelector(".ss-json-pending, .is-pending")).toBeNull();
  });

  it("shows the place opened later while the result is made, and nothing pending once it has one", () => {
    const later = renderRawDetails(document.createElement("div"), () => ({ input }), { awaitingResult: true });
    expect(later.querySelector("code")!.hasChildNodes()).toBe(false);
    later.open = true;
    later.dispatchEvent(new Event("toggle"));
    expect(later.querySelectorAll(".ss-json-pending")).toHaveLength(1);
    const idle = renderRawDetails(document.createElement("div"), () => ({ input }), { open: true });
    expect(idle.querySelector(".ss-json-pending")).toBeNull();
    expect(idle.querySelector("code")!.textContent).toBe(JSON.stringify({ input }, null, 2));
  });

  it("lets a short value flow from its key when moving it would still take two lines", () => {
    const host = document.body.createDiv();
    const raw = renderRawDetails(host, () => ({ input: { oldText: "Tomatoes go in the south bed.", path: "Notes/Garden.md" } }));
    const code = raw.querySelector("code")!;
    const width = jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(240);
    const style = jest.spyOn(window, "getComputedStyle").mockReturnValue({ lineHeight: "18px" } as CSSStyleDeclaration);
    // Laid out on its own line, the first value wraps to two lines; the second fits on one.
    const box = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { height: this.textContent?.startsWith('"Tomatoes') ? 36 : 18 } as DOMRect;
    });
    try {
      raw.open = true;
      raw.dispatchEvent(new Event("toggle"));
      const units = Array.from(code.querySelectorAll<HTMLElement>(".ss-json-fit"));
      expect(units.map((unit) => [unit.textContent, unit.classList.contains("is-flowing")])).toEqual([
        ['"Tomatoes go in the south bed.",', true],
        ['"Notes/Garden.md"', false],
      ]);
    } finally {
      width.mockRestore();
      style.mockRestore();
      box.mockRestore();
      host.remove();
    }
  });
});

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

  it("breaks a command line between its commands, never inside one", () => {
    const code = document.createElement("code");
    const text = JSON.stringify({ command: "rm -rf build && npm run build", description: "Clean build" }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const line = code.querySelectorAll<HTMLElement>(".ss-json-line")[1];
    // Each command moves to the next line whole; the closing quote and comma stay on the last.
    expect(Array.from(line.querySelectorAll(".ss-json-name"), (name) => name.textContent)).toEqual(["rm -rf build &&", "npm run build\","]);
    // A command that wraps keeps its last two words together ("build &&"), never ending on one.
    expect(Array.from(line.querySelectorAll(".ss-json-whole"), (word) => word.textContent)).toEqual(["-rf", "build &&", "run build\","]);
    // One command alone keeps the ordinary word rule.
    const single = document.createElement("code");
    renderJsonLines(single, JSON.stringify({ command: "npm run build" }, null, 2));
    expect(single.querySelector(".ss-json-name")).toBeNull();
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
    expect(Array.from(value.querySelectorAll(".ss-json-name .ss-json-whole"), (token) => token.textContent)).toEqual(["2026-11-08", "take 1.png,", "2026-11-08", "take 2.png\""]);
    // Each listed path is one piece with its comma: a line breaks between paths, never pairing one
    // file's name with the next file's folder, and inside a path only when it is wider than the line.
    expect(Array.from(value.querySelectorAll(".ss-json-path"), (path) => path.textContent)).toEqual([
      "SystemSculpt/Images/2026-11-08 093100 lighthouse take 1.png,",
      "SystemSculpt/Images/2026-11-08 093100 lighthouse take 2.png\"",
    ]);
    expect(value.querySelectorAll(".ss-json-path wbr")).toHaveLength(4);
    // The key that opens the line flows as it is: it is no name of its own.
    expect(value.querySelector(".ss-json-name")?.previousSibling?.nodeName).toBe("WBR");
    const range = document.createRange();
    range.setStartBefore(value.firstChild!);
    range.setEndBefore(value.querySelector(".ss-json-path")!);
    expect(range.toString()).toBe('  "message": "Saved 2 images: ');
  });

  it("keeps a value that is one path on its key's line, breaking it after a slash", () => {
    const code = document.createElement("code");
    const text = JSON.stringify({ path: "SystemSculpt/Images/2026-11-08 093100 lighthouse take 1.png" }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const value = code.querySelectorAll<HTMLElement>(".ss-json-line")[1];
    expect(value.querySelector(".ss-json-path")).toBeNull();
    expect(value.querySelectorAll("wbr")).toHaveLength(2);
  });

  it("keeps a command's flags whole on a line with no path", () => {
    const code = document.createElement("code");
    const text = JSON.stringify({ command: "git status --short", run: "npm test -- --run garden" }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    expect(Array.from(code.querySelectorAll(".ss-json-whole"), (word) => word.textContent)).toEqual(["status --short\",", "--", "--run garden\""]);
  });

  it("moves a short value whole after its key, and a long one never ends on one word", () => {
    const code = document.createElement("code");
    const text = JSON.stringify({ message: "2 Studio workflows.", path: "Notes/Archive", prompt: "A lighthouse on a rocky coast at dusk, four square takes" }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const lines = code.querySelectorAll<HTMLElement>(".ss-json-line");
    // The value is one piece: it fits after its key or moves to the next line whole.
    expect(lines[1].querySelector(".ss-json-path")?.textContent).toBe('"2 Studio workflows.",');
    expect(lines[2].querySelector(".ss-json-path")?.textContent).toBe('"Notes/Archive",');
    // It moves only when it then fits on one line (fitJsonUnits); flowing instead, it breaks only after its "/".
    expect(lines[2].querySelector(".ss-json-path")?.classList.contains("ss-json-fit")).toBe(true);
    expect(lines[2].querySelectorAll("wbr")).toHaveLength(1);
    // A value too long to move whole flows after its key, its last two words together.
    expect(lines[3].querySelector(".ss-json-path")).toBeNull();
    expect(Array.from(lines[3].querySelectorAll(".ss-json-whole"), (word) => word.textContent)).toEqual(['square takes"']);
  });

  it("moves each line a value lists to the next line whole, its number with its words", () => {
    const code = document.createElement("code");
    const text = JSON.stringify({ output: "     1\t# Garden plan\n     2\t\n     3\tTomatoes go in the south bed.", files: "/vault/Notes/Garden.md\n/vault/Notes/Launch plan.md" }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const [, read, files] = code.querySelectorAll<HTMLElement>(".ss-json-line");
    // Each entry is one piece ending on its own "\n", the first too, so every entry starts a line alike.
    expect(Array.from(read.querySelectorAll(".ss-json-path"), (entry) => entry.textContent)).toEqual(['"     1\\t# Garden plan\\n', "     2\\t\\n", '     3\\tTomatoes go in the south bed.",']);
    expect(Array.from(files.querySelectorAll(".ss-json-path"), (entry) => entry.textContent)).toEqual(['"/vault/Notes/Garden.md\\n', '/vault/Notes/Launch plan.md"']);
    // The first moves off its key's line only when it then fits on one line; the key stays.
    expect(read.querySelector(".ss-json-path")?.classList.contains("ss-json-fit")).toBe(true);
    expect(read.querySelector(".ss-json-path")?.textContent).not.toContain('"output"');
    // A line may start after a "\n", never after a tab: the number stays with its words.
    const third = read.querySelectorAll(".ss-json-path")[2];
    expect(third.querySelector("wbr")).toBeNull();
  });

  it("keeps a run of line breaks whole, and an entry's closing quote on it", () => {
    const code = document.createElement("code");
    const text = JSON.stringify({ output: "PASS  garden.test.ts\n\nTests: 2 passed", list: "Notes/Garden plan.md\nNotes/Basil.md\n" }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const [, output, list] = code.querySelectorAll<HTMLElement>(".ss-json-line");
    // "\n\n" is one piece, so no line starts between its two breaks.
    expect(Array.from(output.querySelectorAll(".ss-json-path"), (entry) => entry.textContent)).toEqual(['"PASS  garden.test.ts\\n\\n', 'Tests: 2 passed",']);
    expect(Array.from(output.querySelectorAll(".ss-json-whole"), (piece) => piece.textContent)).toContain("\\n\\n");
    // A value's closing quote and comma never become an entry of their own.
    expect(Array.from(list.querySelectorAll(":scope > .ss-json-path"), (entry) => entry.textContent)).toEqual(['"Notes/Garden plan.md\\n', 'Notes/Basil.md\\n"']);
  });

  it("moves each field of quoted JSON and each web address whole, breaking only between them", () => {
    const code = document.createElement("code");
    const links = 'Links: [{"title":"Frost dates · Extension Service","url":"https://example.org/extension/frost-dates"},{"title":"Portland planting calendar","url":"https://example.org/portland/calendar"}]';
    const text = JSON.stringify({ output: `Results\n\n${links}\n\nThe last frost is in early April.`, url: "https://example.org/grow/hardening-off" }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const [, output, url] = code.querySelectorAll<HTMLElement>(".ss-json-line");
    // Each source's title and its address are one piece each, so a line never pairs one's tail with the next one's head.
    const units = Array.from(output.querySelectorAll<HTMLElement>(".ss-json-fit"));
    expect(units.map((unit) => unit.textContent)).toEqual([
      '"Results\\n\\n',
      '[{\\"title\\":\\"Frost dates · Extension Service\\",',
      '\\"url\\":\\"https://example.org/extension/frost-dates\\"},',
      '{\\"title\\":\\"Portland planting calendar\\",',
      '\\"url\\":\\"https://example.org/portland/calendar\\"}]\\n\\n',
    ]);
    // A line may start after each piece that ends on a comma, even when the piece flows; the last keeps
    // the line breaks after it, so they never sit on a line of their own.
    expect(units.slice(1).map((unit) => unit.nextSibling?.nodeName)).toEqual(["WBR", "WBR", "WBR", undefined]);
    // An address's scheme stays with its site, so no line ends on "https://".
    expect(Array.from(output.querySelectorAll(".ss-json-fit > .ss-json-whole"), (piece) => piece.textContent)).toContain("https://example.org");
    // A plain address value moves whole with its quotes.
    expect(url.querySelector(".ss-json-fit")?.textContent).toBe('"https://example.org/grow/hardening-off"');
  });

  it("keeps a file name whole when a sentence follows it", () => {
    const code = document.createElement("code");
    const message = "Ran Poster: SystemSculpt/Studio/Outputs/Poster image.png. The chat already shows the picture, so don't repeat it.";
    const text = JSON.stringify({ message }, null, 2);
    renderJsonLines(code, text);
    expect(code.textContent).toBe(text);
    const value = code.querySelectorAll<HTMLElement>(".ss-json-line")[1];
    expect(value.querySelector(".ss-json-path")?.textContent).toBe("SystemSculpt/Studio/Outputs/Poster image.png.");
    expect(value.querySelector(".ss-json-name")?.textContent).toBe("Poster image.png.");
  });
});
