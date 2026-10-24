import type { CreditsBalanceSnapshot } from "../../services/SystemSculptService";
import type { CodexModel } from "../../services/codex/CodexModelCatalog";
import type { LocalAgentAvailability, LocalAgentDetection } from "../../services/codex/LocalAgentDetection";
import { LOCAL_AGENTS, isLocalAgentId, type LocalAgentId, type TextExecutionBackend } from "../../services/codex/LocalAgents";
import { PLAN_REQUIRED_MESSAGE } from "../../utils/errors";
import type { ChatApprovalMode } from "./storage/ChatPersistenceTypes";

/**
 * Presentation of the chat chrome: the run line, its backend, mode and model
 * menus, and the empty states. Everything here is a pure function of one
 * state snapshot that the view assembles from settings, detection, the
 * account and the open chat, so each state can be checked without a DOM.
 */

export type AgentChromeAccount =
  /** No SystemSculpt account on this device. */
  | "signed-out"
  /** Signed in with no plan and no credits left. */
  | "no-plan"
  /** Hosted credits are available, or not known yet. */
  | "signed-in"
  /** An active paid plan; hosted stays the default and local agents go unmentioned. */
  | "paid";

export type ClaudeChromeMode = "auto" | "manual" | "acceptEdits" | "plan" | "settings";
export type CodexChromeMode = "auto" | "ask" | "read-only" | "settings";

export type AgentChromeState = Readonly<{
  backend: TextExecutionBackend;
  /** On-machine agents can run here (desktop). */
  localAgents: boolean;
  /** How the run line names this computer. */
  host: "Mac" | "computer";
  /** First-open detection is still deciding the backend of an empty chat. */
  detecting: boolean;
  detection: LocalAgentDetection | null;
  /** The backend was chosen by the person, not by detection. */
  chosen: boolean;
  /** The saved default for new chats is a local agent, shown on mobile. */
  prefersLocalAgent: boolean;
  account: AgentChromeAccount;
  credits: CreditsBalanceSnapshot | null;
  hostedMode: ChatApprovalMode;
  claude: Readonly<{ mode: ClaudeChromeMode; model: string; autoUnavailable: boolean }>;
  codex: Readonly<{
    mode: CodexChromeMode;
    model: string;
    effort: string;
    serviceTier: string;
    autoUnavailable: boolean;
    /** Null until the installed Codex has listed its models. */
    models: readonly CodexModel[] | null;
  }>;
  hasMessages: boolean;
  running: boolean;
  /** The note open in the editor, for the starters. */
  activeNote: Readonly<{ name: string; link: string }> | null;
  /** Set on the empty chat that a backend switch just started. */
  switchedFrom: Readonly<{ chatId: string }> | null;
  /** Agents that ran chats in this vault, listed even when not installed. */
  usedInVault: ReadonlySet<LocalAgentId>;
}>;

export type ChromeModeChoice = Readonly<{
  value: string;
  label: string;
  description: string;
  icon: string;
}>;

export const MODE_CHOICES: Readonly<Record<TextExecutionBackend, readonly ChromeModeChoice[]>> = {
  claude: [
    { value: "auto", label: "Auto", icon: "sparkles", description: "Runs safe actions without asking. Claude Code's safety check blocks risky ones." },
    { value: "manual", label: "Ask before edits", icon: "hand", description: "Asks before every edit and command." },
    { value: "acceptEdits", label: "Accept edits", icon: "file-pen-line", description: "Edits notes without asking. Asks before commands." },
    { value: "plan", label: "Plan only", icon: "list-checks", description: "Reads and plans. Changes nothing until you approve the plan." },
    { value: "settings", label: "Claude Code settings", icon: "settings-2", description: "Uses the permission rules in your Claude Code settings." },
  ],
  codex: [
    { value: "auto", label: "Auto", icon: "sparkles", description: "Works inside this vault. Codex's reviewer only asks you about unsafe actions." },
    { value: "ask", label: "Ask", icon: "hand", description: "Works inside this vault. Asks before editing other files or using the internet." },
    { value: "read-only", label: "Read only", icon: "eye", description: "Reads your vault without changing it." },
    { value: "settings", label: "Codex settings", icon: "settings-2", description: "Uses your own Codex configuration." },
  ],
  systemsculpt: [
    { value: "auto", label: "Auto", icon: "sparkles", description: "Reads, creates and edits notes without asking. Asks before moving or deleting." },
    { value: "ask", label: "Ask", icon: "hand", description: "Asks before every change to your vault." },
    { value: "full-access", label: "Full access", icon: "shield-alert", description: "Makes every change without asking, including moves and deletes." },
  ],
};

