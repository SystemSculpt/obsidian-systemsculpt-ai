import {
  backendMenu,
  chromeAccount,
  modeMenu,
  modelMenu,
  presentEmptyState,
  presentRunLine,
  type AgentChromeState,
  type ChromeMenuEntry,
} from "../AgentChatChrome";
import type { LocalAgentAvailability, LocalAgentDetection } from "../../../services/codex/LocalAgentDetection";
import type { CreditsBalanceSnapshot } from "../../../services/SystemSculptService";

const ready: LocalAgentAvailability = { installed: true, signedIn: true, recentSessionCount: 4, lastUsed: 1_000 };
const unused: LocalAgentAvailability = { installed: true, signedIn: true, recentSessionCount: 0, lastUsed: null };
const signedOut: LocalAgentAvailability = { installed: true, signedIn: false, recentSessionCount: 0, lastUsed: null };
const missing: LocalAgentAvailability = { installed: false, signedIn: false, recentSessionCount: 0, lastUsed: null };

function detection(
  claude: LocalAgentAvailability,
  codex: LocalAgentAvailability,
  preferred: LocalAgentDetection["preferred"],
): LocalAgentDetection {
  return { preferred, agents: { claude, codex } };
}

function credits(overrides: Partial<CreditsBalanceSnapshot> = {}): CreditsBalanceSnapshot {
  return {
    includedRemaining: 9_990,
    addOnRemaining: 0,
    totalRemaining: 9_990,
    availableUnreserved: 9_990,
    includedPerMonth: 10_000,
    cycleEndsAt: "2026-11-01T00:00:00.000Z",
    cycleStartedAt: "2026-10-01T00:00:00.000Z",
    cycleAnchorAt: "2026-10-01T00:00:00.000Z",
    turnInFlightUntil: null,
    purchaseUrl: null,
    ...overrides,
  };
}

function state(overrides: Partial<AgentChromeState> = {}): AgentChromeState {
  return {
    backend: "claude",
    localAgents: true,
    host: "Mac",
    detecting: false,
    detection: detection(ready, missing, "claude"),
    chosen: false,
    prefersLocalAgent: false,
    account: "signed-out",
    credits: null,
    hostedMode: "auto",
    claude: { mode: "auto", model: "", autoUnavailable: false },
    codex: { mode: "auto", model: "gpt-6.1", effort: "high", serviceTier: "default", autoUnavailable: false, models: null },
    hasMessages: false,
    running: false,
    activeNote: null,
    switchedFrom: null,
    usedInVault: new Set(),
    ...overrides,
  };
}

function segments(input: AgentChromeState) {
  const line = presentRunLine(input);
  if (line.kind !== "segments") throw new Error("expected segments");
  return line.segments;
}

function items(entries: readonly ChromeMenuEntry[]) {
  return entries.flatMap((entry) => entry.kind === "item" ? [entry] : []);
}

