import { Component, Menu, setIcon } from "obsidian";
import { getHostOperatingSystem } from "../../platform/hostCapabilities";
import {
  backendMenu,
  modeMenu,
  modelMenu,
  presentRunLine,
  type AgentChromeState,
  type ChromeMenuEntry,
  type RunLineSegment,
} from "./AgentChatChrome";

export type AgentRunLineOptions = Readonly<{
  onSelectBackend: (id: string) => void;
  onSelectMode: (value: string) => void;
  /** `model:<id>`, `effort:<id>` or `tier:<id>`. */
  onModelChange: (id: string) => void;
  onDetectAgain: () => void;
  onOpenSettings: () => void;
  onAction: (action: NonNullable<RunLineSegment["action"]>) => void;
  /** Called before the model menu opens so a slow catalog can start loading. */
  onModelMenuOpen?: () => void;
}>;

type MenuKind = "backend" | "mode" | "detail";

/** Escape dismisses only this menu. Dispose from its owner's sole onHide callback. */
export function containMenuEscape(menu: Menu, ownerDocument: Document): () => void {
  const ownerWindow: { event?: Event } | null = ownerDocument.defaultView;
  // Obsidian's keymap hides the menu on Escape before this listener runs, so
  // onHide disposes during that Escape. Keep the listener for that one event.
  let closingEscape: Event | null = null;
  const release = (): void => ownerDocument.removeEventListener("keydown", onKeydown, true);
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.isComposing) return;
    release();
    // A later Escape belongs to the host, even if the closing one never came.
    if (closingEscape && closingEscape !== event) return;
    event.preventDefault();
    event.stopPropagation();
    menu.hide();
  };
  // The host's bubbling Escape handler otherwise switches to the last note
  // after its menu scope hides the menu without consuming the event.
  ownerDocument.addEventListener("keydown", onKeydown, true);
  // Menu.onHide replaces its callback; the owner composes cleanup with focus.
  return () => {
    const current = ownerWindow?.event;
    if (current?.type === "keydown" && (current as KeyboardEvent).key === "Escape") {
      closingEscape = current;
      return;
    }
    release();
  };
}

/**
 * Focuses `target()` once Obsidian has finished hiding a menu, unless
 * something else, such as a newly started chat, has taken focus meanwhile.
 */
export function returnFocusAfterMenu(host: HTMLElement, target: () => HTMLElement | null | undefined): void {
  const ownerDocument = host.ownerDocument;
  const before = ownerDocument.activeElement;
  (ownerDocument.defaultView ?? window).setTimeout(() => {
    const active = ownerDocument.activeElement;
    const meaningfulFocus = active && active !== ownerDocument.body && !active.closest(".menu");
    const outsideLeaf = !host.closest(".workspace-leaf")?.contains(active);
    if (meaningfulFocus && (active !== before || outsideLeaf) && active !== target()) return;
    const element = target();
    if (element?.isConnected) element.focus();
  }, 0);
}

const SEGMENTS: Readonly<Record<MenuKind, Readonly<{ testId: string }>>> = {
  backend: { testId: "chat.run.backend" },
  mode: { testId: "chat.run.mode" },
  detail: { testId: "chat.run.detail" },
};

/**
 * The one status line under the composer: which backend answers and where it
 * runs, the mode it runs in, and the model or the hosted credits. Every
 * segment opens an Obsidian menu in one click; the line is a toolbar, so it
 * takes one Tab stop and arrow keys move between its segments.
 */
export class AgentRunLine extends Component {
  public readonly element: HTMLElement;
  private state: AgentChromeState | null = null;
  private segments: HTMLButtonElement[] = [];
  private openMenu: Menu | null = null;
  private openMenuKind: MenuKind | null = null;
  private openMenuLoading = false;