export const CLAUDE_AUTO_UNAVAILABLE =
  "Claude Code's Auto mode isn't available here, so edits are accepted automatically and other actions ask. Update Claude Code to use Auto.";
export const CODEX_AUTO_UNAVAILABLE =
  "Codex's automatic review isn't available in this version, so Codex asks you when it needs approval. Update Codex to use Auto.";
export const MODE_APPLIES_NEXT = "Applies from your next message.";
export const SWITCH_STARTS_NEW_CHAT = "Switching starts a new chat. This one stays in your history.";
export const DETECTING_AGENTS = "Finding Claude Code or Codex…";
export const EMPTY_TITLE = "What should we work on?";
/** T-36 free-start copy, read by the Nov 6 experiment: do not edit. */
export const FREE_START_OFFER = "Create a free account to get 500 starter credits. No card needed. Paid plans start at $9/month.";

const CLAUDE_MODELS: readonly (readonly [string, string, string?])[] = [
  ["", "Default", "Claude Code's choice"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
];

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export function agentName(backend: TextExecutionBackend): string {
  return isLocalAgentId(backend) ? LOCAL_AGENTS[backend] : "SystemSculpt";
}

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? (effort ? effort[0].toUpperCase() + effort.slice(1) : "");
}

export function formatCredits(value: number): string {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(Math.round(value));
  }
}

/** Which account the hosted chrome speaks to. */
export function chromeAccount(
  settings: Readonly<{ licenseKey?: string; userEmail?: string; subscriptionStatus?: string }>,
  credits: CreditsBalanceSnapshot | null,
): AgentChromeAccount {
  if (!settings.licenseKey?.trim()) return settings.userEmail?.trim() ? "no-plan" : "signed-out";
  if (
    credits?.includedCreditsEntitled === true
    || settings.subscriptionStatus === "active"
    || settings.subscriptionStatus === "lifetime"
  ) return "paid";
  if (credits?.includedCreditsEntitled === false && credits.totalRemaining <= 0) return "no-plan";
  return "signed-in";
}

function usable(agent: LocalAgentAvailability | undefined): boolean {
  return Boolean(agent?.installed && agent.signedIn);
}

function otherAgent(agent: LocalAgentId): LocalAgentId {
  return agent === "claude" ? "codex" : "claude";
}

/** The mode the run line shows, including the Auto-unavailable fallbacks. */
export function presentMode(state: AgentChromeState): Readonly<{
  value: string;
  label: string;
  description: string;
  icon: string;
  tone?: "warning";
}> {
  const choices = MODE_CHOICES[state.backend];
  const value = state.backend === "claude"
    ? state.claude.mode
    : state.backend === "codex"
      ? state.codex.mode
      : state.hostedMode;
  const choice = choices.find((candidate) => candidate.value === value) ?? choices[0];
  if (state.backend === "claude" && value === "auto" && state.claude.autoUnavailable) {
    return { value, label: "Accept edits · Auto unavailable", description: CLAUDE_AUTO_UNAVAILABLE, icon: "file-pen-line" };
  }
  if (state.backend === "codex" && value === "auto" && state.codex.autoUnavailable) {
    return { value, label: "Ask · Auto unavailable", description: CODEX_AUTO_UNAVAILABLE, icon: "hand" };
  }
  return {
    value: choice.value,
    label: choice.label,
    description: choice.description,
    icon: choice.icon,
    ...(choice.value === "full-access" ? { tone: "warning" as const } : {}),
  };
}

export type RunLineSegment = Readonly<{
  key: "backend" | "mode" | "detail";
  icon?: string;
  /** Shown at every width. */
  label: string;
  /** Appended only when the line is at least 380 px wide. */
  wideSuffix?: string;
  ariaLabel: string;
  tone?: "warning" | "danger";
  /** Opens a menu; otherwise `action` runs. */
  menu: boolean;
  action?: "credits" | "sign-in" | "see-plans";
}>;

export type RunLinePresentation =
  | Readonly<{ kind: "detecting"; label: string }>
  | Readonly<{ kind: "segments"; segments: readonly RunLineSegment[] }>;