describe("run line (spec 4.1)", () => {
  it("names Claude Code on this Mac, its mode and its model, each as a menu", () => {
    const [backend, mode, model] = segments(state());
    expect(backend).toMatchObject({
      icon: "laptop",
      label: "Claude Code",
      wideSuffix: " on this Mac",
      menu: true,
      ariaLabel: "Backend: Claude Code on this Mac. Change backend",
    });
    expect(mode).toMatchObject({ label: "Auto", menu: true });
    expect(mode.ariaLabel).toBe(
      "Mode: Auto. Change mode. Runs safe actions without asking. Claude Code's safety check blocks risky ones.",
    );
    expect(model).toMatchObject({ label: "Default", menu: true, ariaLabel: "Model: Default. Change model" });
  });

  it("says this computer off macOS and drops the suffix at narrow widths", () => {
    const [backend] = segments(state({ backend: "codex", host: "computer" }));
    expect(`${backend.label}${backend.wideSuffix}`).toBe("Codex on this computer");
    expect(backend.ariaLabel).toBe("Backend: Codex on this computer. Change backend");
  });

  it("shows the Codex model with its thinking level only when wide", () => {
    const [, , model] = segments(state({ backend: "codex" }));
    expect(model).toMatchObject({ label: "gpt-6.1", wideSuffix: " · High" });
    const extraHigh = segments(state({
      backend: "codex",
      codex: { ...state().codex, effort: "xhigh" },
    }))[2];
    expect(extraHigh.wideSuffix).toBe(" · Extra high");
  });

  it.each([
    ["claude", "manual", "Ask before edits"],
    ["claude", "acceptEdits", "Accept edits"],
    ["claude", "plan", "Plan only"],
    ["claude", "settings", "Claude Code settings"],
    ["codex", "ask", "Ask"],
    ["codex", "read-only", "Read only"],
    ["codex", "settings", "Codex settings"],
    ["systemsculpt", "ask", "Ask"],
  ] as const)("labels %s mode %s as %s", (backend, value, label) => {
    const input = state({
      backend,
      claude: { ...state().claude, mode: backend === "claude" ? value as never : "auto" },
      codex: { ...state().codex, mode: backend === "codex" ? value as never : "auto" },
      hostedMode: backend === "systemsculpt" ? value as never : "auto",
    });
    expect(segments(input)[1].label).toBe(label);
  });

  it("flags Full access with a warning icon and says why in words", () => {
    const [, mode] = segments(state({ backend: "systemsculpt", hostedMode: "full-access" }));
    expect(mode).toMatchObject({ label: "Full access", icon: "shield-alert", tone: "warning" });
  });

  it("shows the Auto-unavailable fallbacks with their explanation", () => {
    const claude = segments(state({ claude: { ...state().claude, autoUnavailable: true } }))[1];
    expect(claude.label).toBe("Accept edits · Auto unavailable");
    expect(claude.ariaLabel).toContain("Update Claude Code to use Auto.");
    const codex = segments(state({ backend: "codex", codex: { ...state().codex, autoUnavailable: true } }))[1];
    expect(codex.label).toBe("Ask · Auto unavailable");
    expect(codex.ariaLabel).toContain("Update Codex to use Auto.");
  });

  it("shows hosted credits, low and empty tones, and Sign in when signed out", () => {
    const hosted = { backend: "systemsculpt" as const };
    const [backend] = segments(state({ ...hosted, account: "signed-in", credits: credits() }));
    expect(backend).toMatchObject({ icon: "cloud", label: "SystemSculpt", ariaLabel: "Backend: SystemSculpt. Change backend" });
    expect(segments(state({ ...hosted, account: "signed-in", credits: credits() }))[2])
      .toMatchObject({ label: "9,990 credits", action: "credits", menu: false });
    expect(segments(state({ ...hosted, account: "signed-in", credits: credits({ availableUnreserved: 1_000 }) }))[2])
      .toMatchObject({ label: "1,000 credits", tone: "warning" });
    expect(segments(state({ ...hosted, account: "no-plan", credits: credits({ totalRemaining: 0, availableUnreserved: 0 }) }))[2])
      .toMatchObject({ label: "Out of credits", tone: "danger", action: "credits" });
    expect(segments(state({ ...hosted, account: "signed-out" }))[2])
      .toMatchObject({ label: "Sign in", action: "sign-in" });
    expect(segments(state({ ...hosted, account: "signed-in", credits: credits({ usageClass: "master_auth" }) }))[2].label)
      .toBe("Internal QA");
  });

  it("says detection is running instead of guessing a backend", () => {
    expect(presentRunLine(state({ detecting: true }))).toEqual({
      kind: "detecting",
      label: "Finding Claude Code or Codex…",
    });
  });
});

describe("backend menu", () => {
  it("lists ready agents with status lines, the hosted balance and Detect again", () => {
    const entries = backendMenu(state({
      detection: detection(ready, unused, "claude"),
      account: "signed-in",
      credits: credits(),
    }));
    expect(entries.filter((entry) => entry.kind === "label").map((entry) => entry.kind === "label" && entry.title))
      .toEqual(["On this Mac", "Hosted"]);
    expect(items(entries).map(({ id, title, description, checked, disabled }) => ({ id, title, description, checked, disabled })))
      .toEqual([
        { id: "claude", title: "Claude Code", description: "Ready · used most", checked: true, disabled: false },
        { id: "codex", title: "Codex", description: "Ready", checked: false, disabled: false },
        { id: "systemsculpt", title: "SystemSculpt", description: "9,990 credits", checked: false, disabled: undefined },
        { id: "detect", title: "Detect again", description: undefined, checked: undefined, disabled: undefined },
        { id: "settings", title: "SystemSculpt settings", description: undefined, checked: undefined, disabled: undefined },
      ]);
  });

  it("disables a signed-out agent with its sign-in hint and hides one never installed or used", () => {
    const entries = items(backendMenu(state({ detection: detection(ready, signedOut, "claude") })));
    expect(entries.find((entry) => entry.id === "codex")).toMatchObject({
      description: "Not signed in · Run codex login in a terminal",
      disabled: true,
    });
    const absent = items(backendMenu(state({ detection: detection(ready, missing, "claude") })));
    expect(absent.some((entry) => entry.id === "codex")).toBe(false);
    const usedBefore = items(backendMenu(state({
      detection: detection(ready, missing, "claude"),
      usedInVault: new Set(["codex"]),
    })));
    expect(usedBefore.find((entry) => entry.id === "codex")).toMatchObject({ description: "Not installed", disabled: true });
  });

  it("warns that switching starts a new chat when this one has messages", () => {
    const [first] = backendMenu(state({ hasMessages: true }));
    expect(first).toEqual({ kind: "label", title: "Switching starts a new chat. This one stays in your history." });
  });

  it("offers only hosted chat on mobile, with no desktop-only actions", () => {
    const entries = backendMenu(state({ localAgents: false, backend: "systemsculpt" }));
    expect(entries[0]).toEqual({ kind: "label", title: "Claude Code and Codex run on desktop." });
    expect(items(entries).map((entry) => entry.id)).toEqual(["systemsculpt", "settings"]);
    expect(items(entries)[0].description).toBe("Sign in or start free");
  });
});

