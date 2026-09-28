/** @jest-environment jsdom */
import { renderStudioActivityBadge, updateStudioActivityBadge } from "../StudioActivityBadge";
import { createNodeActivity, IDLE_NODE_ACTIVITY } from "../StudioActivity";

describe("renderStudioActivityBadge", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("renders a hidden idle row that shows once activity arrives", () => {
    const root = document.body.createDiv();
    const row = renderStudioActivityBadge(root, { activity: IDLE_NODE_ACTIVITY });
    expect(row.getAttribute("role")).toBe("status");
    expect(row.hidden).toBe(true);
    expect(row.dataset.activity).toBe("idle");

    updateStudioActivityBadge(row, createNodeActivity("waiting", { detail: "Waiting for native approval" }));
    expect(row.hidden).toBe(false);
    expect(row.dataset.activity).toBe("waiting");
    expect(row.querySelector(".ss-studio-node-activity-label")?.textContent).toBe("Waiting");
    expect(row.querySelector(".ss-studio-node-activity-detail")?.textContent).toBe("Waiting for native approval");
    expect(row.title).toBe("Waiting: Waiting for native approval");
    expect(row.getAttribute("aria-label")).toBe("Waiting: Waiting for native approval");
  });

  it("keeps a node note visible while idle and honors its tone", () => {
    const root = document.body.createDiv();
    const row = renderStudioActivityBadge(root, { activity: IDLE_NODE_ACTIVITY, note: { text: "Desktop only", tone: "warning", title: "Needs a desktop host" } });
    expect(row.hidden).toBe(false);
    const note = row.querySelector<HTMLElement>(".ss-studio-node-badge")!;
    expect(note.classList.contains("is-warning")).toBe(true);
    expect(note.textContent).toBe("Desktop only");
    expect(note.title).toBe("Needs a desktop host");
    updateStudioActivityBadge(row, createNodeActivity("done"));
    updateStudioActivityBadge(row, IDLE_NODE_ACTIVITY);
    expect(row.hidden).toBe(false);
  });

  it("formats determinate progress as a percentage", () => {
    const root = document.body.createDiv();
    const row = renderStudioActivityBadge(root, { activity: createNodeActivity("active", { progress: 0.666 }) });
    expect(row.querySelector(".ss-studio-node-activity-progress")?.textContent).toBe("67%");
  });
});