function hostedDetail(state: AgentChromeState): RunLineSegment {
  const base = { key: "detail" as const, menu: false };
  if (state.account === "signed-out") {
    return { ...base, label: "Sign in", ariaLabel: "Sign in to SystemSculpt", action: "sign-in" };
  }
  const credits = state.credits;
  if (credits?.usageClass === "master_auth") {
    return { ...base, label: "Internal QA", ariaLabel: "Internal testing mode. Open credits", action: "credits" };
  }
  if (!credits) {
    return state.account === "no-plan"
      ? { ...base, label: "See plans", ariaLabel: "See SystemSculpt plans", action: "see-plans" }
      : { ...base, label: "Credits", ariaLabel: "Open credits", action: "credits" };
  }
  if (credits.totalRemaining <= 0) {
    return { ...base, label: "Out of credits", ariaLabel: "Out of credits. Open credits", tone: "danger", action: "credits" };
  }
  const available = credits.availableUnreserved ?? credits.totalRemaining;
  const label = `${formatCredits(Math.max(0, available))} credits`;
  const held = credits.heldInFlight ?? 0;
  return {
    ...base,
    label,
    ariaLabel: held > 0
      ? `${label} available; ${formatCredits(held)} held for work in progress. Open credits`
      : `${label} available. Open credits`,
    action: "credits",
    ...(available <= 1000 ? { tone: "warning" as const } : {}),
  };
}

function modelDetail(state: AgentChromeState): RunLineSegment | null {
  if (state.backend === "claude") {
    const known = CLAUDE_MODELS.find(([value]) => value === state.claude.model);
    const label = known?.[1] ?? state.claude.model;
    return { key: "detail", label, menu: true, ariaLabel: `Model: ${label}. Change model` };
  }
  if (state.backend === "codex") {
    const effort = effortLabel(state.codex.effort);
    return {
      key: "detail",
      label: state.codex.model,
      ...(effort ? { wideSuffix: ` · ${effort}` } : {}),
      menu: true,
      ariaLabel: `Model: ${state.codex.model}${effort ? `, ${effort} thinking` : ""}. Change model`,
    };
  }
  return null;
}

export function presentRunLine(state: AgentChromeState): RunLinePresentation {
  if (state.detecting) return { kind: "detecting", label: DETECTING_AGENTS };
  const local = isLocalAgentId(state.backend);
  const name = agentName(state.backend);
  const where = local ? `${name} on this ${state.host}` : name;
  const mode = presentMode(state);
  const detail = local ? modelDetail(state) : hostedDetail(state);
  return {
    kind: "segments",
    segments: [
      {
        key: "backend",
        icon: local ? "laptop" : "cloud",
        label: name,
        ...(local ? { wideSuffix: ` on this ${state.host}` } : {}),
        menu: true,
        ariaLabel: `Backend: ${where}. Change backend`,
      },
      {
        key: "mode",
        ...(mode.tone ? { icon: "shield-alert", tone: mode.tone } : {}),
        label: mode.label,
        menu: true,
        ariaLabel: `Mode: ${mode.label}. Change mode. ${mode.description}`,
      },
      ...(detail ? [detail] : []),
    ],
  };
}

export type ChromeMenuEntry =
  | Readonly<{ kind: "label"; title: string }>
  | Readonly<{ kind: "separator" }>
  | Readonly<{
      kind: "item";
      id: string;
      title: string;
      description?: string;
      icon?: string;
      checked?: boolean;
      disabled?: boolean;
      warning?: boolean;
    }>;

function agentStatus(state: AgentChromeState, agent: LocalAgentId): Readonly<{
  listed: boolean;
  usable: boolean;
  description: string;
}> {
  const detection = state.detection;
  if (!detection) return { listed: true, usable: true, description: "Checking…" };
  const availability = detection.agents[agent];
  if (usable(availability)) {
    const usedMost = detection.preferred === agent && availability.lastUsed !== null;
    return { listed: true, usable: true, description: usedMost ? "Ready · used most" : "Ready" };
  }
  if (availability?.installed) {
    const hint = agent === "claude"
      ? "Run claude in a terminal and type /login"
      : "Run codex login in a terminal";
    return { listed: true, usable: false, description: `Not signed in · ${hint}` };
  }
  return { listed: state.usedInVault.has(agent), usable: false, description: "Not installed" };
}

function hostedStatus(state: AgentChromeState): string {
  if (state.account === "signed-out") return "Sign in or start free";
  const credits = state.credits;
  if (!credits || credits.usageClass === "master_auth") return "";
  if (credits.totalRemaining <= 0) return "Out of credits";
  return `${formatCredits(Math.max(0, credits.availableUnreserved ?? credits.totalRemaining))} credits`;
}