describe("mode and model menus", () => {
  it("lists every mode with its second line and checks the current one", () => {
    const entries = items(modeMenu(state({ backend: "codex", codex: { ...state().codex, mode: "read-only" } })));
    expect(entries.map((entry) => [entry.title, entry.checked])).toEqual([
      ["Auto", false], ["Ask", false], ["Read only", true], ["Codex settings", false],
    ]);
    expect(entries[0].description).toBe("Works inside this vault. Codex's reviewer only asks you about unsafe actions.");
    const hosted = items(modeMenu(state({ backend: "systemsculpt" })));
    expect(hosted.map((entry) => entry.title)).toEqual(["Auto", "Ask", "Full access"]);
    expect(hosted[2]).toMatchObject({ warning: true, icon: "shield-alert" });
  });

  it("says a mode change applies from the next message while a turn runs", () => {
    expect(modeMenu(state({ running: true })).at(-1)).toEqual({ kind: "label", title: "Applies from your next message." });
    expect(modeMenu(state()).some((entry) => entry.kind === "label")).toBe(false);
  });

  it("offers Claude Code's models with Default first", () => {
    expect(items(modelMenu(state({ claude: { ...state().claude, model: "opus" } })))
      .map((entry) => [entry.id, entry.title, entry.checked]))
      .toEqual([["model:", "Default", false], ["model:opus", "Opus", true], ["model:sonnet", "Sonnet", false], ["model:haiku", "Haiku", false]]);
  });

  it("offers Codex models, the thinking levels each supports, and speed", () => {
    const models = [
      { model: "gpt-6.1", name: "GPT-6.1", efforts: ["low", "high"], defaultEffort: "high", fastTier: "priority" },
      { model: "mini", name: "Mini", efforts: ["low"], defaultEffort: "low" },
    ];
    const entries = modelMenu(state({ backend: "codex", codex: { ...state().codex, models } }));
    expect(entries.filter((entry) => entry.kind === "label").map((entry) => entry.kind === "label" && entry.title))
      .toEqual(["Thinking", "Speed"]);
    expect(items(entries).map((entry) => entry.id)).toEqual([
      "model:gpt-6.1", "model:mini", "effort:low", "effort:high", "tier:default", "tier:priority",
    ]);
    expect(modelMenu(state({ backend: "codex" }))[0]).toEqual({ kind: "label", title: "Loading Codex models…" });
  });
});

