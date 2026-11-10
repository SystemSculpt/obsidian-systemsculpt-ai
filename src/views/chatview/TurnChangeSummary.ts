import type { AgentToolPart } from "../../chat/ChatConversation";
import { splitToolName } from "../../utils/toolPolicy";
import { parseUnifiedDiff } from "../../utils/diffUtils";
import { nativeToolPath } from "../../utils/nativeToolPath";
import { editChangeSize, noteDisplayName } from "./NativeToolPresentation";
import { hostedChangeSize } from "./AgentToolPresentation";

export type TurnChange = Readonly<{ path: string; label: string; meta?: string; deleted?: true }>;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function paths(value: unknown): string[] { return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
/** A note as Obsidian names it ("Launch plan", not "Launch plan.md"); a short name never breaks across lines. */
function name(path: string): string {
  const shown = noteDisplayName(path.split(/[\\/]/u).filter(Boolean).pop() ?? path);
  return shown.length <= 32 ? shown.replace(/ /gu, "\u00a0") : shown;
}
/** "Moved Old to Archive" when only its folder changed, as its row says; else "Moved Old → Archive/Older". */
function moved(source: string, destination: string): string {
  const slash = destination.search(/[\\/][^\\/]*$/u);
  if (destination.slice(slash + 1) !== source.split(/[\\/]/u).filter(Boolean).pop()) return `Moved ${name(source)} → ${noteDisplayName(destination)}`;
  return `Moved ${name(source)} to ${slash > 0 ? destination.slice(0, slash) : "the vault root"}`;
}
/** "+3 −1", "+3" or "−1": a zero says nothing. */
function size(added: number, removed: number): string | undefined {
  return [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ") || undefined;
}
const COUNTS = /^(?:\+(\d+))?(?: ?−(\d+))?$/u;
function counts(meta: string | undefined): readonly [number, number] | null {
  const match = meta ? COUNTS.exec(meta) : null;
  return match && (match[1] || match[2]) ? [Number(match[1] ?? 0), Number(match[2] ?? 0)] : null;
}
/** A write of the whole note: made, written or replaced. It names the note's whole change in the turn. */
const WHOLE_WRITES: ReadonlySet<string> = new Set(["new", "written", "replaced"]);
/** A note changed more than once in a turn reads its whole change: counts add up, an uncounted change leaves none. */
function mergedMeta(earlier: TurnChange | undefined, meta: string | undefined): string | undefined {
  if (!earlier || earlier.deleted) return meta;
  if (earlier.meta && WHOLE_WRITES.has(earlier.meta)) return earlier.meta;
  const before = counts(earlier.meta), after = counts(meta);
  if (before && after) return size(before[0] + after[0], before[1] + after[1]);
  return meta && WHOLE_WRITES.has(meta) ? meta : undefined;
}
function nativePath(part: AgentToolPart, path: string): ReturnType<typeof nativeToolPath> {
  const { workingDirectory, vaultRoot, vaultRootAlias, homeDirectory } = part.native!;
  return nativeToolPath(path, workingDirectory, vaultRoot, vaultRootAlias, homeDirectory);
}

/** A summary is a receipt, never a prediction from an approval or a failed input. */
export function presentTurnChanges(parts: readonly AgentToolPart[]): readonly TurnChange[] {
  const changes = new Map<string, TurnChange>();
  for (const part of parts) {
    if (part.state !== "succeeded" && part.state !== "failed") continue;
    const input = record(part.input);
    const output = record(part.output?.data);
    const add = (path: string, meta?: string, label = name(path), deleted = false) => {
      const target = part.native ? nativePath(part, path) : { displayPath: path, vaultPath: path };
      // External native changes aren't links into the user's vault.
      if (!target.vaultPath) return;
      const merged = deleted ? meta : mergedMeta(changes.get(target.vaultPath), meta);
      changes.set(target.vaultPath, { path: target.vaultPath, label, ...(merged ? { meta: merged } : {}), ...(deleted ? { deleted: true } : {}) });
    };
    // A note made or changed earlier in the turn and then moved is one note: it is listed once, where it ended up.
    const move = (source: string, destination: string, label: string) => {
      const from = part.native ? nativePath(part, source).vaultPath : source;
      const earlier = from ? changes.get(from) : undefined;
      if (from && from !== destination) changes.delete(from);
      add(destination, earlier?.meta, label);
    };
    if (part.native) {
      if (part.state !== "succeeded" || output.success === false) continue;
      if (["Edit", "MultiEdit", "Write"].includes(part.name)) {
        // Each change reads the count its row shows ("+1 −1").
        const size = part.name === "Write" ? "written" : editChangeSize(part.name === "MultiEdit" ? rows(input.edits) : [input], "old_string", "new_string");
        for (const path of paths(input.file_path)) add(path, size);
      } else if (part.name === "fileChange" || input.type === "fileChange") {
        for (const change of rows(input.changes)) {
          const path = paths(change.path)[0];
          if (!path) continue;
          const kind = record(change.kind);
          const operation = typeof change.kind === "string" ? change.kind : kind.type;
          const destination = paths(kind.move_path)[0];
          const diff = typeof change.diff === "string" ? parseUnifiedDiff(change.diff) : null;
          const meta = operation === "add" ? "new" : operation === "delete" ? undefined
            : diff ? size(diff.stats.additions, diff.stats.deletions) : undefined;
          if (destination) move(path, destination, moved(path, nativePath(part, destination).displayPath));
          // The receipt's own pattern: a note and its change, "Draft (deleted)".
          else add(path, operation === "delete" ? "deleted" : meta, name(path), operation === "delete");
        }
      }
      continue;
    }
    const { canonicalName } = splitToolName(part.name);
    if (part.location !== "vault" || !["write", "edit", "multi_edit", "move", "trash"].includes(canonicalName)) continue;
    const results = rows(output.results);
    // A batch's note reads the count its own edits and result give, as the row adds them up.
    const fileChangeSize = (path: string, result: Record<string, unknown>): string | undefined => canonicalName === "multi_edit"
      ? hostedChangeSize("multi_edit", { files: rows(input.files).filter(file => paths(file.path)[0] === path) }, { results: [result] })
      : hostedChangeSize(canonicalName, input, result);
    const successful = results.filter(result => result.success === true);
    if (results.length) {
      for (const result of successful) {
        const path = paths(result.path)[0];
        const source = paths(result.source)[0], destination = paths(result.destination)[0];
        if (canonicalName === "move" && source && destination) move(source, destination, moved(source, destination));
        // Trash keeps the note: it was moved there, as the row says, not deleted; "Draft (in trash)".
        else if (canonicalName === "trash") { if (path) add(path, "in trash", name(path), true); }
        else if (path) add(path, fileChangeSize(path, result));
      }
    } else if (part.state !== "succeeded" || output.success === false || Array.isArray(output.results)) {
      continue;
    } else if (canonicalName === "move") {
      for (const item of rows(input.items)) {
        const source = paths(item.source)[0], destination = paths(item.destination)[0];
        if (source && destination) move(source, destination, moved(source, destination));
      }
    } else if (canonicalName === "trash") {
      for (const path of paths(input.paths)) add(path, "in trash", name(path), true);
    } else if (canonicalName === "multi_edit") {
      for (const file of rows(input.files)) for (const path of paths(file.path)) add(path, hostedChangeSize("multi_edit", { files: [file] }, output));
    } else {
      const whole = output.created === true ? "new" : output.created === false && input.ifExists !== "append" ? "replaced" : undefined;
      for (const path of paths(input.path)) add(path, whole ?? hostedChangeSize(canonicalName, input, output));
    }
  }
  return Array.from(changes.values());
}
