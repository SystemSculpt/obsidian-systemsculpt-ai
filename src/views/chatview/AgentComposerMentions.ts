import { setIcon, type TFile } from "obsidian";
import { SurfaceCombobox } from "../../core/ui/surface/SurfaceCombobox";

export type ComposerMentionTrigger = Readonly<{
  /** Index of the trigger's first character (`@` or the first `[`). */
  start: number;
  /** Index just past the typed query (and a typed closing `]]`). */
  end: number;
  query: string;
  kind: "@" | "[[";
}>;

/**
 * Finds the mention being typed at the caret: `@` at the start or after a
 * space, or `[[` anywhere. `@` queries stop at whitespace; `[[` queries run to
 * the closing brackets, as in Obsidian's own link suggester.
 * @internal Unit-tested directly.
 */
export function findComposerMentionTrigger(text: string, caret: number): ComposerMentionTrigger | null {
  const before = text.slice(0, caret);
  const wiki = /\[\[([^[\]\n|#^]*)$/.exec(before);
  if (wiki) {
    const closing = text.slice(caret).startsWith("]]") ? 2 : 0;
    return Object.freeze({ start: wiki.index, end: caret + closing, query: wiki[1], kind: "[[" as const });
  }
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) {
    return Object.freeze({ start: at.index + at[1].length, end: caret, query: at[2], kind: "@" as const });
  }
  return null;
}

type MentionOptions = Readonly<{
  suggest: (query: string) => readonly TFile[];
  onPick: (file: TFile, trigger: ComposerMentionTrigger) => void;
  onOpenChange?: (open: boolean) => void;
}>;

let mentionSequence = 0;

/**
 * The `@` / `[[` suggestion popover above the composer. SurfaceCombobox owns
 * the listbox semantics and arrow-key navigation; this adapter owns trigger
 * detection, the file rows, and Tab to insert.
 */
export class AgentComposerMentionPopover {
  public readonly element: HTMLElement;
  private readonly listbox: HTMLElement;
  private combobox: SurfaceCombobox<TFile> | null = null;
  private trigger: ComposerMentionTrigger | null = null;
  /** Esc dismisses the popover for the trigger it was showing. */
  private dismissedAt: number | null = null;

  constructor(
    parent: HTMLElement,
    private readonly input: HTMLTextAreaElement,
    private readonly options: MentionOptions,
  ) {
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-mention",
      attr: { "data-testid": "chat.composer.mention", hidden: "" },
    });
    this.listbox = this.element.createDiv({
      cls: "systemsculpt-agent-mention-list",
      attr: { id: `systemsculpt-agent-mention-${++mentionSequence}` },
    });
  }

  public isOpen(): boolean {
    return this.combobox?.isOpen === true;
  }

  /** Re-reads the trigger at the caret and opens, refreshes, or closes. */
  public update(): void {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const collapsed = caret === (this.input.selectionEnd ?? caret);
    const trigger = collapsed ? findComposerMentionTrigger(this.input.value, caret) : null;
    if (!trigger || trigger.start === this.dismissedAt) {
      if (!trigger) this.dismissedAt = null;
      this.close();
      return;
    }
    this.trigger = trigger;
    const combobox = this.ensureCombobox();
    combobox.setItems(this.options.suggest(trigger.query));
    combobox.setQuery(trigger.query, { writeInput: false });
    this.element.removeAttribute("hidden");
    combobox.setOpen(true);
  }

  /** Inserts the active suggestion; Tab uses this, Enter goes through the combobox. */
  public commitActive(): boolean {
    const item = this.combobox?.activeItem ?? null;
    if (!item || !this.trigger) return false;
    this.pick(item);
    return true;
  }

  public close(): void {
    this.trigger = null;
    this.element.setAttribute("hidden", "");
    if (!this.combobox) return;
    // The message box is a combobox only while suggestions show.
    this.combobox.destroy();
    this.combobox = null;
    for (const name of ["role", "aria-autocomplete", "aria-controls", "aria-expanded", "aria-busy", "aria-activedescendant"]) {
      this.input.removeAttribute(name);
    }
    this.listbox.replaceChildren();
    this.options.onOpenChange?.(false);
  }

  public dispose(): void {
    this.close();
    this.element.remove();
  }

  private ensureCombobox(): SurfaceCombobox<TFile> {
    if (this.combobox) return this.combobox;
    this.combobox = new SurfaceCombobox<TFile>({
      input: this.input,
      listbox: this.listbox,
      listboxLabel: "Notes and files to mention",
      getItemKey: (file) => file.path,
      filterItems: (items) => items,
      bindInputEvents: false,
      initiallyOpen: false,
      activeMode: "first",
      selectionFollowsActive: true,
      navigation: "wrap",
      optionCommitEvent: "pointerdown",
      renderOption: ({ item, listbox }) => this.renderOption(listbox, item),
      renderEmpty: ({ listbox, query }) => {
        listbox.createDiv({
          cls: "systemsculpt-agent-mention-empty",
          text: query ? `No notes match "${query}"` : "No notes yet",
        });
      },
      onCommit: ({ item }) => this.pick(item),
      onEscape: () => {
        this.dismissedAt = this.trigger?.start ?? null;
        this.close();
      },
    });
    this.options.onOpenChange?.(true);
    return this.combobox;
  }

  private renderOption(listbox: HTMLElement, file: TFile): HTMLElement {
    const option = listbox.createDiv({ cls: "systemsculpt-agent-mention-option" });
    const icon = option.createSpan({ cls: "systemsculpt-agent-mention-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, iconForFile(file));
    option.createSpan({
      cls: "systemsculpt-agent-mention-name",
      text: file.extension === "md" ? file.basename : file.name,
    });
    const separator = file.path.lastIndexOf("/");
    const folder = separator > 0 ? file.path.slice(0, separator) : "";
    if (folder) option.createSpan({ cls: "systemsculpt-agent-mention-folder", text: folder });
    option.setAttribute("aria-label", folder ? `${file.name}, in ${folder}` : file.name);
    return option;
  }

  private pick(file: TFile): void {
    const trigger = this.trigger;
    if (!trigger) return;
    this.close();
    this.options.onPick(file, trigger);
  }
}

function iconForFile(file: TFile): string {
  const extension = file.extension.toLowerCase();
  if (extension === "pdf") return "file-text";
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) return "image";
  if (extension === "md") return "file-text";
  return "file-code";
}