  constructor(parent: HTMLElement, private readonly options: AgentRunLineOptions) {
    super();
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-run-line",
      attr: {
        role: "toolbar",
        "aria-label": "Chat run settings",
        "data-testid": "chat.run",
      },
    });
    this.registerDomEvent(this.element, "keydown", (event) => this.handleKeydown(event));
  }

  public override onunload(): void {
    this.openMenu?.hide();
    this.openMenu = null;
  }

  public render(state: AgentChromeState): void {
    this.state = state;
    const focusedKey = this.segments.find((segment) =>
      segment === segment.ownerDocument.activeElement)?.dataset.segment;
    const presentation = presentRunLine(state);
    this.element.empty();
    this.segments = [];
    this.element.classList.toggle("is-detecting", presentation.kind === "detecting");
    if (presentation.kind === "detecting") {
      const status = this.element.createSpan({
        cls: "systemsculpt-agent-run-status",
        attr: { "data-testid": "chat.run.detecting" },
      });
      const icon = status.createSpan({ cls: "systemsculpt-agent-run-icon is-spinning", attr: { "aria-hidden": "true" } });
      setIcon(icon, "loader-circle");
      status.createSpan({ text: presentation.label });
      return;
    }
    presentation.segments.forEach((segment, index) => {
      if (index > 0) {
        this.element.createSpan({ cls: "systemsculpt-agent-run-separator", text: "·", attr: { "aria-hidden": "true" } });
      }
      this.segments.push(this.renderSegment(segment, index === 0));
    });
    const restored = focusedKey
      ? this.segments.find((segment) => segment.dataset.segment === focusedKey)
      : undefined;
    if (restored) {
      this.setRovingFocus(restored);
      restored.focus();
    }
    if (this.openMenuKind) {
      this.segment(this.openMenuKind)?.setAttribute("aria-expanded", "true");
      // The Codex catalog loads when its menu first opens; show the models
      // as soon as they arrive instead of leaving "Loading" on screen.
      if (this.openMenuLoading && state.backend === "codex" && state.codex.models !== null) {
        this.showMenu(this.openMenuKind);
      }
    }
  }

  public openBackendMenu(): void {
    this.showMenu("backend");
  }

  public openModeMenu(): void {
    this.showMenu("mode");
  }

  private renderSegment(segment: RunLineSegment, first: boolean): HTMLButtonElement {
    const button = this.element.createEl("button", {
      cls: `systemsculpt-agent-run-segment is-${segment.key}`,
      attr: {
        type: "button",
        "data-testid": SEGMENTS[segment.key].testId,
        "data-segment": segment.key,
        "aria-label": segment.ariaLabel,
        tabindex: first ? "0" : "-1",
        ...(segment.menu ? { "aria-haspopup": "menu", "aria-expanded": "false" } : {}),
      },
    });
    if (segment.menu && (segment.key === "backend" || segment.key === "mode")) {
      const modifier = getHostOperatingSystem() === "macOS" ? "Meta" : "Control";
      button.setAttribute("aria-keyshortcuts", `${modifier}+${segment.key === "backend" ? "Shift+" : ""}.`);
    }
    if (segment.tone) button.addClass(`is-${segment.tone}`);
    if (segment.key === "mode" && this.state) {
      button.dataset.mode = this.state.backend === "claude"
        ? this.state.claude.mode
        : this.state.backend === "codex"
          ? this.state.codex.mode
          : this.state.hostedMode;
    }
    if (segment.icon) {
      const icon = button.createSpan({ cls: "systemsculpt-agent-run-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, segment.icon);
    }
    const label = button.createSpan({ cls: "systemsculpt-agent-run-label", text: segment.label });
    if (segment.wideSuffix) {
      label.createSpan({ cls: "systemsculpt-agent-run-wide", text: segment.wideSuffix });
    }
    if (segment.menu) {
      const chevron = button.createSpan({ cls: "systemsculpt-agent-run-chevron", attr: { "aria-hidden": "true" } });
      setIcon(chevron, "chevron-down");
    }
    // Segments are rebuilt on every render; a component-registered listener
    // would keep each replaced button alive until the view closes.
    button.addEventListener("click", () => {
      this.setRovingFocus(button);
      if (segment.menu) this.showMenu(segment.key);
      else if (segment.action) this.options.onAction(segment.action);
    });
    return button;
  }

  private showMenu(kind: MenuKind): void {
    const state = this.state;
    const opener = this.segment(kind);
    if (!state || !opener || opener.getAttribute("aria-haspopup") !== "menu") return;
    if (kind === "detail") this.options.onModelMenuOpen?.();
    this.openMenu?.hide();
    const entries = kind === "backend"
      ? backendMenu(state)
      : kind === "mode"
        ? modeMenu(state)
        : modelMenu(state);
    // Items carry a muted second line, which only Obsidian's DOM menu renders;
    // a native macOS menu would flatten title and description into one string.
    const menu = new Menu().setUseNativeMenu(false);
    const ownerDocument = opener.ownerDocument;
    const releaseEscape = containMenuEscape(menu, ownerDocument);
    for (const entry of entries) this.addEntry(menu, kind, entry, (id) => this.select(kind, id));
    menu.onHide(() => {
      releaseEscape();
      if (this.openMenu !== menu) return;
      this.openMenu = null;
      this.openMenuKind = null;
      this.segment(kind)?.setAttribute("aria-expanded", "false");
      // Rule 6.2 (7): menus return focus to the element that opened them.
      // Obsidian refocuses its active leaf after hiding, so this runs after it.
      returnFocusAfterMenu(this.element, () => this.segment(kind));
    });
    this.openMenu = menu;
    this.openMenuKind = kind;
    this.openMenuLoading = kind === "detail" && state.backend === "codex" && state.codex.models === null;
    opener.setAttribute("aria-expanded", "true");
    // Every run-line menu opens from the line's leading edge, so in a sidebar
    // its descriptions stay over the chat instead of spilling over the note.
    const rect = opener.getBoundingClientRect();
    const lineLeft = this.element.getBoundingClientRect().left;
    menu.showAtPosition({ x: Math.min(rect.left, lineLeft), y: rect.top, overlap: true, left: false }, ownerDocument);
  }

  private segment(kind: MenuKind): HTMLButtonElement | undefined {
    return this.segments.find((segment) => segment.dataset.segment === kind);
  }

  private addEntry(menu: Menu, kind: MenuKind, entry: ChromeMenuEntry, onSelect: (id: string) => void): void {
    if (entry.kind === "separator") {
      menu.addSeparator();
      return;
    }
    menu.addItem((item) => {
      if (entry.kind === "label") {
        // Long labels ("Switching starts a new chat…") wrap with the descriptions.
        item.setTitle(createFragment((fragment) => {
          fragment.createSpan({ cls: "systemsculpt-agent-menu-label", text: entry.title });
        })).setIsLabel(true);
        return;
      }
      // Obsidian's menu lives in the main window's realm and adopts its nodes
      // into a pop-out, so the title is built there too.
      const title = createFragment((fragment) => {
        fragment.createSpan({
          cls: "systemsculpt-agent-menu-title",
          text: entry.title,
          // A stable handle for live UI checks: `${menu}.${item}`.
          attr: { "data-menu-item": `${kind}.${entry.id}` },
        });
        if (entry.description) {
          fragment.createSpan({ cls: "systemsculpt-agent-menu-description", text: entry.description });
        }
      });
      item.setTitle(title);
      if (entry.icon) item.setIcon(entry.icon);
      if (entry.checked !== undefined) item.setChecked(entry.checked);
      if (entry.disabled) item.setDisabled(true);
      if (entry.warning) item.setWarning(true);
      item.onClick(() => onSelect(entry.id));
    });
  }

  private select(kind: MenuKind, id: string): void {
    if (kind === "backend") {
      if (id === "detect") this.options.onDetectAgain();
      else if (id === "settings") this.options.onOpenSettings();
      else this.options.onSelectBackend(id);
    } else if (kind === "mode") {
      this.options.onSelectMode(id);
    } else {
      this.options.onModelChange(id);
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    const index = this.segments.findIndex((segment) => segment === event.target);
    if (index < 0) return;
    const last = this.segments.length - 1;
    const next = event.key === "ArrowRight"
      ? (index + 1) % this.segments.length
      : event.key === "ArrowLeft"
        ? (index - 1 + this.segments.length) % this.segments.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowUp" || event.key === "ArrowDown"
              ? -2
              : -1;
    if (next === -1) return;
    event.preventDefault();
    if (next === -2) {
      // Arrow up or down opens the focused segment's menu, as a menu button does.
      this.segments[index].click();
      return;
    }
    this.setRovingFocus(this.segments[next]);
    this.segments[next].focus();
  }

  private setRovingFocus(target: HTMLButtonElement): void {
    for (const segment of this.segments) segment.tabIndex = segment === target ? 0 : -1;
  }
}
