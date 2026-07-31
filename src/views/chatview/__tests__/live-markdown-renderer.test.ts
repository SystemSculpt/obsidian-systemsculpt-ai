/**
 * @jest-environment jsdom
 */

import { Component } from "obsidian";
import {
  LiveMarkdownRenderer,
  reconcileLiveMarkdownDom,
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

describe("LiveMarkdownRenderer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.empty();
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.empty();
  });

  it("shows the newest raw snapshot immediately, then commits detached Markdown", async () => {
    const gate = deferred();
    const target = document.body.createDiv();
    const render = jest.fn(async (markdown: string, staging: HTMLElement) => {
      await gate.promise;
      renderParagraph(markdown, staging);
    });
    const live = new LiveMarkdownRenderer({ render });
    live.load();

    live.stream(target, "**Hello**");
    expect(target.textContent).toBe("**Hello**");
    expect(target.classList).toContain("is-live-markdown-fallback");
    expect(render).toHaveBeenCalledTimes(1);

    const completion = live.flush(target);
    gate.resolve();
    await completion;

    expect(target.innerHTML).toBe("<p>rendered:**Hello**</p>");
    expect(target.classList).not.toContain("is-live-markdown-fallback");
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

  it("reconciles ordinary streamed Markdown in place and installs one authoritative final lease", async () => {
    const target = document.body.createDiv();
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
    expect(render).toHaveBeenCalledTimes(3);
    expect(cleanups[2]).not.toHaveBeenCalled();

    live.unload();
    expect(cleanups[2]).toHaveBeenCalledTimes(1);
  });

  it("reconciles interactive streamed Markdown without replacing its live node", async () => {
    const target = document.body.createDiv();
    const cleanups: jest.Mock[] = [];
    const live = new LiveMarkdownRenderer({
      render: async (
        markdown: string,
        staging: HTMLElement,
        component: Component,
      ) => {
        staging.createEl("a", { text: markdown, href: "#target" });
        const cleanup = jest.fn();
        cleanups.push(cleanup);
        const child = new Component();
        child.register(cleanup);
        component.addChild(child);
      },
    });
    live.load();

    live.stream(target, "one");
    await live.flush(target);
    const first = target.querySelector("a");
    expect(cleanups[0]).not.toHaveBeenCalled();

    live.stream(target, "two");
    await live.flush(target);
    expect(target.querySelector("a")).toBe(first);
    expect(target.textContent).toBe("two");
    expect(cleanups[0]).not.toHaveBeenCalled();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);

    live.unload();
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
  });

  it("grows a leased code fence without losing node, selection, focus, scroll, or copy state", async () => {
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

    expect(target.querySelector("pre")).toBe(pre);
    expect(target.querySelector("code")).toBe(code);
    expect(code.firstChild).toBe(codeText);
    expect(target.querySelector("button")).toBe(button);
    expect(code.textContent).toBe(finalMarkdown);
    expect(selection.toString()).toBe("const");
    expect(selection.anchorNode).toBe(codeText);
    expect(document.activeElement).toBe(button);
    expect(pre.scrollTop).toBe(31);
    expect(pre.scrollLeft).toBe(9);
    expect(button.classList).toContain("is-copied");
    expect(button.textContent).toBe("Copied");
    button.click();
    expect(copied).toEqual([finalMarkdown]);
    expect(cleanups[0]).not.toHaveBeenCalled();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);

    const expected = document.createElement("div");
    buildCodeFence(finalMarkdown, expected);
    await live.settle(target, finalMarkdown);
    const finalButton = target.querySelector<HTMLButtonElement>("button")!;
    expect(finalButton).not.toBe(button);
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
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[2]).not.toHaveBeenCalled();

    live.unload();
    expect(cleanups[2]).toHaveBeenCalledTimes(1);
  });

  it("grows linked task and callout content without remounting prior interactive nodes", async () => {
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

    expect(target.querySelector(".callout")).toBe(callout);
    expect(target.querySelector(".callout-title")).toBe(title);
    expect(target.querySelector("ul")).toBe(list);
    expect(target.querySelector("li")).toBe(firstItem);
    expect(target.querySelector("input")).toBe(firstTask);
    expect(target.querySelector("a")).toBe(firstLink);
    expect(target.querySelectorAll("li")).toHaveLength(2);
    expect(firstLink.textContent).toBe("Primary 2");
    expect(firstLink.getAttribute("href")).toBe("#primary-2");
    expect(firstTask.checked).toBe(true);
    expect(callout.classList).toContain("is-collapsed");
    expect(title.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(firstLink);
    expect(cleanups[0]).not.toHaveBeenCalled();
    expect(cleanups[1]).not.toHaveBeenCalled();

    const secondItem = target.querySelectorAll("li")[1];
    const secondLink = target.querySelectorAll<HTMLAnchorElement>("a")[1];
    live.stream(target, "3");
    await live.flush(target);
    expect(target.querySelectorAll("li")[1]).toBe(secondItem);
    expect(target.querySelectorAll("a")[1]).toBe(secondLink);
    firstLink.click();
    secondLink.click();
    expect(activations).toEqual(["#primary-3", "#secondary-3"]);
    expect(cleanups[2]).toHaveBeenCalledTimes(1);

    callout.classList.remove("is-collapsed");
    title.setAttribute("aria-expanded", "true");
    firstTask.checked = false;
    const expected = document.createElement("div");
    buildInteractive(3, expected);
    await live.settle(target, "3");
    expect(target.innerHTML).toBe(expected.innerHTML);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
    expect(cleanups[3]).not.toHaveBeenCalled();

    live.unload();
    expect(cleanups[3]).toHaveBeenCalledTimes(1);
  });

  it("commits parsed intermediate frames during continuous input and settles the newest revision", async () => {
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
    expect(target.textContent).toBe("new");

    const completion = live.flush(target);
    gates[0].resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(render).toHaveBeenCalledTimes(2);
    expect(target.textContent).toBe("rendered:old");

    gates[1].resolve();
    await completion;
    expect(target.textContent).toBe("rendered:new");
    live.unload();
  });

  it("does not wait for a quiet token gap before showing parsed Markdown", async () => {
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

    expect(target.textContent).toBe("rendered:one");
    expect(render).toHaveBeenCalledTimes(2);

    live.stream(target, "three");
    gates[1].resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(target.textContent).toBe("rendered:two");
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

    await expect(live.settle(target, "broken")).rejects.toThrow(
      "postprocessor failed",
    );
    expect(target.textContent).toBe("broken");
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
    expect(target.textContent).toBe("**Recovered response**");
    await expect(completion).rejects.toThrow("postprocessor failed");
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
});