export function backendMenu(state: AgentChromeState): readonly ChromeMenuEntry[] {
  const entries: ChromeMenuEntry[] = [];
  if (state.hasMessages) entries.push({ kind: "label", title: SWITCH_STARTS_NEW_CHAT });
  if (state.localAgents) {
    entries.push({ kind: "label", title: `On this ${state.host}` });
    for (const agent of ["claude", "codex"] as const) {
      const status = agentStatus(state, agent);
      if (!status.listed) continue;
      entries.push({
        kind: "item",
        id: agent,
        title: LOCAL_AGENTS[agent],
        description: status.description,
        icon: "laptop",
        checked: state.backend === agent,
        disabled: !status.usable && state.backend !== agent,
      });
    }
    entries.push({ kind: "label", title: "Hosted" });
  } else {
    entries.push({ kind: "label", title: "Claude Code and Codex run on desktop." });
  }
  const hosted = hostedStatus(state);
  entries.push({
    kind: "item",
    id: "systemsculpt",
    title: "SystemSculpt",
    ...(hosted ? { description: hosted } : {}),
    icon: "cloud",
    checked: state.backend === "systemsculpt",
  });
  entries.push({ kind: "separator" });
  if (state.localAgents) entries.push({ kind: "item", id: "detect", title: "Detect again", icon: "refresh-cw" });
  entries.push({ kind: "item", id: "settings", title: "SystemSculpt settings", icon: "settings" });
  return entries;
}

export function modeMenu(state: AgentChromeState): readonly ChromeMenuEntry[] {
  const current = presentMode(state).value;
  const entries: ChromeMenuEntry[] = MODE_CHOICES[state.backend].map((choice) => ({
    kind: "item",
    id: choice.value,
    title: choice.label,
    description: choice.description,
    icon: choice.icon,
    checked: choice.value === current,
    ...(choice.value === "full-access" ? { warning: true } : {}),
  }));
  if (state.running) entries.push({ kind: "separator" }, { kind: "label", title: MODE_APPLIES_NEXT });
  return entries;
}

/** Model menu ids: `model:<id>`, `effort:<id>` and `tier:<id>`. */
export function modelMenu(state: AgentChromeState): readonly ChromeMenuEntry[] {
  const entries: ChromeMenuEntry[] = [];
  if (state.backend === "claude") {
    const choices = CLAUDE_MODELS.some(([value]) => value === state.claude.model)
      ? CLAUDE_MODELS
      : [...CLAUDE_MODELS, [state.claude.model, state.claude.model] as const];
    for (const [value, title, description] of choices) {
      entries.push({
        kind: "item",
        id: `model:${value}`,
        title,
        ...(description ? { description } : {}),
        checked: value === state.claude.model,
      });
    }
  } else if (state.backend === "codex") {
    const { models, model, effort, serviceTier } = state.codex;
    const current = models?.find((candidate) => candidate.model === model);
    if (!models) entries.push({ kind: "label", title: "Loading Codex models…" });
    for (const candidate of models ?? []) {
      entries.push({ kind: "item", id: `model:${candidate.model}`, title: candidate.name, checked: candidate.model === model });
    }
    if (!current) entries.push({ kind: "item", id: `model:${model}`, title: model, checked: true, disabled: true });
    const efforts = current?.efforts.length ? current.efforts : [effort];
    entries.push({ kind: "separator" }, { kind: "label", title: "Thinking" });
    for (const value of new Set([...efforts, effort])) {
      entries.push({
        kind: "item",
        id: `effort:${value}`,
        title: effortLabel(value),
        checked: value === effort,
        disabled: Boolean(current) && !current!.efforts.includes(value),
      });
    }
    const fastTier = current?.fastTier ?? (current ? undefined : serviceTier !== "default" ? serviceTier : undefined);
    entries.push({ kind: "separator" }, { kind: "label", title: "Speed" });
    entries.push({ kind: "item", id: "tier:default", title: "Normal", checked: serviceTier === "default" });
    entries.push({
      kind: "item",
      id: `tier:${fastTier ?? "priority"}`,
      title: fastTier || !current ? "Fast" : "Fast (unavailable)",
      description: "Uses more of your Codex allowance.",
      checked: serviceTier !== "default",
      disabled: Boolean(current) && !fastTier,
    });
  }
  return entries;
}

export type ChromeStarter = Readonly<{ id: "summarize" | "related" | "checklist"; label: string; prompt: string }>;

