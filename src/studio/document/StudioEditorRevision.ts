import { isStudioProseFieldPath, mergeStudioText } from './StudioTextMerge';

/**
 * A mounted editor submits changes against the text it actually displayed.
 * A keystroke commits its plain value. Only when another writer changed the
 * field after it was displayed are the two edits merged, and a merge that
 * would have to guess keeps the typed value.
 */
export class StudioEditorRevision {
  private readonly shown = new Map<string, string>();

  /** Record the value a control displays, at mount or when patched in place. */
  display(field: string, value: unknown): void {
    if (typeof value === 'string') this.shown.set(field, value); else this.shown.delete(field);
  }

  /** The value to commit for `typed`, given the field's current value in the project. */
  commit(field: string, typed: string, current: unknown): string {
    const shown = this.shown.get(field);
    this.shown.set(field, typed);
    if (!isStudioProseFieldPath(field.startsWith('config:') ? field.slice(7) : field)) return typed;
    if (shown === undefined || typeof current !== 'string' || current === shown || current === typed) return typed;
    return mergeStudioText(shown, typed, current) ?? typed;
  }
}
