/** @jest-environment jsdom */
import { App } from "obsidian";
import { applyPluginSurface } from "../../../core/ui/surface";
import { AgentPhoneHandoffCards, type PhoneHandoffPresentation } from "../AgentPhoneHandoffCards";

const host = { localCli: true };
jest.mock("../../../platform/hostCapabilities", () => ({
  ...jest.requireActual("../../../platform/hostCapabilities"),
  hasHostCapability: (capability: string) => capability === "local-cli" && host.localCli,
}));
beforeEach(() => { host.localCli = true; });

function item(overrides: Partial<PhoneHandoffPresentation> = {}): PhoneHandoffPresentation {
  return {
    id: "phone-one",
    instruction: "Turn these notes into a launch checklist.",
    agent: "claude_code",
    source: { title: "Launch notes", markdown: "# Launch\n\nConfirm the printer delivery.", path: "Inbox/Launch.md" },
    state: "pending",
    ...overrides,
  };
}

function setup(owner = document, callbacks: {
  onRun?: (id: string) => void | Promise<void>;
  onOpenSource?: (path: string) => void | Promise<void>;
} = {}) {
  const host = owner.body.createDiv();
  applyPluginSurface(host, "view");
  const composer = host.createEl("textarea");
  const container = host.createDiv();
  const sibling = container.createDiv({ text: "Owned by the caller" });
  const onRun = jest.fn(callbacks.onRun ?? (() => undefined));
  const onOpenSource = jest.fn(callbacks.onOpenSource ?? (() => undefined));
  const cards = new AgentPhoneHandoffCards({ container, app: new App(), onRun, onOpenSource });
  return { cards, container, host, composer, sibling, onRun, onOpenSource };
}

const run = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-testid="chat.phone-handoff.run"]')!;
const sourceLink = (container: HTMLElement) => container.querySelector<HTMLAnchorElement>('[data-testid="chat.phone-handoff.source"]')!;
const resultLink = (container: HTMLElement) => container.querySelector<HTMLAnchorElement>('[data-testid="chat.phone-handoff.result"]')!;
const status = (container: HTMLElement) => container.querySelector<HTMLElement>(".systemsculpt-agent-phone-handoff-state")!;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { document.body.empty(); });

it.each([
  ["pending", "Ready to run"],
  ["starting", "Starting"],
  ["running", "Running"],
  ["needs_approval", "Approval needed"],
  ["completed", "Completed"],
  ["failed", "Failed"],
] as const)("projects %s without running or inferring a next step", (state, label) => {
  const ui = setup();
  ui.composer.focus();
  const handoff = item({ state, message: state === "failed" ? "The agent is signed out. Sign in and try again." : undefined });
  const before = JSON.stringify(handoff);
  ui.cards.render([handoff]);
  expect(ui.container.textContent).toContain("From your iPhone");
  expect(ui.container.textContent).toContain("Claude Code");
  expect(status(ui.container).textContent).toBe(label);
  expect(status(ui.container).getAttribute("role")).toBe("status");
  expect(run(ui.container).hidden).toBe(state !== "pending");
  expect(run(ui.container).disabled).toBe(state !== "pending");
  if (state !== "pending") run(ui.container).click();
  if (state === "failed") expect(ui.container.textContent).toContain(handoff.message);
  expect(ui.onRun).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(ui.composer);
  expect(JSON.stringify(handoff)).toBe(before);
  expect(ui.container.querySelector('[role="dialog"]')).toBeNull();
  ui.cards.destroy();
});

it.each([
  ["systemsculpt", "SystemSculpt AI"], ["claude_code", "Claude Code"], ["codex", "Codex"],
] as const)("identifies the chosen %s backend", (agent, label) => {
  const ui = setup();
  ui.cards.render([item({ agent })]);
  expect(ui.container.querySelector(".systemsculpt-agent-phone-handoff-agent")?.textContent).toBe(label);
  ui.cards.destroy();
});

