/**
 * @jest-environment jsdom
 */
import { resolveStudioTextNodeFocusTarget } from "../StudioGraphTextNodeFocus";

function pointerEventAt(
  target: Element,
  caretNode: Node,
  caretOffset: number
): MouseEvent {
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    value: () => {
      const range = document.createRange();
      range.setStart(caretNode, caretOffset);
      range.collapse(true);
      return range;
    },
  });
  const event = new MouseEvent("dblclick", {
    clientX: 120,
    clientY: 240,
  });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

describe("resolveStudioTextNodeFocusTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  });

  it("maps a rendered table cell character to its Markdown source cell", () => {
    const markdown = [
      "| Item | State |",
      "| --- | --- |",
      "| Alpha | Ready |",
      "| Beta | Blocked |",
    ].join("\n");
    const display = document.body.createDiv();
    display.innerHTML =
      "<table><thead><tr><th>Item</th><th>State</th></tr></thead>" +
      "<tbody><tr><td>Alpha</td><td>Ready</td></tr>" +
      "<tr><td>Beta</td><td>Blocked</td></tr></tbody></table>";
    const alpha = display.querySelector<HTMLTableCellElement>("tbody td")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(alpha, alpha.firstChild!, 3)
    );

    expect(target).toEqual({
      x: 120,
      y: 240,
      sourceOffset: markdown.indexOf("Alpha") + 3,
    });
  });

  it("does not split a table cell at an escaped pipe", () => {
    const markdown = [
      "| Item | State |",
      "| --- | --- |",
      "| A \\| B | Ready |",
    ].join("\n");
    const display = document.body.createDiv();
    display.innerHTML =
      "<table><thead><tr><th>Item</th><th>State</th></tr></thead>" +
      "<tbody><tr><td>A | B</td><td>Ready</td></tr></tbody></table>";
    const cell = display.querySelector<HTMLTableCellElement>("tbody td")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(cell, cell.firstChild!, 5)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("B | Ready") + 1);
  });

  it("maps cells in a table indented by allowed Markdown whitespace", () => {
    const markdown = [
      "  | Item | State |",
      "  | --- | --- |",
      "  | Alpha | Ready |",
    ].join("\n");
    const display = document.body.createDiv();
    display.innerHTML =
      "<table><thead><tr><th>Item</th><th>State</th></tr></thead>" +
      "<tbody><tr><td>Alpha</td><td>Ready</td></tr></tbody></table>";
    const alpha = display.querySelector<HTMLTableCellElement>("tbody td")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(alpha, alpha.firstChild!, 3)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("Alpha") + 3);
  });

  it("preserves repeated table-cell spaces in the semantic caret offset", () => {
    const markdown = [
      "| Item | State |",
      "| --- | --- |",
      "| Alpha    Beta | Ready |",
    ].join("\n");
    const display = document.body.createDiv();
    display.innerHTML =
      "<table><thead><tr><th>Item</th><th>State</th></tr></thead>" +
      "<tbody><tr><td>Alpha    Beta</td><td>Ready</td></tr></tbody></table>";
    const cell = display.querySelector<HTMLTableCellElement>("tbody td")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(cell, cell.firstChild!, 8)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("Alpha") + 8);
  });

  it("maps a table-safe escaped wiki alias into the alias text", () => {
    const markdown = [
      "| Item | State |",
      "| --- | --- |",
      "| [[Target\\|Alias]] | Ready |",
    ].join("\n");
    const display = document.body.createDiv();
    display.innerHTML =
      "<table><thead><tr><th>Item</th><th>State</th></tr></thead>" +
      "<tbody><tr><td>Alias</td><td>Ready</td></tr></tbody></table>";
    const alias = display.querySelector<HTMLTableCellElement>("tbody td")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(alias, alias.firstChild!, 3)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("Alias") + 3);
  });

  it("maps a fenced-code click inside the fence content", () => {
    const markdown = [
      "```ts",
      "const answer = 42;",
      "console.log(answer);",
      "```",
    ].join("\n");
    const display = document.body.createDiv();
    display.innerHTML =
      "<pre><code>const answer = 42;\nconsole.log(answer);\n</code></pre>";
    const code = display.querySelector<HTMLElement>("code")!;
    const renderedOffset = "const answer = 42;\nconsole.lo".length;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(code, code.firstChild!, renderedOffset)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("console.log") + "console.lo".length);
  });

  it("maps rendered inline Markdown back through hidden syntax markers", () => {
    const markdown = "A **bold** line with `inline code`.";
    const display = document.body.createDiv();
    display.innerHTML =
      "<p>A <strong>bold</strong> line with <code>inline code</code>.</p>";
    const code = display.querySelector<HTMLElement>("code")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(code, code.firstChild!, 6)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("inline code") + 6);
  });

  it("maps headings after the source heading marker", () => {
    const markdown = "# Status";
    const display = document.body.createDiv();
    display.innerHTML = "<h1>Status</h1>";
    const heading = display.querySelector<HTMLElement>("h1")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(heading, heading.firstChild!, 3)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("Status") + 3);
  });

  it("does not confuse a visible heading hash with the source marker", () => {
    const markdown = "# #";
    const display = document.body.createDiv();
    display.innerHTML = "<h1>#</h1>";
    const heading = display.querySelector<HTMLElement>("h1")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(heading, heading.firstChild!, 1)
    );

    expect(target.sourceOffset).toBe(markdown.length);
  });

  it("maps task-list text after the list and checkbox markers", () => {
    const markdown = ["- Plain bullet", "- [x] Done", "- [ ] Next"].join("\n");
    const display = document.body.createDiv();
    display.innerHTML =
      "<ul><li>Plain bullet</li><li class=\"task-list-item\">" +
      "<input type=\"checkbox\" checked>Done</li>" +
      "<li class=\"task-list-item\"><input type=\"checkbox\">Next</li></ul>";
    const done = display.querySelectorAll<HTMLLIElement>("li")[1];
    const doneText = done.lastChild!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(done, doneText, 2)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("Done") + 2);
  });

  it("maps a parent nested-list click into the parent item source", () => {
    const markdown = ["- Parent", "  - Child"].join("\n");
    const display = document.body.createDiv();
    display.innerHTML = "<ul><li>Parent<ul><li>Child</li></ul></li></ul>";
    const parent = display.querySelector<HTMLLIElement>("li")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(parent, parent.firstChild!, 3)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("Parent") + 3);
  });

  it("maps a child nested-list click into the child item source", () => {
    const markdown = ["- Parent", "  - Child"].join("\n");
    const display = document.body.createDiv();
    display.innerHTML = "<ul><li>Parent<ul><li>Child</li></ul></li></ul>";
    const child = display.querySelectorAll<HTMLLIElement>("li")[1];

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(child, child.firstChild!, 2)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("Child") + 2);
  });

  it("maps list continuation text within the same rendered list item", () => {
    const markdown = ["- Parent", "  continuation"].join("\n");
    const display = document.body.createDiv();
    display.innerHTML = "<ul><li>Parent continuation</li></ul>";
    const item = display.querySelector<HTMLLIElement>("li")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(item, item.firstChild!, "Parent con".length)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("continuation") + 3);
  });

  it("falls back instead of inventing an offset for a loose list", () => {
    const markdown = "- One\n\n- Two";
    const display = document.body.createDiv();
    display.innerHTML = "<ul><li>One</li><li>Two</li></ul>";
    const two = display.querySelectorAll<HTMLLIElement>("li")[1];

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(two, two.firstChild!, 2)
    );

    expect(target).toEqual({ x: 120, y: 240 });
  });

  it("falls back for transformed entities that cannot be aligned monotonically", () => {
    const markdown = "A &copy; B";
    const display = document.body.createDiv();
    display.innerHTML = "<p>A © B</p>";
    const paragraph = display.querySelector<HTMLElement>("p")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(paragraph, paragraph.firstChild!, 3)
    );

    expect(target).toEqual({ x: 120, y: 240 });
  });

  it("maps a wiki alias into its visible source range, not its hidden target", () => {
    const markdown = "[[Alpha target|Alpha]] status";
    const display = document.body.createDiv();
    display.innerHTML = "<p>Alpha status</p>";
    const paragraph = display.querySelector<HTMLElement>("p")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(paragraph, paragraph.firstChild!, 3)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("|Alpha") + 1 + 3);
  });

  it("maps surrounding Markdown only after validating the whole rendered block", () => {
    const markdown = "**Before** [[Target|Alias]] `after`";
    const display = document.body.createDiv();
    display.innerHTML =
      "<p><strong>Before</strong> <a>Alias</a> <code>after</code></p>";
    const code = display.querySelector<HTMLElement>("code")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(code, code.firstChild!, 2)
    );

    expect(target.sourceOffset).toBe(markdown.indexOf("after") + 2);
  });

  it("maps the second of two repeated wiki aliases to the second source alias", () => {
    const markdown = "[[One|Same]] [[Two|Same]]";
    const display = document.body.createDiv();
    display.innerHTML = "<p><a>Same</a> <a>Same</a></p>";
    const second = display.querySelectorAll<HTMLElement>("a")[1];

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(second, second.firstChild!, 2)
    );

    expect(target.sourceOffset).toBe(markdown.lastIndexOf("Same") + 2);
  });

  it("falls back for an unaliased path whose rendered basename shifts", () => {
    const markdown = "[[folder/foo]]";
    const display = document.body.createDiv();
    display.innerHTML = "<p>foo</p>";
    const paragraph = display.querySelector<HTMLElement>("p")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(paragraph, paragraph.firstChild!, 2)
    );

    expect(target).toEqual({ x: 120, y: 240 });
  });

  it("falls back for embedded wiki content that replaces the source token", () => {
    const markdown = "![[Diagram.png|Architecture]]";
    const display = document.body.createDiv();
    display.innerHTML = "<p><img alt=\"Architecture\"></p>";
    const paragraph = display.querySelector<HTMLElement>("p")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(paragraph, paragraph, 0)
    );

    expect(target).toEqual({ x: 120, y: 240 });
  });

  it("falls back for an alias when a later embed changes the same block", () => {
    const markdown = "[[Target|Alias]] ![[Diagram.png]]";
    const display = document.body.createDiv();
    display.innerHTML = "<p><a>Alias</a> <img></p>";
    const alias = display.querySelector<HTMLElement>("a")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(alias, alias.firstChild!, 3)
    );

    expect(target).toEqual({ x: 120, y: 240 });
  });

  it("still maps ordinary bracket text that is not a wiki link", () => {
    const markdown = "plain [A]] text";
    const display = document.body.createDiv();
    display.innerHTML = "<p>plain [A]] text</p>";
    const paragraph = display.querySelector<HTMLElement>("p")!;

    const target = resolveStudioTextNodeFocusTarget(
      markdown,
      display,
      pointerEventAt(paragraph, paragraph.firstChild!, 8)
    );

    expect(target.sourceOffset).toBe(8);
  });

  it("falls back when the browser cannot resolve a caret inside the rendered block", () => {
    const display = document.body.createDiv();
    display.innerHTML = "<p>multiline text</p>";
    const paragraph = display.querySelector<HTMLElement>("p")!;
    delete (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
    const event = new MouseEvent("dblclick", { clientX: 12, clientY: 34 });
    Object.defineProperty(event, "target", { configurable: true, value: paragraph });

    expect(resolveStudioTextNodeFocusTarget("multiline text", display, event)).toEqual({
      x: 12,
      y: 34,
    });
  });

  it("keeps viewport coordinates as a fallback outside a rendered block", () => {
    const display = document.body.createDiv();
    const event = new MouseEvent("dblclick", { clientX: 12, clientY: 34 });
    Object.defineProperty(event, "target", { configurable: true, value: display });

    expect(resolveStudioTextNodeFocusTarget("text", display, event)).toEqual({
      x: 12,
      y: 34,
    });
  });
});
