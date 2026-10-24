import { MarkdownRenderer, type App, type Component } from "obsidian";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { DiffViewer } from "../../components/DiffViewer";
import { createSurfaceElement, createUiAction } from "../../core/ui/surface";
import { generateDiff, parseUnifiedDiff } from "../../utils/diffUtils";
import {
  nativeToolPath,
  prepareNativeWriteEditPreview,
  renderPreparedWriteEditPreviews,
} from "./ToolCallPreview";

export type NativeToolPresentation = Readonly<{
  title: string;
  completedTitle: string;
  runningTitle: string;
  approvalTitle: string;
  description?: string;
  meta?: string;
  changeSize?: string;
  path?: string;
  targetPath?: string;
  icon: string;
  agentName: string;
  groupKind: string;
  groupCount: number;
}>;

type Detail = { label: string; value: string; code?: boolean; path?: string };

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
  const { workingDirectory, vaultRoot, vaultRootAlias } = part.native!;
  return nativeToolPath(path, workingDirectory, vaultRoot, vaultRootAlias).displayPath;
}
function basename(path: string): string { return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path; }
function kind(part: AgentToolPart): string {
  if (part.native?.agent === "claude") return part.name;
  const method = part.native?.requestMethod ?? "";
  if (method.endsWith("/requestUserInput")) return "questions";
  if (method.includes("/permissions/")) return "permissions";
  if (method.includes("/commandExecution/")) return "commandExecution";
  if (method.includes("/fileChange/")) return "fileChange";
  return text(record(part.input).type) ?? part.name;
}
function fileAction(change: Record<string, unknown>): readonly [string, string, string, string] {
  const operation = typeof change.kind === "string" ? change.kind : record(change.kind).type;
  if (operation === "add") return ["Create", "Created", "Creating", "file-plus-2"];
  if (operation === "delete") return ["Delete", "Deleted", "Deleting", "trash-2"];
  if (text(record(change.kind).move_path)) return ["Move and edit", "Moved and edited", "Moving and editing", "arrow-right-left"];
  return ["Edit", "Edited", "Editing", "file-pen-line"];
}
function host(url: string | undefined): string {
  if (!url) return "web page";
  try { return new URL(url).host; } catch { return "web page"; }
}
function changeSize(input: Record<string, unknown>): string | undefined {
  const diffs = records(input.changes).flatMap(change => {
    const patch = text(change.diff);
    const parsed = patch ? parseUnifiedDiff(patch) : null;
    return parsed ? [parsed.stats] : [];
  });
  if (!diffs.length) return undefined;
  return `+${diffs.reduce((sum, diff) => sum + diff.additions, 0)} −${diffs.reduce((sum, diff) => sum + diff.deletions, 0)}`;
}
function realReason(part: AgentToolPart, target: string, title: string): string | undefined {
  const input = record(part.input);
  const candidates = [text(input.description), text(input.reason), text(part.native?.description)];
  const targets = [target, basename(target), text(input.file_path), text(input.path)].filter((value): value is string => Boolean(value));
  const repeated = [title, ...targets.flatMap(value => [value, `${part.name} ${value}`, `${title.split(" ")[0]} ${value}`])];
  return candidates.find(candidate => candidate && !repeated.some(value => candidate.toLowerCase() === value.toLowerCase()));
}