it.each([null, undefined])("blocks Run while the source is unavailable or unknown (%s)", source => {
  const ui = setup();
  ui.cards.render([item({ source: source as PhoneHandoffPresentation["source"], message: "Loading source…" })]);
  expect(run(ui.container).hidden).toBe(false);
  expect(run(ui.container).disabled).toBe(true);
  expect(ui.container.textContent).toContain("Source unavailable");
  expect(ui.container.textContent).toContain("Loading source…");
  expect(sourceLink(ui.container).hidden).toBe(true);
  run(ui.container).click();
  expect(ui.onRun).not.toHaveBeenCalled();
  ui.cards.render([item()]);
  expect(run(ui.container).disabled).toBe(false);
  expect(ui.container.textContent).not.toContain("Source unavailable");
  ui.cards.destroy();
});

it.each(["claude_code", "codex"] as const)("keeps %s review portable but hides Run without native host capability", agent => {
  host.localCli = false;
  const ui = setup();
  ui.cards.render([item({ agent })]);
  expect(run(ui.container).hidden).toBe(true);
  expect(run(ui.container).disabled).toBe(true);
  expect(ui.container.textContent).toContain("Open this handoff on a computer with");
  run(ui.container).click();
  expect(ui.onRun).not.toHaveBeenCalled();
  sourceLink(ui.container).click();
  expect(ui.onOpenSource).toHaveBeenCalledWith("Inbox/Launch.md");
  ui.cards.destroy();
});

it("keeps hosted Run available without desktop capabilities", () => {
  host.localCli = false;
  const ui = setup();
  ui.cards.render([item({ agent: "systemsculpt" })]);
  expect(run(ui.container).hidden).toBe(false);
  expect(run(ui.container).disabled).toBe(false);
  run(ui.container).click();
  expect(ui.onRun).toHaveBeenCalledWith("phone-one");
  ui.cards.destroy();
});

it("rechecks native capability when an old Run control is activated", () => {
  const ui = setup();
  ui.cards.render([item()]);
  host.localCli = false;
  run(ui.container).click();
  expect(ui.onRun).not.toHaveBeenCalled();
  ui.cards.destroy();
});

it("shows the entire instruction and source as inert text without truncation or embeds", () => {
  const ui = setup();
  const instruction = `${"Keep every instruction.\n".repeat(1500)}FINAL INSTRUCTION <button>Not a control</button>`;
  const markdown = `${"Paragraph with **Markdown**.\n\n".repeat(5000)}FINAL SOURCE <img src='https://example.com/tracker'>`;
  ui.cards.render([item({ instruction, source: { title: "Full source", markdown, path: null } })]);
  expect(ui.container.querySelector(".systemsculpt-agent-phone-handoff-instruction")?.textContent).toBe(instruction);
  expect(ui.container.querySelector("details pre")?.textContent).toBe(markdown);
  expect(ui.container.querySelector("summary")?.textContent).toContain("Full source");
  expect(ui.container.querySelector("img")).toBeNull();
  expect(ui.container.querySelectorAll("button")).toHaveLength(1);
  expect(sourceLink(ui.container).hidden).toBe(true);
  expect(run(ui.container).disabled).toBe(false);
  ui.cards.destroy();
});

it("forwards only explicit pending Run clicks and prevents duplicates during submission", async () => {
  const pending = deferred();
  const ui = setup(document, { onRun: () => pending.promise });
  ui.cards.render([item()]);
  run(ui.container).click();
  run(ui.container).click();
  ui.cards.render([item()]);
  run(ui.container).click();
  expect(ui.onRun.mock.calls).toEqual([["phone-one"]]);
  expect(run(ui.container).disabled).toBe(true);
  expect(status(ui.container).textContent).toBe("Ready to run");
  pending.resolve();
  await tick();
  expect(status(ui.container).textContent).toBe("Ready to run");
  expect(ui.onRun).toHaveBeenCalledTimes(1);
  ui.cards.destroy();
});

