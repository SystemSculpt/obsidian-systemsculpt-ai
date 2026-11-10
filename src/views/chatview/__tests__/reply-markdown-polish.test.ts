/** @jest-environment jsdom */
import { enhanceMarkdownEmbeds, markUnresolvedLinks } from "../MarkdownEmbeds";
import { fitRequestBubbles } from "../RequestBubbleFit";

function html(markup: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

describe("reply links and embeds", () => {
  it("marks a wikilink to a missing note as unresolved and leaves notes that exist alone", () => {
    const root = html(`<p>
      <a class="internal-link" data-href="Garden">Garden</a>
      <a class="internal-link" data-href="Notes/Launch plan#Dates|the plan">the plan</a>
      <a class="internal-link" data-href="Nowhere">Nowhere</a>
      <a class="internal-link" data-href="#Today">Today</a>
      <a class="internal-link ss-embed-source" data-href="Gone.pdf">Gone</a>
    </p>`);
    const asked: string[] = [];
    markUnresolvedLinks(root, (linkpath) => {
      asked.push(linkpath);
      return linkpath === "Garden" || linkpath === "Notes/Launch plan";
    });
    const unresolved = Array.from(root.querySelectorAll(".is-unresolved")).map((link) => link.textContent);
    expect(unresolved).toEqual(["Nowhere"]);
    // Headings of this note and an embed's own file-name link are not looked up.
    expect(asked).toEqual(["Garden", "Notes/Launch plan", "Nowhere"]);
  });

  it("clears the mark once the note exists", () => {
    const root = html(`<p><a class="internal-link is-unresolved" data-href="Basil">Basil</a></p>`);
    markUnresolvedLinks(root, () => true);
    expect(root.querySelector(".is-unresolved")).toBeNull();
  });

  it("starts media written after text on its own line, but not media in a paragraph of its own", () => {
    const root = html(`
      <p>A markdown image: <span class="internal-embed image-embed" src="a.png"></span></p>
      <p> <span class="internal-embed image-embed" src="b.png"></span></p>
      <p>Listen:<br><span class="internal-embed media-embed audio-embed" src="memo.m4a"></span></p>`);
    enhanceMarkdownEmbeds(root);
    const after = Array.from(root.querySelectorAll(".internal-embed")).map((embed) => embed.classList.contains("is-after-text"));
    expect(after).toEqual([true, false, true]);
  });

  it("names every embedded file beneath it and gives its player no overflow menu", async () => {
    const root = html(`
      <p><span class="internal-embed image-embed" src="Images/2026-11-08 093012 lighthouse at dusk.png"><img></span></p>
      <p><span class="internal-embed pdf-embed" src="Planting guide.pdf"></span></p>
      <p><span class="internal-embed media-embed audio-embed" src="Voice memo.m4a"><audio controls></audio></span></p>
      <p><span class="internal-embed media-embed video-embed" src="forest.mp4"></span></p>`);
    enhanceMarkdownEmbeds(root);
    const names = Array.from(root.querySelectorAll("a.ss-embed-source")).map((link) => [link.getAttribute("data-embed-kind"), link.textContent]);
    expect(names).toEqual([["image", "lighthouse at dusk"], ["pdf", "Planting guide"], ["audio", "Voice memo"], ["video", "forest"]]);
    expect(root.querySelector("audio")?.getAttribute("controlslist")).toBe("nodownload noplaybackrate noremoteplayback");
    // A player Obsidian builds once its file loads gets the same controls.
    const video = document.createElement("video");
    root.querySelector(".video-embed")!.appendChild(video);
    await Promise.resolve();
    expect(video.getAttribute("controlslist")).toBe("nodownload noplaybackrate noremoteplayback");
  });
});

describe("request bubbles", () => {
  type Box = Readonly<{ left: number; right: number }>;

  /** A user row whose body wraps its words into lines ending at the given right edges. */
  function requestRow(root: HTMLElement, lines: readonly number[], options: { children?: string; editing?: boolean } = {}): HTMLElement {
    const row = root.createDiv({ cls: `systemsculpt-agent-turn is-user${options.editing ? " is-editing" : ""}` });
    const body = row.createDiv({ cls: "systemsculpt-agent-turn-body" });
    body.innerHTML = options.children ?? "<p>Make a picture of a lighthouse at dusk, wide.</p>";
    body.style.padding = "12px 16px";
    body.style.border = "0px solid";
    rect(body, { left: 100, right: 400 });
    (body as HTMLElement & { lines?: readonly number[] }).lines = lines;
    return row;
  }

  function rect(element: Element, box: Box): void {
    jest.spyOn(element, "getBoundingClientRect").mockReturnValue({
      left: box.left, right: box.right, width: box.right - box.left, top: 0, bottom: 40, height: 40, x: box.left, y: 0, toJSON: () => ({}),
    } as DOMRect);
  }

  beforeEach(() => {
    // jsdom has no layout: each text node reports the line boxes its bubble was given.
    jest.spyOn(document, "createRange").mockImplementation(() => {
      let node: Node | null = null;
      return {
        selectNodeContents: (target: Node) => { node = target; },
        getClientRects: () => {
          const body = (node?.parentElement?.closest(".systemsculpt-agent-turn-body") ?? null) as (HTMLElement & { lines?: readonly number[] }) | null;
          return (body?.lines ?? []).map((right) => ({ left: 116, right, width: right - 116 })) as unknown as DOMRectList;
        },
      } as unknown as Range;
    });
  });

  it("narrows a wrapped bubble to its longest line, plus its padding", () => {
    const root = html("");
    rect(root, { left: 0, right: 700 });
    const row = requestRow(root, [318.2, 189]);
    fitRequestBubbles(root);
    // Longest line 318.2 - 116 = 202.2, rounded up plus one spare pixel, plus 32 px of padding.
    expect(row.style.maxWidth).toBe("236px");
  });

  it("leaves a bubble that already hugs its text, and one holding more than words", () => {
    const root = html("");
    rect(root, { left: 0, right: 700 });
    const oneLine = requestRow(root, [383]);
    const withCode = requestRow(root, [200], { children: "<p>Run this:</p><pre><code>npm test</code></pre>" });
    fitRequestBubbles(root);
    expect(oneLine.style.maxWidth).toBe("");
    expect(withCode.style.maxWidth).toBe("");
  });

  it("fits again only when the chat's width changes, and never a message being edited", () => {
    const root = html("");
    rect(root, { left: 0, right: 700 });
    const row = requestRow(root, [318.2, 189]);
    fitRequestBubbles(root);
    row.style.maxWidth = "999px";
    fitRequestBubbles(root);
    expect(row.style.maxWidth).toBe("999px");
    rect(root, { left: 0, right: 500 });
    fitRequestBubbles(root);
    expect(row.style.maxWidth).toBe("236px");
    row.addClass("is-editing");
    fitRequestBubbles(root);
    expect(row.style.maxWidth).toBe("");
  });
});
