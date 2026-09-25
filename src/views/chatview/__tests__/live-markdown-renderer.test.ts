/**
 * @jest-environment jsdom
 */

import { Component } from "obsidian";
import {
  LiveMarkdownRenderer,
  reconcileLiveMarkdownDom,
  stableMarkdownBoundary,
} from "../LiveMarkdownRenderer";

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderParagraph(markdown: string, staging: HTMLElement): void {
  staging.createEl("p", { text: `rendered:${markdown}` });
}

/*
 * A block-faithful stand-in for Obsidian's renderer: fenced code becomes a
 * pre with a copy button, `[label](#x)` lines become links, and every other
 * blank-line separated block becomes a paragraph.
 */
function renderBlocks(markdown: string, staging: HTMLElement): void {
  const lines = markdown.split("\n");
  let paragraph: string[] = [];
  const closeParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (!text) return;
    const link = /^\[(.+)\]\((#.+)\)$/.exec(text);
    if (link) {
      staging.createEl("p").createEl("a", { text: link[1], href: link[2] });
      return;
    }
    staging.createEl("p", { text });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      closeParagraph();
      const code: string[] = [];
      for (index += 1; index < lines.length && !lines[index].startsWith("```"); index += 1) {
        code.push(lines[index]);
      }
      const pre = staging.createEl("pre", { cls: "systemsculpt-agent-code-block" });
      pre.createEl("code", { text: code.join("\n") });
      pre.createEl("button", {
        cls: "systemsculpt-agent-code-copy",
        text: "Copy",
        attr: { "aria-label": "Copy code" },
      });
    } else if (line.trim() === "") {
      closeParagraph();
    } else {
      paragraph.push(line);
    }
  }
  closeParagraph();
}

function longStreamedResponse(blocks: number): string {
  const parts: string[] = [];
  for (let index = 0; index < blocks; index += 1) {
    if (index % 10 === 3) {
      parts.push(`\`\`\`ts\nconst value${index} = ${index};\n\nreturn value${index};\n\`\`\``);
    } else if (index % 10 === 7) {
      parts.push(`- item ${index} a\n- item ${index} b\n\n- item ${index} c`);
    } else if (index % 10 === 9) {
      parts.push(`[Link ${index}](#link-${index})`);
    } else {
      parts.push(`Paragraph ${index} ${"lorem ipsum dolor sit amet ".repeat(6).trim()}.`);
    }
  }
  return parts.join("\n\n");
}