it.each(["throw", "reject"])("handles a Run callback %s without changing service-owned state", async failure => {
  const ui = setup(document, { onRun: () => {
    if (failure === "throw") throw new Error("Transport unavailable");
    return Promise.reject(new Error("Transport unavailable"));
  } });
  ui.cards.render([item()]);
  run(ui.container).click();
  await tick();
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain("Could not start this handoff");
  expect(run(ui.container).disabled).toBe(false);
  expect(status(ui.container).textContent).toBe("Ready to run");
  run(ui.container).click();
  await tick();
  expect(ui.onRun).toHaveBeenCalledTimes(2);
  expect(ui.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  ui.cards.destroy();
});

it("does not let a late submission rejection replace a newer run state", async () => {
  const pending = deferred();
  const ui = setup(document, { onRun: () => pending.promise });
  ui.cards.render([item()]);
  run(ui.container).click();
  ui.cards.render([item({ state: "completed", resultPath: "Results/Launch.md" })]);
  pending.reject(new Error("Late callback failure"));
  await tick();
  expect(status(ui.container).textContent).toBe("Completed");
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toBe("");
  expect(resultLink(ui.container).hidden).toBe(false);
  ui.cards.destroy();
});

it("opens current source and completed result paths only through the callback", async () => {
  const ui = setup();
  ui.cards.render([item({ resultPath: "Results/Not-completed.md" })]);
  const link = sourceLink(ui.container);
  link.click();
  expect(resultLink(ui.container).hidden).toBe(true);
  resultLink(ui.container).click();
  ui.cards.render([item({ state: "completed", source: { title: "Moved", markdown: "Full source", path: "Inbox/Moved.md" }, resultPath: "Results/Launch.md" })]);
  link.click();
  resultLink(ui.container).click();
  await tick();
  expect(ui.onOpenSource.mock.calls).toEqual([["Inbox/Launch.md"], ["Inbox/Moved.md"], ["Results/Launch.md"]]);
  expect(link.textContent).toContain("Inbox/Moved.md");
  expect(resultLink(ui.container).textContent).toContain("Results/Launch.md");
  ui.cards.destroy();
});

it.each(["source", "result"])("catches an %s link callback rejection", async target => {
  const ui = setup(document, { onOpenSource: () => Promise.reject(new Error("Missing note")) });
  ui.cards.render([item({ state: "completed", resultPath: "Results/Launch.md" })]);
  (target === "source" ? sourceLink(ui.container) : resultLink(ui.container)).click();
  await tick();
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain("Could not open this note");
  expect(status(ui.container).textContent).toBe("Completed");
  ui.cards.destroy();
});

it("keeps disclosure, focused elements and unchanged text nodes across refreshed snapshots", () => {
  const ui = setup();
  ui.cards.render([item()]);
  const details = ui.container.querySelector("details")!;
  details.open = true;
  const link = sourceLink(ui.container);
  const textNode = ui.container.querySelector("pre")!.firstChild;
  link.focus();
  ui.cards.render([item({ state: "running", message: "Reading the source" })]);
  expect(ui.container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(link);
  expect(ui.container.querySelector("pre")!.firstChild).toBe(textNode);
  ui.cards.render([item({ state: "needs_approval", source: { title: "Updated", markdown: "Updated source in full", path: "Inbox/Launch.md" } })]);
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(link);
  expect(details.querySelector("pre")?.textContent).toBe("Updated source in full");
  ui.cards.destroy();
});

it("reconciles multiple cards in order and preserves focus on a moved card", () => {
  const ui = setup();
  const first = item(), second = item({ id: 'phone-"two', agent: "codex" }), third = item({ id: "phone-three" });
  ui.cards.render([first, second]);
  const articles = [...ui.container.querySelectorAll("article")];
  const summary = articles[0].querySelector("summary")!;
  articles[0].querySelector("details")!.open = true;
  summary.focus();
  ui.cards.render([second, third, first]);
  const refreshed = [...ui.container.querySelectorAll("article")];
  expect(refreshed.map(card => card.dataset.handoffId)).toEqual([second.id, third.id, first.id]);
  expect(refreshed[0]).toBe(articles[1]);
  expect(refreshed[2]).toBe(articles[0]);
  expect(document.activeElement).toBe(summary);
  expect(refreshed[2].querySelector("details")!.open).toBe(true);
  run(refreshed[0]).click();
  expect(ui.onRun).toHaveBeenCalledWith(second.id);
  ui.cards.destroy();
});

it("uses the initiating owner document when retaining focus in a pop-out", () => {
  const frame = document.body.createEl("iframe");
  const owner = frame.contentDocument!;
  const ui = setup();
  const first = item(), second = item({ id: "second" });
  ui.cards.render([first, second]);
  // Obsidian reparents existing leaves when they move to a pop-out. Retain the
  // patched host prototypes while giving the leaf a real second focus owner.
  owner.body.appendChild(ui.host);
  const summary = ui.container.querySelector("summary")!;
  summary.focus();
  ui.cards.render([second, first]);
  expect(owner.activeElement).toBe(summary);
  expect(ui.container.querySelector("article")?.ownerDocument).toBe(owner);
  ui.cards.destroy();
});

it("removes stale cards and their callbacks without touching caller-owned content", async () => {
  const pending = deferred();
  const ui = setup(document, { onRun: () => pending.promise });
  ui.cards.render([item()]);
  const staleRun = run(ui.container), staleLink = sourceLink(ui.container);
  staleRun.click();
  ui.cards.render([]);
  staleLink.click();
  ui.cards.render([item()]);
  pending.reject(new Error("Old card"));
  await tick();
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toBe("");
  expect(ui.onOpenSource).not.toHaveBeenCalled();
  expect(run(ui.container).disabled).toBe(false);
  expect(ui.sibling.isConnected).toBe(true);
  ui.cards.destroy();
});

it("never focuses or scrolls on passive renders, including when the source arrives", () => {
  const ui = setup();
  ui.composer.focus();
  ui.container.scrollTop = 48;
  const focus = jest.spyOn(HTMLElement.prototype, "focus");
  try {
    ui.cards.render([item({ source: null })]);
    ui.cards.render([item()]);
    ui.cards.render([item({ state: "needs_approval" })]);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(ui.composer);
    expect(ui.container.scrollTop).toBe(48);
    expect(ui.onRun).not.toHaveBeenCalled();
  } finally { focus.mockRestore(); ui.cards.destroy(); }
});

it.each(["remove", "destroy"])("ignores a rejected note-open callback after %s", async action => {
  const pending = deferred();
  const ui = setup(document, { onOpenSource: () => pending.promise });
  ui.cards.render([item()]);
  sourceLink(ui.container).click();
  if (action === "destroy") ui.cards.destroy();
  else { ui.cards.render([]); ui.cards.render([item()]); }
  pending.reject(new Error("Missing note"));
  await tick();
  expect(ui.container.textContent).not.toContain("Could not open");
  expect(ui.sibling.isConnected).toBe(true);
  ui.cards.destroy();
});

it("keeps source review open while the source becomes unavailable and gates a retained Run button", () => {
  const ui = setup();
  ui.cards.render([item()]);
  const details = ui.container.querySelector("details")!;
  details.open = true;
  const button = run(ui.container);
  ui.cards.render([item({ source: null })]);
  button.click();
  expect(details.open).toBe(true);
  expect(button.disabled).toBe(true);
  expect(ui.onRun).not.toHaveBeenCalled();
  expect(details.textContent).not.toContain("Confirm the printer delivery");
  ui.cards.destroy();
});

it("destroys idempotently, ignores late callbacks and never renders after disposal", async () => {
  const pending = deferred();
  const ui = setup(document, { onRun: () => pending.promise });
  ui.cards.render([item()]);
  const staleRun = run(ui.container), staleLink = sourceLink(ui.container);
  staleRun.click();
  ui.cards.destroy();
  ui.cards.destroy();
  ui.cards.render([item()]);
  staleRun.click();
  staleLink.click();
  pending.reject(new Error("After destroy"));
  await tick();
  expect(ui.container.children).toHaveLength(1);
  expect(ui.container.firstElementChild).toBe(ui.sibling);
  expect(ui.onRun).toHaveBeenCalledTimes(1);
  expect(ui.onOpenSource).not.toHaveBeenCalled();
});
