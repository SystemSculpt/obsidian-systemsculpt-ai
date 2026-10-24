import type { AgentToolPart } from "../../chat/ChatConversation";
import { splitToolName } from "../../utils/toolPolicy";
import { parseUnifiedDiff } from "../../utils/diffUtils";
import { nativeToolPath } from "./ToolCallPreview";

export type TurnChange = Readonly<{ path: string; label: string; meta?: string }>;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function paths(value: unknown): string[] { return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function name(path: string): string { return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path; }

/** A summary is a receipt, never a prediction from an approval or a failed input. */
export function presentTurnChanges(parts: readonly AgentToolPart[]): readonly TurnChange[] {
  const changes = new Map<string, TurnChange>();
  for (const part of parts) {
    if (part.state !== "succeeded" && part.state !== "failed") continue;
    const input = record(part.input);
    const output = record(part.output?.data);
    const add = (path: string, meta?: string, label = name(path)) => {
      const target = part.native ? nativeToolPath(path, part.native.workingDirectory) : { displayPath: path, vaultPath: path };
      // External native changes aren't links into the user's vault.
      if (!target.vaultPath) return;
      changes.set(target.vaultPath, { path: target.vaultPath, label, ...(meta ? { meta } : {}) });
    };
    if (part.native) {
      if (part.state !== "succeeded" || output.success === false) continue;
      if (["Edit", "MultiEdit", "Write"].includes(part.name)) {
        for (const path of paths(input.file_path)) add(path, part.name === "Write" ? "written" : undefined);
      } else if (part.name === "fileChange" || input.type === "fileChange") {
        for (const change of rows(input.changes)) {
          const path = paths(change.path)[0];
          if (!path) continue;
          const kind = record(change.kind);
          const operation = typeof change.kind === "string" ? change.kind : kind.type;
          const destination = paths(kind.move_path)[0];
          const diff = typeof change.diff === "string" ? parseUnifiedDiff(change.diff) : null;
          const meta = operation === "add" ? "new" : operation === "delete" ? "deleted"
            : diff ? `+${diff.stats.additions} −${diff.stats.deletions}` : undefined;
          if (destination) add(destination, undefined, `Moved ${name(path)} → ${nativeToolPath(destination, part.native.workingDirectory).displayPath}`);
          else add(path, meta, operation === "delete" ? `Deleted ${name(path)}` : name(path));
        }
      }
      continue;
    }
    const { canonicalName } = splitToolName(part.name);
    if (part.location !== "vault" || !["write", "edit", "multi_edit", "move", "trash"].includes(canonicalName)) continue;
    const results = rows(output.results);
    const successful = results.filter(result => result.success === true);
    if (results.length) {
      for (const result of successful) {
        const path = paths(result.path)[0];
        const source = paths(result.source)[0], destination = paths(result.destination)[0];
        if (canonicalName === "move" && source && destination) add(destination, undefined, `Moved ${name(source)} → ${destination}`);
        else if (path) add(path, canonicalName === "trash" ? "in trash" : undefined, canonicalName === "trash" ? `Deleted ${name(path)}` : name(path));
      }
    } else if (part.state !== "succeeded" || output.success === false || Array.isArray(output.results)) {
      continue;
    } else if (canonicalName === "move") {
      for (const item of rows(input.items)) {
        const source = paths(item.source)[0], destination = paths(item.destination)[0];
        if (source && destination) add(destination, undefined, `Moved ${name(source)} → ${destination}`);
      }
    } else if (canonicalName === "trash") {
      for (const path of paths(input.paths)) add(path, "in trash", `Deleted ${name(path)}`);
    } else if (canonicalName === "multi_edit") {
      for (const file of rows(input.files)) for (const path of paths(file.path)) add(path);
    } else {
      for (const path of paths(input.path)) add(path, output.created === true ? "new" : undefined);
    }
  }
  return Array.from(changes.values());
}