/** Native metadata stays separate from hosted-tool names, policy, and summaries. */
export function nativeToolPresentation(part: AgentToolPart): NativeToolPresentation | null {
  if (!part.native) return null;
  const input = record(part.input);
  const agentName = part.native.agent === "claude" ? "Claude Code" : "Codex";
  const presentation = (verb: string, completed: string, running: string, target: string, icon: string, groupKind: string, options: { path?: string; approval?: string; count?: number; meta?: string } = {}): NativeToolPresentation => {
    const path = options.path ? nativeToolPath(options.path, part.native!.workingDirectory) : undefined;
    const title = `${verb} ${target}`;
    const description = realReason(part, path?.displayPath ?? target, title);
    const folder = path?.displayPath.includes("/") ? path.displayPath.slice(0, path.displayPath.lastIndexOf("/")) : undefined;
    return {
      title, completedTitle: `${completed} ${target}`, runningTitle: `${running} ${target}…`,
      approvalTitle: options.approval ?? `${verb.toLowerCase()} ${target}`,
      ...(description ? { description } : {}),
      ...(path ? { path: path.displayPath, ...(path.vaultPath ? { targetPath: path.vaultPath } : {}) } : {}),
      meta: [options.meta ?? folder, description].filter(Boolean).join(" · ") || undefined,
      icon, agentName, groupKind, groupCount: options.count ?? 1,
    };
  };
  const rawPath = text(input.file_path) ?? text(input.path);
  const path = rawPath ? displayPath(part, rawPath) : undefined;
  const target = path ? basename(path) : "file";
  switch (kind(part)) {
    case "Edit":
    case "MultiEdit": return presentation("Edit", "Edited", "Editing", target, "file-pen-line", "edit", { path: rawPath });
    case "Write": return presentation("Create", "Created", "Creating", target, "file-plus-2", "write", { path: rawPath });
    case "Read": return presentation("Read", "Read", "Reading", target, "file-text", "read", { path: rawPath });
    case "LS": return presentation("List", "Listed", "Listing", path ?? "vault", "list-tree", "list", { path: rawPath });
    case "Bash":
    case "commandExecution": {
      if (input.kind === "writeStdin") return presentation("Send input to", "Sent input to", "Sending input to", "a running command", "terminal", "command");
      const cmd = command(input)?.replace(/\s+/gu, " ").trim() ?? "command";
      return presentation("Run", "Ran", "Running", cmd.length > 40 ? `${cmd.slice(0, 39)}…` : cmd, "terminal", "command", {
        approval: "run a command", meta: `in ${displayPath(part, text(input.cwd) ?? part.native.workingDirectory)}`,
      });
    }
    case "WebFetch": return presentation("Read", "Read", "Opening", host(text(input.url)), "globe-2", "web", { approval: `fetch ${host(text(input.url))}` });
    case "WebSearch":
    case "webSearch": return presentation("Search the web for", "Searched the web for", "Searching the web for", `“${text(input.query) ?? "information"}”`, "globe-2", "web-search", { approval: "search the web" });
    case "Grep": return presentation("Search", "Searched", "Searching", `“${text(input.pattern) ?? "text"}”`, "search", "search");
    case "Glob": return presentation("List", "Listed", "Listing", text(input.pattern) ?? "files", "file-search", "list");
    case "TodoWrite":
    case "plan": {
      const todos = records(input.todos ?? input.plan);
      const done = todos.filter(todo => todo.status === "completed").length;
      return { ...presentation("Update", "Updated", "Updating", "plan", "list-checks", "plan"), runningTitle: "Planning…", meta: todos.length ? `${done} of ${todos.length} done` : undefined };
    }
    case "ExitPlanMode": return { ...presentation("Approve", "Approved", "Preparing", "plan", "list-checks", "plan"), approvalTitle: "has a plan", completedTitle: "Plan approved" };
    case "fileChange": {
      const changes = records(input.changes);
      if (changes.length !== 1) return { ...presentation("Change", "Changed", "Changing", changes.length ? `${changes.length} files` : "files", "files", "edit", { count: changes.length || 1, meta: changeSize(input) }), changeSize: changeSize(input) };
      const [verb, completed, running, icon] = fileAction(changes[0]);
      const source = text(changes[0].path);
      const destination = text(record(changes[0].kind).move_path);
      const name = source ? basename(displayPath(part, source)) : "file";
      const size = changeSize(input);
      const sourcePath = source ? displayPath(part, source) : "";
      const folder = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : undefined;
      return { ...presentation(verb, completed, running, destination ? `${name} → ${basename(displayPath(part, destination))}` : name, icon, verb === "Create" ? "write" : verb === "Delete" ? "trash" : "edit", {
        path: source, meta: [folder, size].filter(Boolean).join(" · ") || undefined,
      }), changeSize: size };
    }
    case "permissions": return presentation("Allow", "Allowed", "Requesting", "additional access", "shield-check", "permission");
    case "questions":
    case "requestUserInput":
    case "AskUserQuestion": return presentation("Answer", "Answered", "Asking", "a question", "message-circle-question", "question");
    default: return presentation("Use", "Used", "Using", part.name, "wrench", `unknown:${part.name}`);
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
  if (network.enabled === true) details.push({ label: "Access", value: "Network access" });
  if (network.enabled === false) details.push({ label: "Access", value: "Keep internet access disabled" });
  const files = record(permissions.fileSystem);
  for (const path of strings(files.read)) details.push({ label: "Access", value: `Read ${displayPath(part, path)}` });
  const writeVerb = (value: unknown): string => {
    const path = typeof value === "string" ? value : record(value).type === "path" ? text(record(value).path) : undefined;
    if (!path) return "Read and change";
    const target = nativeToolPath(path, part.native!.workingDirectory);
    return target.vaultPath || target.displayPath === "Vault root" ? "Read and change" : "Write outside this vault:";
  };
  for (const path of strings(files.write)) details.push({ label: "Access", value: `${writeVerb(path)} ${displayPath(part, path)}` });
  for (const entry of records(files.entries)) {
    const verb = entry.access === "read" ? "Read" : entry.access === "write" ? writeVerb(entry.path) : entry.access === "deny" ? "Block access to" : "Access";
    details.push({ label: "Access", value: `${verb} ${permissionPath(part, entry.path)}` });
  }
  if (!details.length && Object.keys(permissions).length) details.push({ label: "Access", value: "Additional access requested. Review Details for the full request." });
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
  if (toolKind === "Bash" || toolKind === "commandExecution") add("Command", command(input) ? `$ ${command(input)}` : undefined, true);
  if (toolKind === "WebFetch") { add("Address", input.url); add("Look for", input.prompt); }
  if (["WebSearch", "webSearch"].includes(toolKind)) add("Search for", input.query);
  if (["Read", "LS", "Glob", "Grep"].includes(toolKind)) {
    const path = text(input.file_path) ?? text(input.path);
    if (path) details.push({ label: "File or folder", value: displayPath(part, path), path: nativeToolPath(path, part.native!.workingDirectory).vaultPath ?? undefined });
    add("Search for", input.pattern);
  }
  const network = record(input.networkApprovalContext);
  if (text(network.host)) add("Access", `Connect to ${network.host as string}`);
  if (text(input.grantRoot)) add("Access", `Change files in ${displayPath(part, input.grantRoot as string)}`);
  details.push(...permissionDetails(part, input.permissions));
  return details;
}
function renderOutput(container: HTMLElement, output: unknown): void {
  const data = record(output);
  const content = typeof output === "string" ? output : text(data.aggregatedOutput) ?? text(data.output)
    ?? (Array.isArray(output) ? output.flatMap(value => text(record(value).text) ?? []).join("\n") : undefined);
  if (!content) return;
  const lines = content.split("\n");
  const pre = container.createEl("pre", { cls: "ss-native-tool-output", attr: { tabindex: "0" } });
  pre.createEl("code", { text: lines.length > 20 ? lines.slice(-20).join("\n") : content });
  if (lines.length > 20) {
    const all = createUiAction(container, { label: `Show all ${lines.length} lines`, testId: "chat.tool.show-output", size: "small", tooltip: false });
    all.onclick = () => { pre.firstChild!.textContent = content; all.remove(); };
  }
}

function renderRequestedWriteEdit(container: HTMLElement, part: AgentToolPart): void {
  const input = record(part.input);
  if (part.name === "Write") {
    container.createEl("p", { text: "Requested file content. The original file is unavailable; this is not a before-and-after diff." });
    if (typeof input.content === "string") {
      if (input.content) renderOutput(container, input.content);
      else container.createEl("p", { text: "The requested content is empty." });
    }
    return;
  }
  container.createEl("p", { text: "Requested text changes only. Original file line numbers are unavailable; this preview does not verify where or how many times the text was replaced." });
  const edits = part.name === "MultiEdit" ? records(input.edits) : [input];
  for (const [index, edit] of edits.entries()) {
    if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") continue;
    const body = container.createDiv({ cls: "systemsculpt-inline-diff__body" });
    if (edits.length > 1) body.createEl("p", { text: `Requested edit ${index + 1}` });
    const context = Math.max(edit.old_string.split("\n").length, edit.new_string.split("\n").length);
    const diff = generateDiff(edit.old_string, edit.new_string, context);
    if (!diff.stats.additions && !diff.stats.deletions) {
      body.createEl("p", { text: edit.old_string === edit.new_string ? "The requested text is unchanged." : "The request changes the final line break." });
      continue;
    }
    new DiffViewer({
      container: body.createDiv(),
      diffResult: { ...diff, lines: diff.lines.map(({ type, content }) => ({ type, content })) },
      fileName: displayPath(part, text(input.file_path) ?? "File"),
      hideHeader: true, showLineNumbers: false, maxContextLines: 3,
    }).render();
  }
}

/** Renders only the preview. Approval controls and raw Details belong to the caller. */
export async function renderNativeToolPreview(app: App, host: HTMLElement, part: AgentToolPart, component?: Component): Promise<boolean> {
  if (!part.native) return false;
  delete host.dataset.changeSize;
  const container = createSurfaceElement(host.ownerDocument, "div");
  container.className = "ss-native-tool-preview";
  const details = previewDetails(part);
  if (details.length) {
    const list = container.createEl("dl", { cls: "ss-agent-tool-details" });
    for (const detail of details) {
      if (!detail.code) list.createEl("dt", { text: detail.label });
      const value = list.createEl("dd");
      if (detail.code) value.createEl("pre", { attr: { tabindex: "0" } }).createEl("code", { text: detail.value });
      else if (detail.path) {
        const path = detail.path;
        const link = value.createEl("a", { text: detail.value, cls: "internal-link", attr: { href: path, "data-href": path } });
        link.onclick = event => { event.preventDefault(); void app.workspace.openLinkText(path, ""); };
      } else value.textContent = detail.value;
    }
  }
  const approval = part.state === "approval-required";
  if (approval) {
    const preview = await prepareNativeWriteEditPreview(app, part);
    if (preview) {
      renderPreparedWriteEditPreviews(container, [preview], { approval: true });
      if (preview.diff.stats.additions || preview.diff.stats.deletions) {
        host.dataset.changeSize = `+${preview.diff.stats.additions} −${preview.diff.stats.deletions}`;
      }
    }
  } else if (part.native.agent === "claude" && ["Edit", "MultiEdit", "Write"].includes(part.name)) {
    // The vault now holds later content, not the original input to this request.
    renderRequestedWriteEdit(container, part);
  }
  if (kind(part) === "fileChange") {
    const changes = records(record(part.input).changes);
    const diffContainer = container.createDiv({ cls: "systemsculpt-inline-diff" });
    for (const change of changes) {
      const fileName = displayPath(part, text(change.path) ?? "File");
      const [verb] = fileAction(change);
      const destination = text(record(change.kind).move_path);
      const patch = text(change.diff);
      const diff = patch ? parseUnifiedDiff(patch) : null;
      const section = changes.length > 1 ? diffContainer.createEl("details", { cls: "systemsculpt-inline-diff__file" }) : diffContainer;
      if (changes.length > 1) section.createEl("summary", { text: `${verb} ${fileName}${destination ? ` → ${displayPath(part, destination)}` : ""}${diff ? ` · +${diff.stats.additions} −${diff.stats.deletions}` : ""}` });
      const body = section.createDiv({ cls: "systemsculpt-inline-diff__body" });
      if (verb === "Create") body.createDiv({ cls: "systemsculpt-inline-diff__new-file", text: "New file" });
      if (diff && (diff.stats.additions || diff.stats.deletions)) {
        new DiffViewer({ container: body, diffResult: diff, fileName, maxContextLines: 3, showLineNumbers: true, hideHeader: approval && changes.length === 1, ...(approval ? { maxVisibleLines: 12 } : {}) }).render();
      } else {
        body.createDiv({ cls: "systemsculpt-diff-no-changes-notice", text: "A line-by-line preview is not available. Review Details for the requested file change." });
        if (patch) body.createEl("pre").createEl("code", { text: patch });
      }
    }
    if (!changes.length) diffContainer.createDiv({ cls: "systemsculpt-diff-no-changes-notice", text: "The requested file changes are not available yet. Review Details before approving." });
  }
  if (kind(part) === "ExitPlanMode") {
    const plan = text(record(part.input).plan);
    if (plan) {
      const body = container.createDiv({ cls: "ss-native-plan-preview" });
      if (component) await MarkdownRenderer.render(app, plan, body, "", component);
      else body.setText(plan);
      if (plan.split("\n").length > 16) {
        body.addClass("is-collapsed");
        const all = createUiAction(container, { label: "Show all", testId: "chat.approval.show-plan", size: "small", tooltip: false });
        all.onclick = () => { body.removeClass("is-collapsed"); all.remove(); };
      }
    }
  }
  if (["TodoWrite", "plan"].includes(kind(part))) {
    const list = container.createEl("ul", { cls: "ss-native-tool-plan" });
    for (const todo of records(record(part.input).todos ?? record(part.input).plan)) {
      list.createEl("li", { text: `${todo.status === "completed" ? "✓" : "○"} ${text(todo.content) ?? text(todo.step) ?? "Step"}` });
    }
  }
  if (!["AskUserQuestion", "requestUserInput", "questions"].includes(kind(part))) renderOutput(container, part.output?.data);
  if (!container.childElementCount) container.createEl("p", { text: "Review Details for the full request." });
  host.querySelector(":scope > .ss-native-tool-preview")?.remove();
  host.appendChild(container);
  return true;
}
