import type { StudioTextNodeFocusTarget } from "./canvas/StudioGraphTextNodeFocus";
import type { StudioTextNodeMarkdownEditorSnapshot } from "./canvas/StudioGraphTextNodeCard";

type EditorTeardown = () => StudioTextNodeMarkdownEditorSnapshot;
type EditSession = {
  editing: boolean;
  dirty: boolean;
  focusAt?: StudioTextNodeFocusTarget;
  snapshot?: StudioTextNodeMarkdownEditorSnapshot;
  teardown?: EditorTeardown;
};

export type StudioTextEditorMountState = {
  isEditing: boolean;
  shouldAutoFocus: boolean;
  initialFocusPoint?: StudioTextNodeFocusTarget;
  initialEditorSnapshot?: StudioTextNodeMarkdownEditorSnapshot;
};

/** Owns native editor lifetime and remount state; never mutates the graph or history. */
export class StudioTextEditSessions {
  private readonly sessions = new Map<string, EditSession>();
  private autofocusNodeId: string | null = null;

  public isEditing(nodeId: string): boolean {
    return this.sessions.get(nodeId.trim())?.editing === true;
  }

  public begin(nodeId: string, options?: { autoFocus?: boolean; focusAt?: StudioTextNodeFocusTarget }): boolean {
    const id = nodeId.trim();
    if (!id) return false;
    const session = this.sessions.get(id) ?? { editing: false, dirty: false };
    if (session.editing && options?.autoFocus !== true) return false;
    if (!session.editing) {
      session.dirty = false;
      session.snapshot = undefined;
    }
    session.editing = true;
    if (options?.autoFocus === true) {
      this.autofocusNodeId = id;
      session.focusAt = options.focusAt;
    }
    this.sessions.set(id, session);
    return true;
  }

  public markDirty(nodeId: string): void {
    const session = this.sessions.get(nodeId.trim());
    if (session?.editing) session.dirty = true;
  }

  /** Ends a user edit, returning its transaction state without destroying mounted DOM. */
  public end(nodeId: string): { dirty: boolean } | null {
    const id = nodeId.trim();
    const session = this.sessions.get(id);
    const result = session?.editing ? { dirty: session.dirty } : null;
    if (session) {
      session.editing = false;
      session.dirty = false;
      session.focusAt = undefined;
      session.snapshot = undefined;
      if (!session.teardown) this.sessions.delete(id);
    }
    if (this.autofocusNodeId === id) this.autofocusNodeId = null;
    return result;
  }

  /** Project/history reset cancels edit transactions; the next DOM teardown still destroys every editor. */
  public clear(): void {
    for (const id of this.sessions.keys()) this.end(id);
  }

  public takeMountState(nodeId: string): StudioTextEditorMountState {
    const id = nodeId.trim();
    const session = this.sessions.get(id);
    const state = {
      isEditing: session?.editing === true,
      shouldAutoFocus: this.autofocusNodeId === id,
      initialFocusPoint: session?.focusAt,
      initialEditorSnapshot: session?.snapshot,
    };
    if (this.autofocusNodeId === id) this.autofocusNodeId = null;
    if (session) {
      session.focusAt = undefined;
      session.snapshot = undefined;
    }
    return state;
  }

  public registerEditor(nodeId: string, teardown: EditorTeardown): void {
    const id = nodeId.trim();
    if (!id) return;
    const session = this.sessions.get(id) ?? { editing: false, dirty: false };
    this.sessions.set(id, session);
    const previous = session.teardown;
    session.teardown = undefined;
    this.disposeEditor(id, session, previous, "replace");
    // Native destruction can synchronously end the session through blur callbacks.
    const current = this.sessions.get(id) ?? session;
    current.teardown = teardown;
    this.sessions.set(id, current);
  }

  public disposeMountedEditors(): void {
    // Detach every old handle first: a teardown may synchronously mount a replacement.
    const mounted = Array.from(this.sessions, ([id, session]) => {
      const teardown = session.teardown;
      session.teardown = undefined;
      return { id, session, teardown };
    });
    for (const { id, session, teardown } of mounted) {
      this.disposeEditor(id, session, teardown, "dispose");
      if (this.sessions.get(id) === session && !session.editing && !session.teardown) this.sessions.delete(id);
    }
  }

  private disposeEditor(id: string, session: EditSession, teardown: EditorTeardown | undefined, action: "replace" | "dispose"): void {
    if (!teardown) return;
    try {
      const snapshot = teardown();
      session.snapshot = session.editing ? snapshot : undefined;
    } catch (error) {
      session.snapshot = undefined;
      console.warn(`[SystemSculpt Studio] Failed to ${action} a text-node editor`, {
        nodeId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
