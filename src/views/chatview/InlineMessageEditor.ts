import { createUiAction, getSurfaceOwnerWindow } from "../../core/ui/surface";

export type AgentInlineMessageEdit = Readonly<{
  messageId: string;
  text: string;
  laterMessageCount: number;
  hasAttachments: boolean;
  unavailableAttachmentCount: number;
  requiresReplayConfirmation: boolean;
}>;

/** Owns one inline editor's submission and owner-window keyboard lifecycle. */
export class InlineMessageEditor {
  private suppressedEditorKeyup: "Escape" | "Enter" | null = null;
  private suppressedEditorKeyupAction: (() => void) | null = null;
  private suppressedEditorKeyupTimer: number | null = null;
  private inlineEditorShortcutCleanup: (() => void) | null = null;
  private readonly containEditorKeyup = (event: KeyboardEvent): void => {
    this.containSuppressedEditorKeyup(event);
  };

  constructor(
    private readonly element: HTMLElement,
    private readonly options: Readonly<{
      onResubmitMessage?: (messageId: string, text: string) => boolean | Promise<boolean>;
      onCancelMessageEdit?: (messageId: string) => void | Promise<void>;
    }>,
  ) {
    element.addEventListener("keyup", this.containEditorKeyup, true);
  }

  public dispose(): void {
    this.deactivate();
    this.clearSuppressedEditorKeyup();
    this.element.removeEventListener("keyup", this.containEditorKeyup, true);
  }

  public render(parent: HTMLElement, edit: AgentInlineMessageEdit): void {
    const editor = parent.createDiv({
      cls: "systemsculpt-agent-message-editor",
      attr: {
        role: "group",
      },
    });
    const input = editor.createEl("textarea", {
      cls: "systemsculpt-agent-message-editor-input",
      attr: {
        rows: "3",
        "aria-label": "Edit message",
        "data-testid": "chat.editor.input",
      },
    });
    input.value = edit.text;

    const consequenceParts: string[] = [];
    if (edit.laterMessageCount > 0) {
      consequenceParts.push(
        `Saving will replace ${edit.laterMessageCount} later ${
          edit.laterMessageCount === 1 ? "message" : "messages"
        } in this chat.`,
      );
    } else {
      consequenceParts.push("Saving will resubmit this message from here.");
    }
    if (edit.unavailableAttachmentCount > 0) {
      consequenceParts.push(
        `${edit.unavailableAttachmentCount} unavailable ${
          edit.unavailableAttachmentCount === 1 ? "attachment" : "attachments"
        } will be left out.`,
      );
    }
    if (edit.requiresReplayConfirmation) {
      consequenceParts.push("Existing vault changes will not be undone. You will confirm before resubmitting.");
    }
    consequenceParts.push("Ctrl or Command Enter to save. Escape to cancel.");
    const hint = editor.createDiv({
      cls: "systemsculpt-agent-message-editor-hint",
      text: consequenceParts.join(" "),
    });
    const hintId = `systemsculpt-agent-message-editor-hint-${edit.messageId}`;
    hint.id = hintId;
    input.setAttribute("aria-describedby", hintId);

    const actions = editor.createDiv({ cls: "systemsculpt-agent-message-editor-actions" });
    const cancel = createUiAction(actions, {
      label: "Cancel",
      testId: "chat.editor.cancel",
      size: "small",
    });
    const save = createUiAction(actions, {
      label: "Save and resubmit",
      testId: "chat.editor.save-resubmit",
      tone: "primary",
      size: "small",
    });
    let submitting = false;
    const sync = (): void => {
      const empty = input.value.trim().length === 0 && !edit.hasAttachments;
      input.disabled = submitting;
      cancel.disabled = submitting;
      save.disabled = submitting || empty;
      editor.setAttribute("aria-busy", String(submitting));
    };
    const cancelEdit = (): void => {
      if (submitting) return;
      void this.options.onCancelMessageEdit?.(edit.messageId);
    };
    const submitEdit = async (): Promise<void> => {
      if (submitting || (input.value.trim().length === 0 && !edit.hasAttachments)) return;
      submitting = true;
      sync();
      let accepted = false;
      try {
        accepted = await this.options.onResubmitMessage?.(edit.messageId, input.value.trim()) === true;
      } finally {
        if (!accepted && input.isConnected) {
          submitting = false;
          sync();
          input.focus();
        }
      }
    };
    input.oninput = () => {
      input.setCssStyles({ height: "auto" });
      const next = Math.min(Math.max(input.scrollHeight, 96), 280);
      input.setCssStyles({ height: `${next}px` });
      sync();
    };
    const handleEditorKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.suppressEditorKeyup("Escape", cancelEdit);
        return;
      }
      if (
        event.key === "Enter"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !event.isComposing
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.suppressEditorKeyup("Enter");
        void submitEdit();
      }
    };
    input.onkeydown = handleEditorKeydown;
    cancel.onclick = cancelEdit;
    save.onclick = () => void submitEdit();
    this.installInlineEditorShortcutGuard(input, handleEditorKeydown);
    sync();
  }

  private installInlineEditorShortcutGuard(
    input: HTMLTextAreaElement,
    handleKeydown: (event: KeyboardEvent) => void,
  ): void {
    this.deactivate();
    const ownerWindow = getSurfaceOwnerWindow(input);
    const keydown = (event: KeyboardEvent): void => {
      if (event.target === input) handleKeydown(event);
    };
    const keyup = (event: KeyboardEvent): void => {
      this.containSuppressedEditorKeyup(event);
    };
    ownerWindow.addEventListener("keydown", keydown, true);
    ownerWindow.addEventListener("keyup", keyup, true);
    this.inlineEditorShortcutCleanup = () => {
      ownerWindow.removeEventListener("keydown", keydown, true);
      ownerWindow.removeEventListener("keyup", keyup, true);
    };
  }

  public deactivate(): void {
    this.inlineEditorShortcutCleanup?.();
    this.inlineEditorShortcutCleanup = null;
  }

  private containSuppressedEditorKeyup(event: KeyboardEvent): boolean {
    if (event.key !== this.suppressedEditorKeyup) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const action = this.suppressedEditorKeyupAction;
    this.clearSuppressedEditorKeyup();
    action?.();
    return true;
  }

  private suppressEditorKeyup(
    key: "Escape" | "Enter",
    afterKeyup: (() => void) | null = null,
  ): void {
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    if (this.suppressedEditorKeyupTimer !== null) {
      ownerWindow.clearTimeout(this.suppressedEditorKeyupTimer);
    }
    this.suppressedEditorKeyup = key;
    this.suppressedEditorKeyupAction = afterKeyup;
    this.suppressedEditorKeyupTimer = ownerWindow.setTimeout(() => {
      const action = this.suppressedEditorKeyupAction;
      this.suppressedEditorKeyup = null;
      this.suppressedEditorKeyupAction = null;
      this.suppressedEditorKeyupTimer = null;
      action?.();
    }, 500);
  }

  private clearSuppressedEditorKeyup(): void {
    if (this.suppressedEditorKeyupTimer !== null) {
      getSurfaceOwnerWindow(this.element).clearTimeout(this.suppressedEditorKeyupTimer);
    }
    this.suppressedEditorKeyup = null;
    this.suppressedEditorKeyupAction = null;
    this.suppressedEditorKeyupTimer = null;
  }

}
