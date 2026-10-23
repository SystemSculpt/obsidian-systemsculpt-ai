import type { App } from "obsidian";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { DiffViewer } from "../../components/DiffViewer";
import { createSurfaceElement } from "../../core/ui/surface";
import { parseUnifiedDiff } from "../../utils/diffUtils";
import {
  nativeToolPath,
  prepareNativeWriteEditPreview,
  renderPreparedWriteEditPreviews,
} from "./ToolCallPreview";

export type NativeToolPresentation = Readonly<{
  title: string;
  completedTitle: string;
  description?: string;
  icon: string;
  agentName: string;
}>;

type Detail = { label: string; value: string; code?: boolean };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function command(input: Record<string, unknown>): string | undefined {
  return text(input.command) ?? (Array.isArray(input.command) ? strings(input.command).join(" ") : undefined);
}
function displayPath(part: AgentToolPart, path: string): string {
  return nativeToolPath(path, part.native!.workingDirectory).displayPath;
}
function kind(part: AgentToolPart): string {
  if (part.native?.agent === "claude") return part.name;
  const method = part.native?.requestMethod ?? "";
  if (method.endsWith("/requestUserInput")) return "questions";
  if (method.includes("/permissions/")) return "permissions";
  if (method.includes("/commandExecution/")) return "commandExecution";
  if (method.includes("/fileChange/")) return "fileChange";
  return text(record(part.input).type) ?? part.name;
}
function fileAction(change: Record<string, unknown>): readonly [string, string, string] {
  const operation = typeof change.kind === "string" ? change.kind : record(change.kind).type;
  if (operation === "add") return ["Create", "Created", "file-plus-2"];
  if (operation === "delete") return ["Delete", "Deleted", "trash-2"];
  if (text(record(change.kind).move_path)) return ["Move and edit", "Moved and edited", "arrow-right-left"];
  return ["Edit", "Edited", "file-pen-line"];
}
/** Native metadata stays separate from hosted-tool names, policy, and summaries. */
export function nativeToolPresentation(part: AgentToolPart): NativeToolPresentation | null {
  if (!part.native) return null;
  const input = record(part.input);
  const agentName = part.native.agent === "claude" ? "Claude Code" : "Codex";
  const description = text(input.description) ?? text(input.reason) ?? text(part.native.description);
  const presentation = (verb: string, completed: string, target: string, icon: string): NativeToolPresentation => ({
    title: `${verb} ${target}`, completedTitle: `${completed} ${target}`, description, icon, agentName,
  });
  const path = text(input.file_path) ?? text(input.path);
  switch (kind(part)) {
    case "Edit":
    case "MultiEdit": return presentation("Edit", "Edited", path ? displayPath(part, path) : "file", "file-pen-line");
    case "Write": return presentation("Write", "Wrote", path ? displayPath(part, path) : "file", "file-plus-2");
    case "Read": return presentation("Read", "Read", path ? displayPath(part, path) : "file", "file-text");
    case "Bash":
    case "commandExecution":
      return input.kind === "writeStdin"
        ? presentation("Send input to", "Sent input to", "a running command", "terminal")
        : presentation("Run", "Ran", command(input) ?? "command", "terminal");
    case "WebFetch": return presentation("Read", "Read", text(input.url) ?? "web page", "globe-2");
    case "WebSearch":
    case "webSearch": return presentation("Search the web for", "Searched the web for", text(input.query) ?? "information", "globe-2");
    case "Grep": return presentation("Search files for", "Searched files for", text(input.pattern) ?? "text", "search");
    case "Glob": return presentation("Find files matching", "Found files matching", text(input.pattern) ?? "a pattern", "file-search");
    case "fileChange": {
      const changes = records(input.changes);
      if (changes.length !== 1) return presentation("Change", "Changed", changes.length ? `${changes.length} files` : "files", "files");
      const [verb, completed, icon] = fileAction(changes[0]);
      const source = text(changes[0].path);
      const destination = text(record(changes[0].kind).move_path);
      const target = source ? displayPath(part, source) : "file";
      return presentation(verb, completed, destination ? `${target} → ${displayPath(part, destination)}` : target, icon);
    }
    case "permissions": return presentation("Allow", "Allowed", "additional access", "shield-check");
    case "questions":
    case "requestUserInput":
    case "AskUserQuestion": return presentation("Answer", "Answered", "a question", "message-circle-question");
    default: return presentation("Run", "Ran", `a ${agentName} action`, "wrench");
  }
}

function permissionPath(part: AgentToolPart, value: unknown): string {
  if (typeof value === "string") return displayPath(part, value);
  const path = record(value);
  if (path.type === "path" && text(path.path)) return displayPath(part, path.path as string);
  if (path.type === "glob_pattern") return `files matching ${text(path.pattern) ?? "the requested pattern"}`;
  const special = record(path.value);
  const names: Record<string, string> = {
    root: "all files on this computer", minimal: "essential system files",
    project_roots: "project folders", tmpdir: "temporary files", slash_tmp: "the /tmp folder",
  };
  const name = names[String(special.kind)] ?? text(special.path) ?? "the requested files";
  return text(special.subpath) ? `${name}/${special.subpath as string}` : name;
}