describe("empty states (spec 3.1)", () => {
  const note = { name: "Plan", link: "Projects/Plan" };

  it("A: names the most-used agent and starters for the open note", () => {
    const empty = presentEmptyState(state({ detection: detection(ready, ready, "claude"), activeNote: note }));
    expect(empty.title).toBe("What should we work on?");
    expect(empty.lead).toBe(
      "Using Claude Code, the agent you use most on this Mac. It runs on your own install and login. No SystemSculpt account or credits needed.",
    );
    expect(empty.starters.map((starter) => [starter.label, starter.prompt])).toEqual([
      ["Summarize Plan", "Summarize [[Projects/Plan]]"],
      ["Find notes related to Plan", "Find notes related to [[Projects/Plan]]"],
      ["Turn Plan into a checklist", "Turn [[Projects/Plan]] into a checklist"],
    ]);
  });

  it("A: drops the used-most clause when it is the only agent or the person chose it", () => {
    const only = presentEmptyState(state({ detection: detection(ready, missing, "claude") }));
    expect(only.lead).toBe("Using Claude Code on this Mac. It runs on your own install and login. No SystemSculpt account or credits needed.");
    const chosen = presentEmptyState(state({ chosen: true, detection: detection(ready, ready, "claude") }));
    expect(chosen.lead).toMatch(/^Using Claude Code on this Mac\./);
    expect(only.starters.map((starter) => starter.label)).toEqual([
      "Summarize my latest daily note", "Find notes I haven't linked yet", "Plan my week from my notes",
    ]);
  });

  it("B and C: Codex, with the other ready agent one click away", () => {
    const empty = presentEmptyState(state({ backend: "codex", detection: detection(ready, ready, "codex") }));
    expect(empty.lead).toMatch(/^Using Codex, the agent you use most on this Mac\./);
    expect(empty.notes).toEqual([{
      id: "also-ready",
      text: "Claude Code is ready too.",
      action: { id: "switch-below", label: "Switch below", after: "." },
    }]);
  });

  it("D: signed out on desktop offers Start free with T-36's line and the local hint", () => {
    const empty = presentEmptyState(state({ backend: "systemsculpt", detection: detection(missing, missing, "systemsculpt") }));
    expect(empty.lead).toBe("Chat with your vault using SystemSculpt.");
    expect(empty.offer).toEqual({
      text: "Create a free account to get 500 starter credits. No card needed. Paid plans start at $9/month.",
      actions: ["start-free", "sign-in"],
    });
    expect(empty.hints).toEqual([{
      id: "local-hint",
      before: "Already use Claude Code or Codex? Install or sign in on this computer, then",
      after: ".",
    }]);
    expect(empty.starters).toEqual([]);
  });

  it("D2: says how to sign in to an installed agent", () => {
    const empty = presentEmptyState(state({ backend: "systemsculpt", detection: detection(signedOut, signedOut, "systemsculpt") }));
    expect(empty.hints.map((hint) => `${hint.before} Detect again${hint.after}`)).toEqual([
      "Claude Code is installed but not signed in. Run claude in a terminal and type /login, then Detect again.",
      "Codex is installed but not signed in. Run codex login in a terminal, then Detect again.",
    ]);
  });

  it("E: signed in with credits, or with no plan and no credits", () => {
    const withCredits = presentEmptyState(state({ backend: "systemsculpt", account: "signed-in", credits: credits() }));
    expect(withCredits.lead).toBe("Ask about your notes or give SystemSculpt a task.");
    expect(withCredits.hints).toEqual([]);
    expect(withCredits.starters).toHaveLength(3);
    const noPlan = presentEmptyState(state({ backend: "systemsculpt", account: "no-plan" }));
    expect(noPlan.lead).toBe("Create a free account for 500 starter credits, or choose a plan.");
    expect(noPlan.offer?.actions).toEqual(["see-plans"]);
  });

  it("E: paid plans see no local-agent mention even with agents installed", () => {
    const empty = presentEmptyState(state({
      backend: "systemsculpt",
      account: "paid",
      credits: credits({ includedCreditsEntitled: true }),
      detection: detection(ready, ready, "claude"),
    }));
    expect(JSON.stringify(empty)).not.toMatch(/Claude Code|Codex/);
  });

  it("F: mobile names where the local agents run and never offers Detect again", () => {
    const empty = presentEmptyState(state({
      backend: "systemsculpt",
      localAgents: false,
      prefersLocalAgent: true,
      detection: null,
    }));
    expect(empty.notes).toEqual([{ id: "mobile", text: "Claude Code and Codex run on desktop. Here, chat uses SystemSculpt." }]);
    expect(empty.hints).toEqual([]);
  });

  it("G: shows only the title while detection runs", () => {
    expect(presentEmptyState(state({ detecting: true }))).toEqual({
      title: "What should we work on?",
      lead: null,
      notes: [],
      offer: null,
      hints: [],
      starters: [],
    });
  });

  it("H: links back to the chat a backend switch left", () => {
    const empty = presentEmptyState(state({ backend: "codex", switchedFrom: { chatId: "old" } }));
    expect(empty.notes[0]).toEqual({
      id: "switched",
      text: "Started a new chat with Codex.",
      action: { id: "back-to-previous", label: "Back to previous chat" },
    });
  });
});

describe("chromeAccount", () => {
  it("separates signed out, no plan, signed in and paid", () => {
    expect(chromeAccount({}, null)).toBe("signed-out");
    expect(chromeAccount({ userEmail: "person@example.test" }, null)).toBe("no-plan");
    expect(chromeAccount({ licenseKey: "key" }, null)).toBe("signed-in");
    expect(chromeAccount({ licenseKey: "key" }, credits({ includedCreditsEntitled: false, totalRemaining: 0 }))).toBe("no-plan");
    expect(chromeAccount({ licenseKey: "key" }, credits({ includedCreditsEntitled: false, totalRemaining: 300 }))).toBe("signed-in");
    expect(chromeAccount({ licenseKey: "key" }, credits({ includedCreditsEntitled: true }))).toBe("paid");
    expect(chromeAccount({ licenseKey: "key", subscriptionStatus: "lifetime" }, null)).toBe("paid");
  });
});