describe("LiveMarkdownRenderer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.empty();
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.empty();
  });

  it("keeps raw Markdown hidden until detached parsing commits", async () => {
    const gate = deferred();
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      await gate.promise;
      expect(markdown).toBe("**Hello**");
      const paragraph = staging.createEl("p");
      paragraph.createEl("strong", { text: "Hello" });
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    live.stream(target, "**Hello**");
    expect(target.childNodes).toHaveLength(0);
    expect(target.classList).not.toContain("is-live-markdown-fallback");
    expect(render).toHaveBeenCalledTimes(1);

    const completion = live.flush(target);
    gate.resolve();
    await completion;

    expect(target.innerHTML).toBe("<p><strong>Hello</strong></p>");
    expect(target.classList).not.toContain("is-live-markdown-fallback");
    live.unload();
  });

  it("brackets a delayed connected DOM commit after detached parsing finishes", async () => {
    const gate = deferred();
    const target = document.body.createDiv();
    const commitEvents: string[] = [];
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      expect(staging.isConnected).toBe(false);
      await gate.promise;
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({
      render,
      beginDomCommit: (current) => {
        commitEvents.push(`begin:${current.innerHTML}`);
        return () => commitEvents.push(`end:${current.innerHTML}`);
      },
    });
    live.load();

    live.stream(target, "Delayed");
    expect(target.childNodes).toHaveLength(0);
    expect(commitEvents).toEqual([]);

    const completion = live.flush(target);
    gate.resolve();
    await completion;

    expect(commitEvents).toEqual([
      "begin:",
      "end:<p>rendered:Delayed</p>",
    ]);
    expect(target.innerHTML).toBe("<p>rendered:Delayed</p>");
    live.unload();
  });

  it("coalesces token bursts inside the throttle window into the newest snapshot", async () => {
    let now = 0;
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({
      render,
      throttleMs: 48,
      now: () => now,
    });
    live.load();

    live.stream(target, "one");
    await live.flush(target);
    expect(render.mock.calls.map(([markdown]) => markdown)).toEqual(["one"]);

    now = 10;
    live.stream(target, "two");
    now = 20;
    live.stream(target, "three");
    expect(target.textContent).toBe("rendered:one");
    expect(render).toHaveBeenCalledTimes(1);

    now = 48;
    await jest.advanceTimersByTimeAsync(38);
    await live.flush(target);

    expect(render.mock.calls.map(([markdown]) => markdown)).toEqual([
      "one",
      "three",
    ]);
    expect(target.textContent).toBe("rendered:three");
    live.unload();
  });

  it("keeps the last parsed frame visible until the newest snapshot parses", async () => {
    let now = 0;
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({
      render,
      throttleMs: 48,
      now: () => now,
    });
    live.load();

    live.stream(target, "Hello");
    await live.flush(target);
    expect(target.textContent).toBe("rendered:Hello");
    const parsedText = target.querySelector("p")?.firstChild;

    now = 10;
    live.stream(target, "Hello world");
    expect(target.textContent).toBe("rendered:Hello");
    expect(target.querySelector("p")?.firstChild).toBe(parsedText);
    now = 20;
    live.stream(target, "Hello world again");
    expect(target.textContent).toBe("rendered:Hello");
    expect(render).toHaveBeenCalledTimes(1);

    now = 30;
    live.stream(target, "Hello world again\nNext");
    expect(target.textContent).toBe("rendered:Hello");

    await live.flush(target);
    expect(target.textContent).toBe("rendered:Hello world again\nNext");
    expect(target.querySelector("p")?.childNodes).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[render.mock.calls.length - 1]?.[0])
      .toBe("Hello world again\nNext");
    live.unload();
  });

  it("does not serialize top-level blocks for lease-free Markdown frames", async () => {
    const target = document.body.createDiv();
    const outerHtml = jest.spyOn(Element.prototype, "outerHTML", "get");
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({ render, throttleMs: 0 });
    live.load();

    try {
      live.stream(target, "one");
      await live.flush(target);
      live.stream(target, "two");
      await live.flush(target);
      await live.settle(target, "two");

      expect(render).toHaveBeenCalledTimes(3);
      expect(target.textContent).toBe("rendered:two");
      expect(outerHtml).not.toHaveBeenCalled();
    } finally {
      outerHtml.mockRestore();
      live.unload();
    }
  });

  it("does not retain serialized rich blocks after final settlement", async () => {
    const target = document.body.createDiv();
    const outerHtml = jest.spyOn(Element.prototype, "outerHTML", "get");
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (markdown, staging) => {
        staging.createEl("a", { href: "#result", text: markdown });
      },
    });
    live.load();

    try {
      live.stream(target, "result");
      await live.flush(target);
      expect(outerHtml).toHaveBeenCalled();

      outerHtml.mockClear();
      await live.settle(target, "result");

      expect(target.textContent).toBe("result");
      expect(outerHtml).not.toHaveBeenCalled();
    } finally {
      outerHtml.mockRestore();
      live.unload();
    }
  });

  it("installs actual final staging and keeps its matching lease", async () => {
    const target = document.body.createDiv();
    const cleanups: jest.Mock[] = [];
    const renderedParagraphs: HTMLParagraphElement[] = [];
    const render = jest.fn(async (
      markdown: string,
      staging: HTMLElement,
      component: Component,
    ) => {
      const cleanup = jest.fn();
      cleanups.push(cleanup);
      const child = new Component();
      child.register(cleanup);
      component.addChild(child);
      renderedParagraphs.push(staging.createEl("p", {
        text: `rendered:${markdown}`,
      }));
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    live.stream(target, "one");
    await live.flush(target);
    const paragraph = target.querySelector("p");
    const text = paragraph?.firstChild;
    expect(cleanups[0]).toHaveBeenCalledTimes(1);

    live.stream(target, "two");
    await live.flush(target);
    expect(target.querySelector("p")).toBe(paragraph);
    expect(target.querySelector("p")?.firstChild).toBe(text);
    expect(target.textContent).toBe("rendered:two");
    expect(cleanups[1]).toHaveBeenCalledTimes(1);

    await live.settle(target, "two");
    expect(target.querySelector("p")).not.toBe(paragraph);
    expect(target.querySelector("p")).toBe(renderedParagraphs[2]);
    expect(render).toHaveBeenCalledTimes(3);
    expect(cleanups[2]).not.toHaveBeenCalled();

    live.unload();
    expect(cleanups[2]).toHaveBeenCalledTimes(1);
  });

  it("settles an already committed snapshot without waiting for or applying an older flight", async () => {
    const gate = deferred();
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      if (markdown === "other") await gate.promise;
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({ render, throttleMs: 0 });
    live.load();

    live.stream(target, "ready");
    await live.flush(target);
    const paragraph = target.querySelector("p");

    live.stream(target, "other");
    const completion = live.settle(target, "ready");
    expect(target.querySelector("p")).toBe(paragraph);
    expect(target.textContent).toBe("rendered:ready");
    expect(render).toHaveBeenCalledTimes(2);

    gate.resolve();
    await completion;
    expect(target.querySelector("p")).not.toBe(paragraph);
    expect(target.textContent).toBe("rendered:ready");
    expect(render.mock.calls.map(([markdown]) => markdown)).toEqual([
      "ready",
      "other",
      "ready",
    ]);
    live.unload();
  });

  it("restores disclosure and focus state after installing final staging", async () => {
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      const details = staging.createEl("details");
      details.createEl("summary", {
        text: "Details",
        attr: { "data-focus-key": "details-summary" },
      });
      details.createEl("p", { text: `rendered:${markdown}` });
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    live.stream(target, "draft");
    await live.flush(target);
    const details = target.querySelector<HTMLDetailsElement>("details")!;
    const summary = target.querySelector<HTMLElement>("summary")!;
    const paragraph = target.querySelector<HTMLParagraphElement>("p")!;
    const text = paragraph.firstChild;
    details.open = true;
    summary.focus();

    await live.settle(target, "final");

    const finalDetails = target.querySelector<HTMLDetailsElement>("details")!;
    const finalSummary = target.querySelector<HTMLElement>("summary")!;
    expect(finalDetails).not.toBe(details);
    expect(finalSummary).not.toBe(summary);
    expect(target.querySelector("p")).not.toBe(paragraph);
    expect(target.querySelector("p")?.firstChild).not.toBe(text);
    expect(target.textContent).toBe("Detailsrendered:final");
    expect(finalDetails.open).toBe(true);
    expect(document.activeElement).toBe(finalSummary);
    expect(render.mock.calls.map(([markdown]) => markdown)).toEqual([
      "draft",
      "final",
    ]);
    live.unload();
  });

  it("replaces interactive stream nodes so callbacks match the newest snapshot", async () => {
    const target = document.body.createDiv();
    const activations: string[] = [];
    const cleanups: jest.Mock[] = [];
    const live = new LiveMarkdownRenderer({
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const link = staging.createEl("a", { text: markdown, href: "#target" });
        const activate = (event: Event) => {
          event.preventDefault();
          activations.push(markdown);
        };
        link.addEventListener("click", activate);
        const cleanup = jest.fn(() => link.removeEventListener("click", activate));
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "one");
    await live.flush(target);
    const first = target.querySelector<HTMLAnchorElement>("a")!;
    expect(cleanups[0]).not.toHaveBeenCalled();
    first.click();
    expect(activations).toEqual(["one"]);

    live.stream(target, "two");
    await live.flush(target);
    const second = target.querySelector<HTMLAnchorElement>("a")!;
    expect(second).not.toBe(first);
    expect(target.textContent).toBe("two");
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).not.toHaveBeenCalled();
    first.click();
    second.click();
    expect(activations).toEqual(["one", "two"]);
    expect((live as unknown as { children: Component[] }).children).toHaveLength(1);

    live.unload();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it("keeps a stable linked block mounted while a trailing paragraph grows", async () => {
    const target = document.body.createDiv();
    const activations: string[] = [];
    const cleanups: jest.Mock[] = [];
    // A heading ends at its line, so both blocks share one open region.
    const prefix = "# [Docs](#docs)\nTail";
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const linked = staging.createEl("p");
        const link = linked.createEl("a", { text: "Docs", href: "#docs" });
        staging.createEl("p", {
          cls: "plain-tail",
          text: markdown.slice("# [Docs](#docs)\n".length),
        });
        const activate = (event: Event) => {
          event.preventDefault();
          activations.push("docs");
        };
        link.addEventListener("click", activate);
        const cleanup = jest.fn(() => link.removeEventListener("click", activate));
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    let markdown = prefix;
    live.stream(target, markdown);
    await live.flush(target);
    const linked = target.children[0];
    const link = target.querySelector<HTMLAnchorElement>("a")!;
    const tail = target.querySelector<HTMLParagraphElement>(".plain-tail")!;
    const tailText = tail.firstChild;

    for (const suffix of [" grows", " smoothly", " in place", "."]) {
      markdown += suffix;
      live.stream(target, markdown);
      await live.flush(target);
      expect(target.children[0]).toBe(linked);
      expect(target.querySelector("a")).toBe(link);
      expect(target.querySelector(".plain-tail")).toBe(tail);
      expect(tail.firstChild).toBe(tailText);
      expect(tail.textContent).toBe(markdown.slice("# [Docs](#docs)\n".length));
      expect((live as unknown as { children: Component[] }).children).toHaveLength(1);
    }

    expect(cleanups[0]).not.toHaveBeenCalled();
    for (const cleanup of cleanups.slice(1)) {
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
    link.click();
    expect(activations).toEqual(["docs"]);

    live.unload();
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated rich blocks and reader state mounted during plain tail updates", async () => {
    const target = document.body.createDiv();
    const copied: string[] = [];
    const cleanups: jest.Mock[] = [];
    const sourcePrefix = "Rich blocks\n";
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const details = staging.createEl("details");
        details.createEl("summary", {
          text: "Context",
          attr: { "data-focus-key": "context" },
        });
        const callout = details.createDiv({ cls: "callout" });
        callout.createDiv({
          cls: "callout-title",
          text: "Note",
          attr: { "aria-expanded": "true" },
        });
        callout.createEl("p", { text: "Stable callout" });
        const pre = staging.createEl("pre", {
          cls: "systemsculpt-agent-code-block",
        });
        pre.createEl("code", { text: "stable code" });
        const copy = pre.createEl("button", {
          cls: "systemsculpt-agent-code-copy",
          text: "Copy",
          attr: {
            "aria-label": "Copy code",
            "data-focus-key": "copy-code",
          },
        });
        staging.createEl("img", {
          attr: {
            alt: "Stable preview",
            src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
          },
        });
        staging.createEl("p", {
          cls: "plain-tail",
          text: markdown.slice(sourcePrefix.length),
        });
        const activate = () => copied.push("stable code");
        copy.addEventListener("click", activate);
        const cleanup = jest.fn(() => copy.removeEventListener("click", activate));
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, `${sourcePrefix}Tail`);
    await live.flush(target);
    const details = target.querySelector<HTMLDetailsElement>("details")!;
    const callout = target.querySelector<HTMLElement>(".callout")!;
    const title = target.querySelector<HTMLElement>(".callout-title")!;
    const pre = target.querySelector<HTMLPreElement>("pre")!;
    const code = target.querySelector<HTMLElement>("code")!;
    const codeText = code.firstChild!;
    const copy = target.querySelector<HTMLButtonElement>("button")!;
    const image = target.querySelector<HTMLImageElement>("img")!;
    const tail = target.querySelector<HTMLParagraphElement>(".plain-tail")!;
    const tailText = tail.firstChild;
    details.open = true;
    callout.classList.add("is-collapsed");
    title.setAttribute("aria-expanded", "false");
    pre.scrollTop = 37;
    pre.scrollLeft = 11;
    copy.classList.add("is-copied");
    copy.setText("Copied");
    copy.setAttribute("aria-label", "Copied");
    copy.dataset.copyAttempt = "stable code";
    copy.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(codeText, 0);
    range.setEnd(codeText, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    live.stream(target, `${sourcePrefix}Tail grows smoothly`);
    await live.flush(target);

    expect(target.querySelector("details")).toBe(details);
    expect(target.querySelector(".callout")).toBe(callout);
    expect(target.querySelector(".callout-title")).toBe(title);
    expect(target.querySelector("pre")).toBe(pre);
    expect(target.querySelector("code")).toBe(code);
    expect(code.firstChild).toBe(codeText);
    expect(target.querySelector("button")).toBe(copy);
    expect(target.querySelector("img")).toBe(image);
    expect(target.querySelector(".plain-tail")).toBe(tail);
    expect(tail.firstChild).toBe(tailText);
    expect(tail.textContent).toBe("Tail grows smoothly");
    expect(details.open).toBe(true);
    expect(callout.classList).toContain("is-collapsed");
    expect(title.getAttribute("aria-expanded")).toBe("false");
    expect(pre.scrollTop).toBe(37);
    expect(pre.scrollLeft).toBe(11);
    expect(copy.classList).toContain("is-copied");
    expect(copy.textContent).toBe("Copied");
    expect(copy.getAttribute("aria-label")).toBe("Copied");
    expect(copy.dataset.copyAttempt).toBe("stable code");
    expect(document.activeElement).toBe(copy);
    expect(selection.toString()).toBe("stable");
    expect(selection.anchorNode).toBe(codeText);
    expect(cleanups[0]).not.toHaveBeenCalled();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
    copy.click();
    expect(copied).toEqual(["stable code"]);

    live.unload();
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
  });

  it("replaces an append-only rich change so its callbacks stay current", async () => {
    const target = document.body.createDiv();
    const activations: string[] = [];
    const cleanups: jest.Mock[] = [];
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const link = staging.createEl("a", {
          text: markdown,
          href: `#${markdown}`,
        });
        const activate = (event: Event) => {
          event.preventDefault();
          activations.push(markdown);
        };
        link.addEventListener("click", activate);
        const cleanup = jest.fn(() => link.removeEventListener("click", activate));
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "phase");
    await live.flush(target);
    const first = target.querySelector<HTMLAnchorElement>("a")!;
    first.click();

    live.stream(target, "phase-two");
    await live.flush(target);
    const second = target.querySelector<HTMLAnchorElement>("a")!;
    expect(second).not.toBe(first);
    expect(second.textContent).toBe("phase-two");
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).not.toHaveBeenCalled();
    first.click();
    second.click();
    expect(activations).toEqual(["phase", "phase-two"]);

    live.unload();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it("does not commit a delayed rich-tail frame after unload", async () => {
    const gate = deferred();
    const lateRenderFinished = deferred();
    const target = document.body.createDiv();
    const cleanups: jest.Mock[] = [];
    let commits = 0;
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      beginDomCommit: () => {
        commits += 1;
        return undefined;
      },
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const linked = staging.createEl("p");
        const link = linked.createEl("a", { text: "Docs", href: "#docs" });
        staging.createEl("p", { text: markdown });
        const activate = (event: Event) => event.preventDefault();
        link.addEventListener("click", activate);
        const cleanup = jest.fn(() => link.removeEventListener("click", activate));
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
        if (markdown.endsWith(" grows")) {
          await gate.promise;
          lateRenderFinished.resolve();
        }
      },
    });
    live.load();

    live.stream(target, "Tail");
    await live.flush(target);
    const originalHtml = target.innerHTML;
    const originalLink = target.querySelector("a");
    expect(commits).toBe(1);

    live.stream(target, "Tail grows");
    const pending = live.flush(target);
    expect(cleanups).toHaveLength(2);
    live.unload();
    await pending;
    expect(cleanups[0]).toHaveBeenCalledTimes(1);

    gate.resolve();
    await lateRenderFinished.promise;
    await jest.advanceTimersByTimeAsync(0);

    expect(target.innerHTML).toBe(originalHtml);
    expect(target.querySelector("a")).toBe(originalLink);
    expect(commits).toBe(1);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
    expect(
      (live as unknown as { states: Map<HTMLElement, unknown> }).states.size,
    ).toBe(0);
    expect((live as unknown as { children: Component[] }).children).toHaveLength(0);
  });

  it("promotes an exact committed action and its live lease on settlement", async () => {
    const target = document.body.createDiv();
    const activations: string[] = [];
    const buttons: HTMLButtonElement[] = [];
    const cleanups: jest.Mock[] = [];
    const liveButtonAtCleanup: Array<HTMLButtonElement | null> = [];
    const render = jest.fn(async (
      markdown: string,
      staging: HTMLElement,
      component: Component,
    ) => {
      const button = staging.createEl("button", {
        text: markdown,
        attr: { "data-focus-key": "managed-action" },
      });
      const index = buttons.length;
      buttons.push(button);
      const activate = () => activations.push(markdown);
      button.addEventListener("click", activate);
      const cleanup = jest.fn(() => {
        liveButtonAtCleanup[index] = target.querySelector("button");
        button.removeEventListener("click", activate);
      });
      cleanups.push(cleanup);
      const child = new Component();
      child.register(cleanup);
      component.addChild(child);
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    live.stream(target, "draft");
    await live.flush(target);
    const draftButton = target.querySelector<HTMLButtonElement>("button")!;

    live.stream(target, "final");
    await live.flush(target);
    const streamedButton = target.querySelector<HTMLButtonElement>("button")!;
    expect(streamedButton).not.toBe(draftButton);
    expect(streamedButton.textContent).toBe("final");
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).not.toHaveBeenCalled();
    streamedButton.focus();

    await live.settle(target, "final");
    const finalButton = target.querySelector<HTMLButtonElement>("button")!;
    expect(finalButton).toBe(streamedButton);
    expect(document.activeElement).toBe(finalButton);
    expect(cleanups[1]).not.toHaveBeenCalled();
    expect(liveButtonAtCleanup[1]).toBeUndefined();
    expect(render.mock.calls.map(([markdown]) => markdown)).toEqual([
      "draft",
      "final",
    ]);

    draftButton.click();
    finalButton.click();
    expect(activations).toEqual(["final"]);

    await live.settle(target, "final");
    expect(target.querySelector("button")).toBe(finalButton);
    expect(render).toHaveBeenCalledTimes(2);
    expect(cleanups[1]).not.toHaveBeenCalled();
    expect((live as unknown as { children: Component[] }).children).toHaveLength(1);

    live.unload();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it("promotes an identical in-flight action render to the authoritative final subtree", async () => {
    const gate = deferred();
    const target = document.body.createDiv();
    const activations: string[] = [];
    const cleanup = jest.fn();
    const render = jest.fn(async (
      markdown: string,
      staging: HTMLElement,
      component: Component,
    ) => {
      await gate.promise;
      const button = staging.createEl("button", { text: markdown });
      const activate = () => activations.push(markdown);
      button.addEventListener("click", activate);
      const child = new Component();
      child.register(() => {
        button.removeEventListener("click", activate);
        cleanup();
      });
      component.addChild(child);
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    live.stream(target, "final");
    const completion = live.settle(target, "final");
    expect(render).toHaveBeenCalledTimes(1);

    gate.resolve();
    await completion;
    const button = target.querySelector<HTMLButtonElement>("button")!;
    button.click();
    expect(activations).toEqual(["final"]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();

    await live.settle(target, "final");
    expect(target.querySelector("button")).toBe(button);
    expect(render).toHaveBeenCalledTimes(1);

    live.unload();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("installs selector-free final behavior with its matching lease", async () => {
    const target = document.body.createDiv();
    const activations: string[] = [];
    const rendered: HTMLDivElement[] = [];
    const cleanups: jest.Mock[] = [];
    const live = new LiveMarkdownRenderer({
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const managed = staging.createDiv({
          cls: "custom-postprocessor-node",
          text: markdown,
        });
        rendered.push(managed);
        const activate = () => activations.push(markdown);
        managed.addEventListener("custom-activate", activate);
        const cleanup = jest.fn(() => {
          managed.removeEventListener("custom-activate", activate);
        });
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "final");
    await live.flush(target);
    expect(target.querySelector(".custom-postprocessor-node")).not.toBe(rendered[0]);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);

    await live.settle(target, "final");
    const finalNode = target.querySelector<HTMLDivElement>(
      ".custom-postprocessor-node",
    )!;
    expect(finalNode).toBe(rendered[1]);
    expect(cleanups[1]).not.toHaveBeenCalled();
    expect((live as unknown as { children: Component[] }).children).toHaveLength(1);

    finalNode.dispatchEvent(new Event("custom-activate"));
    expect(activations).toEqual(["final"]);

    live.unload();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it("keeps interactive stream leases bounded across many snapshots", async () => {
    const target = document.body.createDiv();
    const cleanups: jest.Mock[] = [];
    const live = new LiveMarkdownRenderer({
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        staging.createEl("button", { text: markdown });
        const cleanup = jest.fn();
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    for (let revision = 1; revision <= 20; revision += 1) {
      live.stream(target, String(revision));
      await live.flush(target);
      expect(target.textContent).toBe(String(revision));
      expect((live as unknown as { children: Component[] }).children).toHaveLength(1);
      expect(cleanups[revision - 1]).not.toHaveBeenCalled();
      if (revision > 1) {
        expect(cleanups[revision - 2]).toHaveBeenCalledTimes(1);
      }
    }

    live.unload();
    expect(cleanups[19]).toHaveBeenCalledTimes(1);
  });

  it("refreshes code behavior while preserving selection, focus, scroll, and copy state", async () => {
    const target = document.body.createDiv();
    const copied: string[] = [];
    const cleanups: jest.Mock[] = [];
    const buildCodeFence = (markdown: string, root: HTMLElement): HTMLButtonElement => {
      const pre = root.createEl("pre", { cls: "systemsculpt-agent-code-block" });
      pre.createEl("code", { text: markdown });
      return pre.createEl("button", {
        cls: "systemsculpt-agent-code-copy",
        text: "Copy",
        attr: {
          "aria-label": "Copy code",
          "data-focus-key": "copy-code",
        },
      });
    };
    const live = new LiveMarkdownRenderer({
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const button = buildCodeFence(markdown, staging);
        const activate = () => copied.push(
          button.parentElement?.querySelector("code")?.textContent ?? "",
        );
        button.addEventListener("click", activate);
        const cleanup = jest.fn(() => button.removeEventListener("click", activate));
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "const alpha = 1;");
    await live.flush(target);
    const pre = target.querySelector<HTMLPreElement>("pre")!;
    const code = target.querySelector<HTMLElement>("code")!;
    const codeText = code.firstChild!;
    const button = target.querySelector<HTMLButtonElement>("button")!;
    pre.scrollTop = 31;
    pre.scrollLeft = 9;
    button.classList.add("is-copied");
    button.setText("Copied");
    button.setAttribute("aria-label", "Copied");
    button.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(codeText, 0);
    range.setEnd(codeText, 5);
    selection.removeAllRanges();
    selection.addRange(range);

    const finalMarkdown = "const alpha = 12345;\nreturn alpha;";
    live.stream(target, finalMarkdown);
    await live.flush(target);

    const streamedPre = target.querySelector<HTMLPreElement>("pre")!;
    const streamedCode = target.querySelector<HTMLElement>("code")!;
    const streamedCodeText = streamedCode.firstChild!;
    const streamedButton = target.querySelector<HTMLButtonElement>("button")!;
    expect(streamedPre).not.toBe(pre);
    expect(streamedCode).not.toBe(code);
    expect(streamedCodeText).not.toBe(codeText);
    expect(streamedButton).not.toBe(button);
    expect(streamedCode.textContent).toBe(finalMarkdown);
    expect(selection.toString()).toBe("const");
    expect(selection.anchorNode).toBe(streamedCodeText);
    expect(document.activeElement).toBe(streamedButton);
    expect(streamedPre.scrollTop).toBe(31);
    expect(streamedPre.scrollLeft).toBe(9);
    expect(streamedButton.classList).toContain("is-copied");
    expect(streamedButton.textContent).toBe("Copied");
    streamedButton.click();
    expect(copied).toEqual([finalMarkdown]);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).not.toHaveBeenCalled();

    const expected = document.createElement("div");
    buildCodeFence(finalMarkdown, expected);
    await live.settle(target, finalMarkdown);
    const finalButton = target.querySelector<HTMLButtonElement>("button")!;
    expect(finalButton).toBe(streamedButton);
    expect(finalButton.classList).toContain("is-copied");
    expect(finalButton.textContent).toBe("Copied");
    expect(finalButton.getAttribute("aria-label")).toBe("Copied");
    expect(document.activeElement).toBe(finalButton);
    expect(selection.toString()).toBe("const");
    expect(target.querySelector("code")?.textContent).toBe(finalMarkdown);
    const normalized = target.cloneNode(true) as HTMLElement;
    const normalizedButton = normalized.querySelector<HTMLButtonElement>("button")!;
    normalizedButton.classList.remove("is-copied");
    normalizedButton.setText("Copy");
    normalizedButton.setAttribute("aria-label", "Copy code");
    expect(normalized.innerHTML).toBe(expected.innerHTML);
    expect(cleanups[1]).not.toHaveBeenCalled();

    live.unload();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it("refreshes linked callout behavior while preserving reader state", async () => {
    const target = document.body.createDiv();
    const activations: string[] = [];
    const cleanups: jest.Mock[] = [];
    const buildInteractive = (
      phase: number,
      root: HTMLElement,
    ): HTMLAnchorElement[] => {
      const callout = root.createDiv({
        cls: "callout",
        attr: { "data-callout": "note" },
      });
      callout.createDiv({
        cls: "callout-title",
        text: `Plan ${phase}`,
        attr: { "aria-expanded": "true" },
      });
      const list = callout.createEl("ul", { cls: "contains-task-list" });
      const first = list.createEl("li", { cls: "task-list-item" });
      first.createEl("input", {
        cls: "task-list-item-checkbox",
        attr: { type: "checkbox" },
      });
      const links = [first.createEl("a", {
        text: `Primary ${phase}`,
        attr: {
          href: `#primary-${phase}`,
          "data-focus-key": "primary-link",
        },
      })];
      if (phase >= 2) {
        const second = list.createEl("li", { cls: "task-list-item" });
        second.createEl("input", {
          cls: "task-list-item-checkbox",
          attr: { type: "checkbox" },
        });
        links.push(second.createEl("a", {
          text: `Secondary ${phase}`,
          attr: {
            href: `#secondary-${phase}`,
            "data-focus-key": "secondary-link",
          },
        }));
      }
      return links;
    };
    const live = new LiveMarkdownRenderer({
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const links = buildInteractive(Number(markdown), staging);
        const listeners = links.map((link) => {
          const activate = (event: Event) => {
            event.preventDefault();
            activations.push(link.getAttribute("href") ?? "");
          };
          link.addEventListener("click", activate);
          return { link, activate };
        });
        const cleanup = jest.fn(() => listeners.forEach(({ link, activate }) =>
          link.removeEventListener("click", activate)));
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "1");
    await live.flush(target);
    const callout = target.querySelector<HTMLElement>(".callout")!;
    const title = target.querySelector<HTMLElement>(".callout-title")!;
    const list = target.querySelector<HTMLUListElement>("ul")!;
    const firstItem = target.querySelector<HTMLLIElement>("li")!;
    const firstTask = target.querySelector<HTMLInputElement>("input")!;
    const firstLink = target.querySelector<HTMLAnchorElement>("a")!;
    callout.classList.add("is-collapsed");
    title.setAttribute("aria-expanded", "false");
    firstTask.checked = true;
    firstLink.focus();

    live.stream(target, "2");
    await live.flush(target);

    const phaseTwoCallout = target.querySelector<HTMLElement>(".callout")!;
    const phaseTwoTitle = target.querySelector<HTMLElement>(".callout-title")!;
    const phaseTwoTask = target.querySelector<HTMLInputElement>("input")!;
    const phaseTwoFirstLink = target.querySelector<HTMLAnchorElement>("a")!;
    expect(phaseTwoCallout).not.toBe(callout);
    expect(phaseTwoTitle).not.toBe(title);
    expect(target.querySelector("ul")).not.toBe(list);
    expect(target.querySelector("li")).not.toBe(firstItem);
    expect(phaseTwoTask).not.toBe(firstTask);
    expect(phaseTwoFirstLink).not.toBe(firstLink);
    expect(target.querySelectorAll("li")).toHaveLength(2);
    expect(phaseTwoFirstLink.textContent).toBe("Primary 2");
    expect(phaseTwoFirstLink.getAttribute("href")).toBe("#primary-2");
    expect(phaseTwoTask.checked).toBe(false);
    expect(phaseTwoCallout.classList).toContain("is-collapsed");
    expect(phaseTwoTitle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(phaseTwoFirstLink);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).not.toHaveBeenCalled();

    const secondItem = target.querySelectorAll("li")[1];
    const secondLink = target.querySelectorAll<HTMLAnchorElement>("a")[1];
    live.stream(target, "3");
    await live.flush(target);
    const phaseThreeCallout = target.querySelector<HTMLElement>(".callout")!;
    const phaseThreeTitle = target.querySelector<HTMLElement>(".callout-title")!;
    const phaseThreeTask = target.querySelector<HTMLInputElement>("input")!;
    const phaseThreeLinks = target.querySelectorAll<HTMLAnchorElement>("a");
    expect(target.querySelectorAll("li")[1]).not.toBe(secondItem);
    expect(phaseThreeLinks[1]).not.toBe(secondLink);
    firstLink.click();
    secondLink.click();
    phaseThreeLinks[0]?.click();
    phaseThreeLinks[1]?.click();
    expect(activations).toEqual(["#primary-3", "#secondary-3"]);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
    expect(cleanups[2]).not.toHaveBeenCalled();

    phaseThreeCallout.classList.remove("is-collapsed");
    phaseThreeTitle.setAttribute("aria-expanded", "true");
    phaseThreeTask.checked = false;
    const expected = document.createElement("div");
    buildInteractive(3, expected);
    await live.settle(target, "3");
    expect(target.innerHTML).toBe(expected.innerHTML);
    expect(target.querySelector(".callout")).toBe(phaseThreeCallout);
    expect(target.querySelector("a")).toBe(phaseThreeLinks[0]);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
    expect(cleanups[2]).not.toHaveBeenCalled();

    live.unload();
    expect(cleanups[2]).toHaveBeenCalledTimes(1);
  });

  it("waits for the newest parse when an older first frame finishes", async () => {
    const gates = [deferred(), deferred()];
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      const gate = gates[render.mock.calls.length - 1];
      await gate.promise;
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    live.stream(target, "old");
    live.stream(target, "new");
    expect(target.childNodes).toHaveLength(0);

    const completion = live.flush(target);
    gates[0].resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(render).toHaveBeenCalledTimes(2);
    expect(target.childNodes).toHaveLength(0);

    gates[1].resolve();
    await completion;
    expect(target.textContent).toBe("rendered:new");
    live.unload();
  });

  it("keeps parsed Markdown visible while a newer appended snapshot renders", async () => {
    const gates = [deferred(), deferred()];
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      const gate = gates[render.mock.calls.length - 1];
      await gate.promise;
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    live.stream(target, "Hello");
    live.stream(target, "Hello world");
    const completion = live.flush(target);

    gates[0].resolve();
    await jest.advanceTimersByTimeAsync(0);
    const paragraph = target.querySelector("p")!;
    const parsedPrefix = paragraph.firstChild;
    expect(target.textContent).toBe("rendered:Hello");
    expect(paragraph.childNodes).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(2);

    gates[1].resolve();
    await completion;
    expect(target.querySelector("p")).toBe(paragraph);
    expect(target.querySelector("p")?.firstChild).toBe(parsedPrefix);
    expect(target.querySelector("p")?.childNodes).toHaveLength(1);
    expect(target.textContent).toBe("rendered:Hello world");
    live.unload();
  });

  it("waits for current parsed frames without exposing raw snapshots", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      const gate = gates[render.mock.calls.length - 1];
      await gate.promise;
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({ render, throttleMs: 0 });
    live.load();

    live.stream(target, "one");
    live.stream(target, "two");
    gates[0].resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(target.childNodes).toHaveLength(0);
    expect(render).toHaveBeenCalledTimes(2);

    live.stream(target, "three");
    gates[1].resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(target.childNodes).toHaveLength(0);
    expect(render).toHaveBeenCalledTimes(3);

    const completion = live.flush(target);
    gates[2].resolve();
    await completion;
    expect(target.textContent).toBe("rendered:three");
    live.unload();
  });

  it("reuses an identical committed final render and exposes newer raw Markdown on failure", async () => {
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      if (markdown === "broken") throw new Error("postprocessor failed");
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    await live.settle(target, "ready");
    await live.settle(target, "ready");
    expect(render).toHaveBeenCalledTimes(1);

    const broken = live.settle(target, "broken");
    await expect(broken).rejects.toThrow(
      "postprocessor failed",
    );
    expect(target.textContent).toBe("broken");

    await live.settle(target, "ready");
    expect(target.textContent).toBe("rendered:ready");
    expect(render).toHaveBeenCalledTimes(3);
    live.unload();
  });

  it("keeps raw final Markdown visible when the first settled render fails", async () => {
    const target = document.body.createDiv();
    const live = new LiveMarkdownRenderer({
      render: async () => {
        throw new Error("postprocessor failed");
      },
    });
    live.load();

    const completion = live.settle(target, "**Recovered response**");
    const rejection = expect(completion).rejects.toThrow("postprocessor failed");
    expect(target.childNodes).toHaveLength(0);
    await rejection;
    expect(target.textContent).toBe("**Recovered response**");
    expect(target.classList).toContain("is-live-markdown-fallback");
    live.unload();
  });

  it("updates compatible blocks in place while preserving selection", () => {
    const target = document.body.createDiv();
    target.innerHTML = "<p>Stable</p><p>Alpha beta</p>";
    const staging = document.body.createDiv();
    staging.innerHTML = "<p>Stable</p><p>Alpha gamma</p>";
    const stableBlock = target.children[0];
    const changedBlock = target.children[1];
    const changedText = changedBlock.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(changedText, 0);
    range.setEnd(changedText, 5);
    selection.removeAllRanges();
    selection.addRange(range);

    reconcileLiveMarkdownDom(target, staging);

    expect(target.children[0]).toBe(stableBlock);
    expect(target.children[1]).toBe(changedBlock);
    expect(target.children[1].firstChild).toBe(changedText);
    expect(target.textContent).toBe("StableAlpha gamma");
    expect(selection.toString()).toBe("Alpha");
    expect(selection.anchorNode).toBe(changedText);
    expect(selection.focusNode).toBe(changedText);
  });

  it("skips recursive reconciliation for exact-equal top-level blocks", () => {
    const target = document.body.createDiv();
    target.innerHTML = [
      '<section><span data-probe="stable">Static</span></section>',
      "<p>old tail</p>",
    ].join("");
    const staging = document.body.createDiv();
    staging.innerHTML = [
      '<section><span data-probe="stable">Static</span></section>',
      "<p>new tail</p>",
    ].join("");
    const stable = target.querySelector<HTMLElement>("section")!;
    const probe = stable.querySelector<HTMLElement>("[data-probe]")!;
    const readAttribute = jest.spyOn(probe, "getAttribute");

    reconcileLiveMarkdownDom(target, staging);

    expect(target.querySelector("section")).toBe(stable);
    expect(readAttribute).not.toHaveBeenCalled();
    expect(target.textContent).toBe("Staticnew tail");
    readAttribute.mockRestore();
  });

  it("preserves focused code controls, copied state, and code scroll in place", () => {
    const target = document.body.createDiv();
    target.innerHTML = [
      "<pre>",
      "<code>old code</code>",
      '<button class="systemsculpt-agent-code-copy is-copied"',
      ' data-focus-key="copy-code" aria-label="Copied">Copied</button>',
      "</pre>",
    ].join("");
    const staging = document.body.createDiv();
    staging.innerHTML = [
      "<pre>",
      "<code>new code</code>",
      '<button class="systemsculpt-agent-code-copy"',
      ' data-focus-key="copy-code" aria-label="Copy code">Copy</button>',
      "</pre>",
    ].join("");
    const pre = target.querySelector<HTMLPreElement>("pre")!;
    const button = target.querySelector<HTMLButtonElement>("button")!;
    pre.scrollTop = 42;
    pre.scrollLeft = 7;
    button.focus();

    reconcileLiveMarkdownDom(target, staging);

    expect(target.querySelector("pre")).toBe(pre);
    expect(target.querySelector("button")).toBe(button);
    expect(target.querySelector("code")?.textContent).toBe("new code");
    expect(button.classList).toContain("is-copied");
    expect(button.textContent).toBe("Copied");
    expect(button.getAttribute("aria-label")).toBe("Copied");
    expect(document.activeElement).toBe(button);
    expect(pre.scrollTop).toBe(42);
    expect(pre.scrollLeft).toBe(7);
  });

  it("preserves disclosure and folded-callout nodes while their content grows", () => {
    const target = document.body.createDiv();
    target.innerHTML = [
      "<details open>",
      '<summary data-focus-key="reasoning">Reasoning</summary>',
      '<div class="callout is-collapsed">',
      '<div class="callout-title" aria-expanded="false">Note</div>',
      "<p>old</p>",
      "</div>",
      "</details>",
    ].join("");
    const staging = document.body.createDiv();
    staging.innerHTML = [
      "<details>",
      '<summary data-focus-key="reasoning">Reasoning</summary>',
      '<div class="callout">',
      '<div class="callout-title" aria-expanded="true">Note</div>',
      "<p>new</p>",
      "</div>",
      "</details>",
    ].join("");
    const originalDetails = target.querySelector("details")!;
    target.querySelector<HTMLElement>("summary")!.focus();

    reconcileLiveMarkdownDom(target, staging);

    const details = target.querySelector<HTMLDetailsElement>("details")!;
    const callout = target.querySelector<HTMLElement>(".callout")!;
    expect(details).toBe(originalDetails);
    expect(details.open).toBe(true);
    expect(callout.classList).toContain("is-collapsed");
    expect(
      callout.querySelector(".callout-title")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(callout.textContent).toContain("new");
    expect(document.activeElement).toBe(
      target.querySelector('[data-focus-key="reasoning"]'),
    );
  });

  it("keeps one render lease per target and disposes it across removal and recreation", async () => {
    const wrapper = document.body.createDiv();
    const target = wrapper.createDiv();
    const cleanups: jest.Mock[] = [];
    const render = jest.fn(async (
      markdown: string,
      staging: HTMLElement,
      component: Component,
    ) => {
      const cleanup = jest.fn();
      cleanups.push(cleanup);
      const child = new Component();
      child.register(cleanup);
      component.addChild(child);
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    await live.settle(target, "one");
    expect(cleanups[0]).not.toHaveBeenCalled();
    await live.settle(target, "two");
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).not.toHaveBeenCalled();
    expect((live as unknown as { children: Component[] }).children).toHaveLength(1);

    live.forget(wrapper);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
    expect((live as unknown as { children: Component[] }).children).toHaveLength(0);
    live.unload();

    const recreated = new LiveMarkdownRenderer({
      render: async (markdown, staging) => {
        renderParagraph(markdown, staging);
      },
    });
    recreated.load();
    await recreated.settle(target, "after reload");
    expect(target.textContent).toBe("rendered:after reload");
    recreated.unload();
  });

  it("moves lifecycle-managed Markdown nodes with their newest render lease", async () => {
    const target = document.body.createDiv();
    const activations: string[] = [];
    const cleanups: jest.Mock[] = [];
    const live = new LiveMarkdownRenderer({
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        const action = staging.createEl("button", {
          text: markdown,
          attr: { "data-focus-key": "managed-action" },
        });
        const activate = () => activations.push(markdown);
        action.addEventListener("click", activate);
        const cleanup = jest.fn(() => {
          action.removeEventListener("click", activate);
        });
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    await live.settle(target, "first");
    const first = target.querySelector<HTMLButtonElement>("button")!;
    first.focus();
    first.click();
    expect(activations).toEqual(["first"]);

    await live.settle(target, "second");
    const second = target.querySelector<HTMLButtonElement>("button")!;

    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(document.activeElement).toBe(second);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);

    first.click();
    second.click();
    expect(activations).toEqual(["first", "second"]);

    live.unload();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it("installs direct postprocessor behavior from the newest staging subtree", async () => {
    const target = document.body.createDiv();
    const activations: string[] = [];
    const live = new LiveMarkdownRenderer({
      render: async (markdown, staging) => {
        const action = staging.createEl("button", { text: markdown });
        action.addEventListener("click", () => activations.push(markdown));
      },
    });
    live.load();

    await live.settle(target, "first");
    const first = target.querySelector<HTMLButtonElement>("button")!;
    await live.settle(target, "second");
    const second = target.querySelector<HTMLButtonElement>("button")!;

    expect(second).not.toBe(first);
    second.click();
    expect(activations).toEqual(["second"]);
    live.unload();
  });
  it("finds the last boundary that no later text can change", () => {
    expect(stableMarkdownBoundary("")).toBe(0);
    expect(stableMarkdownBoundary("One")).toBe(0);
    expect(stableMarkdownBoundary("One\n\nTwo")).toBe(5);
    expect(stableMarkdownBoundary("One\n\nTwo\n\nThr")).toBe(10);
    expect(stableMarkdownBoundary("One\n\n")).toBe(0);
    expect(stableMarkdownBoundary("One\n\n  indented continuation")).toBe(0);
    expect(stableMarkdownBoundary("One\nTwo")).toBe(0);
    expect(stableMarkdownBoundary("\n\nOne")).toBe(0);

    const fenced = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;";
    expect(stableMarkdownBoundary(fenced)).toBe(7);
    expect(stableMarkdownBoundary(`${fenced}\n\`\`\`\n\nAfter`)).toBe(fenced.length + 6);
    expect(stableMarkdownBoundary("~~~~\na\n\n```\n\nb")).toBe(0);
    expect(stableMarkdownBoundary("~~~~\na\n~~~~\n\nb")).toBe(13);
    expect(stableMarkdownBoundary("```js```\n\nNext")).toBe(10);

    expect(stableMarkdownBoundary("- a\n- b\n\n- c")).toBe(0);
    expect(stableMarkdownBoundary("Intro\n- a\n\n1. b")).toBe(0);
    expect(stableMarkdownBoundary("- a\n\n  more of a\n\n- b")).toBe(0);
    expect(stableMarkdownBoundary("Intro\n\n- a\n- b")).toBe(7);
    expect(stableMarkdownBoundary("- a\n- b\n\nAfter")).toBe(9);
    expect(stableMarkdownBoundary("- a\n\nAfter\n\n- b")).toBe(12);
    expect(stableMarkdownBoundary("- a\n\n1")).toBe(0);
    expect(stableMarkdownBoundary("- a\n\n2024 was")).toBe(5);

    expect(stableMarkdownBoundary("$$\na\n\nb")).toBe(0);
    expect(stableMarkdownBoundary("$$\na\n\nb\n$$\n\nc")).toBe(12);
    expect(stableMarkdownBoundary("Inline $$x$$ math\n\nNext")).toBe(19);
    expect(stableMarkdownBoundary("%%\nhidden\n\nhidden\n%%\n\nShown")).toBe(22);
    expect(stableMarkdownBoundary("%%\nhidden\n\nhidden")).toBe(0);
    expect(stableMarkdownBoundary("<!--\nhidden\n\nhidden")).toBe(0);
    expect(stableMarkdownBoundary("<!--\nhidden\n\n-->\n\nShown")).toBe(18);

    const text = "Settled\n\nMore\n\nTail";
    expect(stableMarkdownBoundary(text, 9)).toBe(15);
    expect(stableMarkdownBoundary(text, 15)).toBe(15);
  });

  it("keeps render work linear in the length of a long streamed response", async () => {
    const markdown = longStreamedResponse(240);
    const target = document.body.createDiv();
    const rendered: string[] = [];
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (chunk, staging) => {
        rendered.push(chunk);
        renderBlocks(chunk, staging);
      },
    });
    live.load();

    for (let end = 12; end < markdown.length + 12; end += 12) {
      live.stream(target, markdown.slice(0, Math.min(end, markdown.length)));
      await live.flush(target);
    }
    const streamedCharacters = rendered.reduce((total, chunk) => total + chunk.length, 0);
    const streamedCalls = rendered.length;
    const frames = Math.ceil(markdown.length / 12);
    // Rendering every frame's full prefix would parse about
    // frames * length / 2 characters (roughly 2.2 million here).
    expect(streamedCharacters).toBeLessThan(markdown.length * 12);
    expect(streamedCalls).toBeLessThan(frames + 260);
    expect(target.querySelectorAll("pre")).toHaveLength(24);
    expect(target.querySelectorAll("a")).toHaveLength(24);

    const renderedBeforeSettle = rendered.length;
    await live.settle(target, markdown);
    expect(rendered.slice(renderedBeforeSettle)).toEqual([markdown]);
    const expected = document.createElement("div");
    renderBlocks(markdown, expected);
    expect(target.innerHTML).toBe(expected.innerHTML);
    live.unload();
  });

  it("parses each completed block once and leaves its nodes and lease mounted", async () => {
    const target = document.body.createDiv();
    const rendered: string[] = [];
    const cleanups = new Map<string, jest.Mock>();
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (chunk, staging, component) => {
        rendered.push(chunk);
        renderBlocks(chunk, staging);
        const cleanup = jest.fn();
        cleanups.set(chunk, cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "[Docs](#docs)\n\nTa");
    await live.flush(target);
    const link = target.querySelector("a")!;
    const tail = target.querySelector("p:last-child")!;
    expect(rendered).toEqual(["[Docs](#docs)\n\n", "Ta"]);

    for (const markdown of [
      "[Docs](#docs)\n\nTail",
      "[Docs](#docs)\n\nTail grows",
      "[Docs](#docs)\n\nTail grows.",
    ]) {
      live.stream(target, markdown);
      await live.flush(target);
      expect(target.querySelector("a")).toBe(link);
      expect(target.querySelector("p:last-child")).toBe(tail);
    }
    expect(tail.textContent).toBe("Tail grows.");
    expect(rendered).toEqual([
      "[Docs](#docs)\n\n",
      "Ta",
      "Tail",
      "Tail grows",
      "Tail grows.",
    ]);
    expect(cleanups.get("[Docs](#docs)\n\n")).not.toHaveBeenCalled();
    expect(cleanups.get("Tail grows")).toHaveBeenCalledTimes(1);
    expect((live as unknown as { children: Component[] }).children).toHaveLength(1);

    await live.settle(target, "[Docs](#docs)\n\nTail grows.");
    expect(rendered[rendered.length - 1]).toBe("[Docs](#docs)\n\nTail grows.");
    expect(target.querySelector("a")).not.toBe(link);
    expect(cleanups.get("[Docs](#docs)\n\n")).toHaveBeenCalledTimes(1);
    expect(cleanups.get("[Docs](#docs)\n\nTail grows.")).not.toHaveBeenCalled();
    expect((live as unknown as { children: Component[] }).children).toHaveLength(1);

    live.unload();
    expect(cleanups.get("[Docs](#docs)\n\nTail grows.")).toHaveBeenCalledTimes(1);
  });

  it("keeps selection and focus when the open block is settled", async () => {
    const target = document.body.createDiv();
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (chunk, staging) => renderBlocks(chunk, staging),
    });
    live.load();

    live.stream(target, "Intro\n\n```ts\nconst alpha = 1;\n```");
    await live.flush(target);
    const intro = target.querySelector("p")!;
    const copy = target.querySelector<HTMLButtonElement>("button")!;
    copy.classList.add("is-copied");
    copy.setText("Copied");
    copy.focus();
    const codeText = target.querySelector("code")!.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(codeText, 6);
    range.setEnd(codeText, 11);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("alpha");

    live.stream(target, "Intro\n\n```ts\nconst alpha = 1;\n```\n\nAfter");
    await live.flush(target);

    const settledCopy = target.querySelector<HTMLButtonElement>("button")!;
    expect(target.querySelector("p")).toBe(intro);
    expect(settledCopy).not.toBe(copy);
    expect(document.activeElement).toBe(settledCopy);
    expect(settledCopy.classList).toContain("is-copied");
    expect(settledCopy.textContent).toBe("Copied");
    expect(selection.toString()).toBe("alpha");
    expect(target.textContent).toBe("Introconst alpha = 1;CopiedAfter");

    live.stream(target, "Intro\n\n```ts\nconst alpha = 1;\n```\n\nAfter more");
    await live.flush(target);
    expect(target.querySelector("button")).toBe(settledCopy);
    expect(document.activeElement).toBe(settledCopy);
    expect(selection.toString()).toBe("alpha");
    live.unload();
  });

  it("parses the whole message again when streamed text stops extending the settled blocks", async () => {
    const target = document.body.createDiv();
    const rendered: string[] = [];
    const cleanups: jest.Mock[] = [];
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (chunk, staging, component) => {
        rendered.push(chunk);
        renderBlocks(chunk, staging);
        const cleanup = jest.fn();
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "[One](#one)\n\nTwo");
    await live.flush(target);
    expect(rendered).toEqual(["[One](#one)\n\n", "Two"]);
    expect(cleanups[0]).not.toHaveBeenCalled();

    live.stream(target, "Rewritten\n\nTail");
    await live.flush(target);
    expect(rendered.slice(2)).toEqual(["Rewritten\n\n", "Tail"]);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(target.textContent).toBe("RewrittenTail");
    expect(target.querySelector("a")).toBeNull();

    live.stream(target, "Rewritten");
    await live.flush(target);
    expect(rendered[rendered.length - 1]).toBe("Rewritten");
    expect(target.textContent).toBe("Rewritten");
    expect((live as unknown as { children: Component[] }).children).toHaveLength(0);
    live.unload();
  });

  it("does not reuse a streamed frame with settled blocks as the final render", async () => {
    const target = document.body.createDiv();
    const rendered: string[] = [];
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (chunk, staging) => {
        rendered.push(chunk);
        renderBlocks(chunk, staging);
      },
    });
    live.load();

    live.stream(target, "[One](#one)\n\n[Two](#two)");
    await live.flush(target);
    expect(rendered).toEqual(["[One](#one)\n\n", "[Two](#two)"]);

    await live.settle(target, "[One](#one)\n\n[Two](#two)");
    expect(rendered).toEqual([
      "[One](#one)\n\n",
      "[Two](#two)",
      "[One](#one)\n\n[Two](#two)",
    ]);
    await live.settle(target, "[One](#one)\n\n[Two](#two)");
    expect(rendered).toHaveLength(3);
    live.unload();
  });

  it("measures the throttle from the end of the previous parse", async () => {
    const origin = Date.now();
    const target = document.body.createDiv();
    const started: number[] = [];
    const live = new LiveMarkdownRenderer({
      throttleMs: 48,
      render: async (markdown, staging) => {
        started.push(Date.now() - origin);
        // Each parse takes 100 ms of main-thread time.
        jest.setSystemTime(Date.now() + 100);
        renderParagraph(markdown, staging);
      },
    });
    live.load();

    live.stream(target, "a");
    await jest.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0]);

    // The parse ended at 100 and took 100 ms, so the next one waits until 200
    // rather than starting 48 ms after the previous start.
    live.stream(target, "ab");
    live.stream(target, "abc");
    await jest.advanceTimersByTimeAsync(99);
    expect(started).toEqual([0]);
    await jest.advanceTimersByTimeAsync(1);
    expect(started).toEqual([0, 200]);
    expect(target.textContent).toBe("rendered:abc");

    // A fast parse falls back to the configured interval after it ends.
    live.stream(target, "abcd");
    await jest.advanceTimersByTimeAsync(99);
    expect(started).toEqual([0, 200]);
    await jest.advanceTimersByTimeAsync(1);
    expect(started).toEqual([0, 200, 400]);
    live.unload();
  });

  it("forgets settled block leases with the target", async () => {
    const wrapper = document.body.createDiv();
    const target = wrapper.createDiv();
    const cleanups: jest.Mock[] = [];
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (chunk, staging, component) => {
        renderBlocks(chunk, staging);
        const cleanup = jest.fn();
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "[One](#one)\n\n[Two](#two)\n\nTail");
    await live.flush(target);
    expect((live as unknown as { children: Component[] }).children).toHaveLength(1);

    live.forget(wrapper);
    expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    expect((live as unknown as { children: Component[] }).children).toHaveLength(0);
    live.unload();
  });

  it("parses the whole message when something else replaced settled nodes", async () => {
    const target = document.body.createDiv();
    const rendered: string[] = [];
    const live = new LiveMarkdownRenderer({
      throttleMs: 0,
      render: async (chunk, staging) => {
        rendered.push(chunk);
        renderBlocks(chunk, staging);
      },
    });
    live.load();

    live.stream(target, "One\n\nTwo");
    await live.flush(target);
    target.empty();

    live.stream(target, "One\n\nTwo more");
    await live.flush(target);
    expect(rendered.slice(2)).toEqual(["One\n\n", "Two more"]);
    expect(target.textContent).toBe("OneTwo more");
    live.unload();
  });
});