export function starters(activeNote: AgentChromeState["activeNote"]): readonly ChromeStarter[] {
  if (!activeNote) {
    return [
      { id: "summarize", label: "Summarize my latest daily note", prompt: "Summarize my latest daily note" },
      { id: "related", label: "Find notes I haven't linked yet", prompt: "Find notes I haven't linked yet" },
      { id: "checklist", label: "Plan my week from my notes", prompt: "Plan my week from my notes" },
    ];
  }
  const { name, link } = activeNote;
  return [
    { id: "summarize", label: `Summarize ${name}`, prompt: `Summarize [[${link}]]` },
    { id: "related", label: `Find notes related to ${name}`, prompt: `Find notes related to [[${link}]]` },
    { id: "checklist", label: `Turn ${name} into a checklist`, prompt: `Turn [[${link}]] into a checklist` },
  ];
}

export type EmptyStateNote = Readonly<{
  id: "also-ready" | "switched" | "mobile";
  text: string;
  action?: Readonly<{ id: "switch-below" | "back-to-previous"; label: string; after?: string }>;
}>;

export type EmptyStateHint = Readonly<{
  id: "local-hint" | "claude-signed-out" | "codex-signed-out";
  /** Text before and after the inline Detect again action; `backticks` mark commands. */
  before: string;
  after: string;
}>;

export type EmptyStatePresentation = Readonly<{
  title: string;
  lead: string | null;
  notes: readonly EmptyStateNote[];
  offer: Readonly<{ text: string; actions: readonly ("start-free" | "sign-in" | "see-plans")[] }> | null;
  hints: readonly EmptyStateHint[];
  starters: readonly ChromeStarter[];
}>;

function localHints(state: AgentChromeState): readonly EmptyStateHint[] {
  if (!state.localAgents || !state.detection) return [];
  const hints: EmptyStateHint[] = [];
  const { claude, codex } = state.detection.agents;
  if (claude?.installed && !claude.signedIn) {
    hints.push({
      id: "claude-signed-out",
      before: "Claude Code is installed but not signed in. Run `claude` in a terminal and type /login, then",
      after: ".",
    });
  }
  if (codex?.installed && !codex.signedIn) {
    hints.push({
      id: "codex-signed-out",
      before: "Codex is installed but not signed in. Run `codex login` in a terminal, then",
      after: ".",
    });
  }
  if (hints.length > 0) return hints;
  if (usable(claude) || usable(codex)) return [];
  return [{
    id: "local-hint",
    before: "Already use Claude Code or Codex? Install or sign in on this computer, then",
    after: ".",
  }];
}

export function presentEmptyState(state: AgentChromeState): EmptyStatePresentation {
  const notes: EmptyStateNote[] = [];
  if (state.switchedFrom) {
    notes.push({
      id: "switched",
      text: `Started a new chat with ${agentName(state.backend)}.`,
      action: { id: "back-to-previous", label: "Back to previous chat" },
    });
  }
  const empty = { title: EMPTY_TITLE, offer: null, hints: [] as EmptyStateHint[] };
  if (state.detecting) return { ...empty, lead: null, notes, starters: [] };

  const backend = state.backend;
  if (isLocalAgentId(backend)) {
    const agents = state.detection?.agents;
    const other = otherAgent(backend);
    const mostUsed = !state.chosen
      && usable(agents?.[backend])
      && usable(agents?.[other])
      && state.detection?.preferred === backend;
    const name = LOCAL_AGENTS[backend];
    const lead = mostUsed
      ? `Using ${name}, the agent you use most on this ${state.host}. It runs on your own install and login. No SystemSculpt account or credits needed.`
      : `Using ${name} on this ${state.host}. It runs on your own install and login. No SystemSculpt account or credits needed.`;
    if (state.localAgents && usable(agents?.[other])) {
      notes.push({
        id: "also-ready",
        text: `${LOCAL_AGENTS[other]} is ready too.`,
        action: { id: "switch-below", label: "Switch below", after: "." },
      });
    }
    return { ...empty, lead, notes, starters: starters(state.activeNote) };
  }

  if (!state.localAgents && state.prefersLocalAgent) {
    notes.push({ id: "mobile", text: "Claude Code and Codex run on desktop. Here, chat uses SystemSculpt." });
  }
  if (state.account === "signed-out") {
    return {
      ...empty,
      lead: "Chat with your vault using SystemSculpt.",
      notes,
      offer: { text: FREE_START_OFFER, actions: ["start-free", "sign-in"] },
      hints: localHints(state),
      starters: [],
    };
  }
  if (state.account === "no-plan") {
    return {
      ...empty,
      lead: PLAN_REQUIRED_MESSAGE,
      notes,
      offer: { text: "", actions: ["see-plans"] },
      starters: [],
    };
  }
  return {
    ...empty,
    lead: "Ask about your notes or give SystemSculpt a task.",
    notes,
    starters: starters(state.activeNote),
  };
}
