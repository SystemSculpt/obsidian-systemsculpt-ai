/**
 * @jest-environment jsdom
 */

import { applyTreeLayout, rebuildTreeConnectors } from "../treeConnectors";

describe("treeConnectors", () => {
  const createLinesContainer = () => {
    const container = document.createElement("div");
    container.classList.add("systemsculpt-chat-structured-lines");
    return container;
  };

  const createLine = (container: HTMLElement, depth: number, text: string, visible: boolean = true) => {
    const line = document.createElement("div");
    line.className = "systemsculpt-chat-structured-line";
    if (!visible) {
      line.style.display = "none";
    }
    line.dataset.treeDepth = String(depth);

    const prefix = document.createElement("span");
    prefix.className = "systemsculpt-chat-structured-line-prefix";
    line.appendChild(prefix);

    const textEl = document.createElement("span");
    textEl.className = "systemsculpt-chat-structured-line-text";
    textEl.textContent = text;
    line.appendChild(textEl);

    container.appendChild(line);

    return { line, prefix };
  };

  test("lays out connectors for a single-depth tree", () => {
    const container = createLinesContainer();
    const a = createLine(container, 1, "A");
    const b = createLine(container, 1, "B");
    const c = createLine(container, 1, "C");

    rebuildTreeConnectors(container);

    expect(a.prefix.textContent).toBe("├── ");
    expect(a.line.dataset.treeConnector).toBe("branch");

    expect(b.prefix.textContent).toBe("├── ");
    expect(b.line.dataset.treeConnector).toBe("branch");

    expect(c.prefix.textContent).toBe("└── ");
    expect(c.line.dataset.treeConnector).toBe("end");
  });

  test("lays out nested connectors across depths", () => {
    const container = createLinesContainer();
    const topA = createLine(container, 1, "Root A");
    const childA1 = createLine(container, 2, "Child A1");
    const childA2 = createLine(container, 2, "Child A2");
    const topB = createLine(container, 1, "Root B");

    rebuildTreeConnectors(container);

    expect(topA.prefix.textContent).toBe("├── ");
    expect(childA1.prefix.textContent).toBe("│   ├── ");
    expect(childA2.prefix.textContent).toBe("│   └── ");
    expect(topB.prefix.textContent).toBe("└── ");
  });

  test("skips hidden lines when computing connectors", () => {
    const container = createLinesContainer();
    const first = createLine(container, 1, "Visible A");
    const hidden = createLine(container, 1, "Hidden", false);
    const last = createLine(container, 1, "Visible B");

    rebuildTreeConnectors(container);

    expect(first.prefix.textContent).toBe("├── ");
    expect(last.prefix.textContent).toBe("└── ");
    expect(hidden.prefix.textContent).toBe("");
  });

  test("forceEnd option renders all connectors as end branches", () => {
    const container = createLinesContainer();
    const a = createLine(container, 1, "Segment A");
    const b = createLine(container, 1, "Segment B");

    applyTreeLayout(
      [
        { lineEl: a.line, prefixEl: a.prefix, depth: 1 },
        { lineEl: b.line, prefixEl: b.prefix, depth: 1 },
      ],
      { forceEnd: true }
    );

    expect(a.prefix.textContent).toBe("└── ");
    expect(b.prefix.textContent).toBe("└── ");
    expect(a.line.dataset.treeConnector).toBe("end");
    expect(b.line.dataset.treeConnector).toBe("end");
  });
});