function permissionDetails(part: AgentToolPart, value: unknown): Detail[] {
  const permissions = record(value);
  const details: Detail[] = [];
  const network = record(permissions.network);
  if (network.enabled === true) details.push({ label: "Access", value: "Connect to the internet" });
  if (network.enabled === false) details.push({ label: "Access", value: "Keep internet access disabled" });
  const files = record(permissions.fileSystem);
  for (const path of strings(files.read)) details.push({ label: "Access", value: `Read ${displayPath(part, path)}` });
  for (const path of strings(files.write)) details.push({ label: "Access", value: `Read and change ${displayPath(part, path)}` });
  for (const entry of records(files.entries)) {
    const verb = entry.access === "read" ? "Read" : entry.access === "write" ? "Read and change" : entry.access === "deny" ? "Block access to" : "Access";
    details.push({ label: "Access", value: `${verb} ${permissionPath(part, entry.path)}` });
  }
  if (!details.length && Object.keys(permissions).length) {
    details.push({ label: "Access", value: "Additional access requested. Review Details for the full request." });
  }
  return details;
}

function previewDetails(part: AgentToolPart): Detail[] {
  const input = record(part.input);
  const details: Detail[] = [];
  const add = (label: string, value: unknown, code = false) => {
    const content = text(value);
    if (content) details.push({ label, value: content, code });
  };
  const toolKind = kind(part);
  if (toolKind === "Bash" || toolKind === "commandExecution") add("Command", command(input), true);
  if (toolKind === "WebFetch") { add("Address", input.url); add("Look for", input.prompt); }
  if (["WebSearch", "webSearch"].includes(toolKind)) add("Search for", input.query);
  if (["Read", "Glob", "Grep"].includes(toolKind)) {
    const path = text(input.file_path) ?? text(input.path);
    if (path) add("File or folder", displayPath(part, path));
    add("Search for", input.pattern);
  }
  if (["Bash", "commandExecution", "permissions"].includes(toolKind)) {
    add("Folder", displayPath(part, text(input.cwd) ?? part.native!.workingDirectory));
  }
  add("Description", input.description);
  add("Reason", input.reason);
  if (part.native?.description !== input.description && part.native?.description !== input.reason) add("Reason", part.native?.description);
  const network = record(input.networkApprovalContext);
  if (text(network.host)) add("Access", `Connect to ${network.host as string}`);
  if (text(input.grantRoot)) add("Access", `Change files in ${displayPath(part, input.grantRoot as string)}`);
  details.push(...permissionDetails(part, input.permissions));
  for (const question of records(input.questions)) add("Question", question.question);
  return details;
}

/** Renders only the preview. Approval controls and raw Details belong to the caller. */
export async function renderNativeToolPreview(app: App, host: HTMLElement, part: AgentToolPart): Promise<boolean> {
  if (!part.native) return false;
  const container = createSurfaceElement(host.ownerDocument, "div");
  container.className = "ss-native-tool-preview";
  const details = previewDetails(part);
  if (details.length) {
    const list = container.createEl("dl", { cls: "ss-agent-tool-details" });
    for (const detail of details) {
      list.createEl("dt", { text: detail.label });
      const value = list.createEl("dd");
      if (detail.code) value.createEl("pre").createEl("code", { text: detail.value });
      else value.textContent = detail.value;
    }
  }
  const preview = await prepareNativeWriteEditPreview(app, part);
  if (preview) renderPreparedWriteEditPreviews(container, [preview]);
  if (kind(part) === "fileChange") {
    const changes = records(record(part.input).changes);
    const diffContainer = container.createDiv({ cls: "systemsculpt-inline-diff" });
    for (const change of changes) {
      const fileName = displayPath(part, text(change.path) ?? "File");
      const [verb] = fileAction(change);
      const destination = text(record(change.kind).move_path);
      diffContainer.createDiv({ cls: "systemsculpt-inline-diff__summary", text: `${verb} ${fileName}${destination ? ` → ${displayPath(part, destination)}` : ""}` });
      const body = diffContainer.createDiv({ cls: "systemsculpt-inline-diff__body" });
      const patch = text(change.diff);
      const diff = patch ? parseUnifiedDiff(patch) : null;
      if (diff && (diff.stats.additions || diff.stats.deletions)) {
        new DiffViewer({ container: body, diffResult: diff, fileName, maxContextLines: 3, showLineNumbers: true }).render();
      } else {
        body.createDiv({ cls: "systemsculpt-diff-no-changes-notice", text: "A line-by-line preview is not available. Review Details for the requested file change." });
        if (patch) body.createEl("pre").createEl("code", { text: patch });
      }
    }
    if (!changes.length) diffContainer.createDiv({ cls: "systemsculpt-diff-no-changes-notice", text: "The requested file changes are not available yet. Review Details before approving." });
  }
  if (!container.childElementCount) {
    container.createEl("p", { text: "Review details for the full request before approving." });
  }
  host.querySelector(":scope > .ss-native-tool-preview")?.remove();
  host.appendChild(container);
  return true;
}
