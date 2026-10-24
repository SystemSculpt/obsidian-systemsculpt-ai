/** @jest-environment jsdom */

import { AgentEmptyState } from "../AgentEmptyState";
import { starters, type EmptyStatePresentation } from "../AgentChatChrome";

function presentation(overrides: Partial<EmptyStatePresentation> = {}): EmptyStatePresentation {
  return {
    title: "What should we work on?",
    lead: null,
    notes: [],
    offer: null,
    hints: [],
    starters: [],
    ...overrides,
  };
}

function mount() {
  const onAction = jest.fn();
  const onStarter = jest.fn();
  const empty = new AgentEmptyState(document.body.createDiv(), { onAction, onStarter });
  const button = (id: string) => empty.element.querySelector<HTMLButtonElement>(`[data-testid="chat.empty.${id}"]`)!;
  return { empty, button, onAction, onStarter };
}

describe("AgentEmptyState", () => {
  afterEach(() => document.body.empty());

  it("renders only the title while no guidance or actions are available", () => {
    const { empty } = mount();
    empty.render(presentation());

    expect(empty.element.querySelector("h2")?.textContent).toBe("What should we work on?");
    expect(empty.element.textContent).toBe("What should we work on?");
    expect(empty.element.querySelector("button, p, [role=group]")).toBeNull();
  });

  it.each([
    ["start-free", "Start free"],
    ["sign-in", "Sign in"],
    ["see-plans", "See plans"],
  ] as const)("forwards the %s offer action without starting a prompt", (action, label) => {
    const { empty, button, onAction, onStarter } = mount();
    empty.render(presentation({
      lead: "Chat with your vault using SystemSculpt.",
      offer: { text: "Account guidance", actions: [action] },
    }));

    expect(empty.element.textContent).toContain("Chat with your vault using SystemSculpt.");
    expect(empty.element.textContent).toContain("Account guidance");
    expect(button(action).textContent).toBe(label);
    expect(button(action).type).toBe("button");
    expect(onAction).not.toHaveBeenCalled();
    button(action).click();
    expect(onAction.mock.calls).toEqual([[action]]);
    expect(onStarter).not.toHaveBeenCalled();
  });

  it("keeps offer actions in order and does not add a paragraph for an empty offer", () => {
    const { empty } = mount();
    empty.render(presentation({ offer: { text: "", actions: ["start-free", "sign-in"] } }));

    expect(Array.from(empty.element.querySelectorAll("button"), (button) => button.textContent))
      .toEqual(["Start free", "Sign in"]);
    expect(empty.element.querySelector("p")).toBeNull();
  });

  it("puts the switched-chat notice before the lead and forwards both note actions", () => {
    const { empty, button, onAction, onStarter } = mount();
    empty.render(presentation({
      lead: "Using Codex on this computer.",
      notes: [
        { id: "also-ready", text: "Another agent is ready too.", action: { id: "switch-below", label: "Switch below", after: "." } },
        { id: "switched", text: "Started a new chat with Codex.", action: { id: "back-to-previous", label: "Back to previous chat" } },
        { id: "mobile", text: "Here, chat uses SystemSculpt." },
      ],
    }));

    expect(Array.from(empty.element.querySelectorAll("p"), (line) => line.textContent)).toEqual([
      "Started a new chat with Codex. Back to previous chat",
      "Using Codex on this computer.",
      "Another agent is ready too. Switch below.",
      "Here, chat uses SystemSculpt.",
    ]);
    expect(empty.element.querySelector('[data-note="mobile"] button')).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    button("back-to-previous").click();
    button("switch-below").click();
    expect(onAction.mock.calls).toEqual([["back-to-previous"], ["switch-below"]]);
    expect(onStarter).not.toHaveBeenCalled();
  });

  it("renders command hints as code and makes each Detect again action work", () => {
    const { empty, onAction } = mount();
    empty.render(presentation({ hints: [
      { id: "local-hint", before: "Install or sign in, then", after: "." },
      { id: "codex-signed-out", before: "`codex login` signs you in; then", after: " to refresh." },
      { id: "claude-signed-out", before: "Run `claude` and type /login, then", after: "." },
    ] }));

    expect(Array.from(empty.element.querySelectorAll("p"), (line) => line.textContent)).toEqual([
      "Install or sign in, then Detect again.",
      "codex login signs you in; then Detect again to refresh.",
      "Run claude and type /login, then Detect again.",
    ]);
    expect(Array.from(empty.element.querySelectorAll("code"), (code) => code.textContent))
      .toEqual(["codex login", "claude"]);
    const buttons = empty.element.querySelectorAll<HTMLButtonElement>('[data-testid="chat.empty.detect-again"]');
    expect(buttons).toHaveLength(3);
    expect(onAction).not.toHaveBeenCalled();
    for (const button of buttons) {
      expect(button.type).toBe("button");
      button.click();
    }
    expect(onAction.mock.calls).toEqual([["detect-again"], ["detect-again"], ["detect-again"]]);
  });

  it("keeps note names and command text literal rather than interpreting HTML", () => {
    const { empty } = mount();
    empty.render(presentation({
      starters: starters({ name: "<b>Plan</b>", link: "Projects/<b>Plan</b>" }),
      hints: [{ id: "local-hint", before: "Run `<script>unsafe</script>` then <em>refresh</em>", after: "." }],
    }));

    expect(empty.element.querySelector("script, b, em")).toBeNull();
    expect(empty.element.querySelector("code")?.textContent).toBe("<script>unsafe</script>");
    expect(empty.element.textContent).toContain("Summarize <b>Plan</b>");
    expect(empty.element.textContent).toContain("then <em>refresh</em>");
  });

  it("labels the prompt group and forwards each complete starter exactly once", () => {
    const { empty, button, onStarter, onAction } = mount();
    const suggestions = starters({ name: "Plan", link: "Projects/Plan" });
    empty.render(presentation({ starters: suggestions }));

    expect(empty.element.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Suggested prompts");
    expect(onStarter).not.toHaveBeenCalled();
    for (const starter of suggestions) {
      expect(button(`starter.${starter.id}`).textContent).toBe(starter.label);
      button(`starter.${starter.id}`).click();
    }
    expect(onStarter.mock.calls).toEqual(suggestions.map((starter) => [starter]));
    expect(onAction).not.toHaveBeenCalled();
  });

  it("leaves the focused starter and its handler intact for an identical presentation", () => {
    const { empty, button, onStarter } = mount();
    const current = presentation({ starters: starters(null) });
    empty.render(current);
    const focused = button("starter.related");
    focused.focus();

    empty.render(presentation({ starters: starters(null) }));

    expect(button("starter.related")).toBe(focused);
    expect(document.activeElement).toBe(focused);
    focused.click();
    expect(onStarter.mock.calls).toEqual([[current.starters[1]]]);
  });

  it("restores focus to the same starter after a note changes and sends its new prompt", () => {
    const { empty, button, onStarter } = mount();
    empty.render(presentation({ starters: starters(null) }));
    const previous = button("starter.related");
    previous.focus();
    const next = starters({ name: "Trip", link: "Travel/Trip" });

    empty.render(presentation({ starters: next }));

    expect(previous.isConnected).toBe(false);
    expect(document.activeElement).toBe(button("starter.related"));
    expect(button("starter.related").textContent).toBe("Find notes related to Trip");
    button("starter.related").click();
    expect(onStarter.mock.calls).toEqual([[next[1]]]);
  });

  it("does not move focus from the composer when the empty state changes", () => {
    const { empty } = mount();
    empty.render(presentation({ starters: starters(null) }));
    const composer = document.body.createEl("textarea");
    composer.focus();

    empty.render(presentation({ offer: { text: "", actions: ["see-plans"] } }));

    expect(document.activeElement).toBe(composer);
    expect(empty.element.querySelector('[role="group"]')).toBeNull();
  });

  it("removes obsolete guidance and actions when returning to detection without stealing focus", () => {
    const { empty, button, onAction } = mount();
    empty.render(presentation({
      lead: "Chat with your vault using SystemSculpt.",
      notes: [{ id: "mobile", text: "Here, chat uses SystemSculpt." }],
      offer: { text: "Account guidance", actions: ["start-free", "sign-in"] },
      hints: [{ id: "local-hint", before: "Install or sign in, then", after: "." }],
    }));
    const previous = button("sign-in");
    previous.focus();

    expect(() => empty.render(presentation())).not.toThrow();

    expect(previous.isConnected).toBe(false);
    expect(empty.element.textContent).toBe("What should we work on?");
    expect(empty.element.querySelector("button, p, [role=group]")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(onAction).not.toHaveBeenCalled();
  });
});
