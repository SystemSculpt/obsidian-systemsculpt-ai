import { decodeSystemSculptToolOutput, systemSculptToolName } from "../../tools/systemsculpt/SystemSculptTools";
import { MarkdownRenderer, setIcon, type App, type Component } from "obsidian";
import { codexImageLocalPath, codexImageMedia, isCodexGeneratedImagePath } from "../../services/codex/CodexImages";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { DiffViewer } from "../../components/DiffViewer";
import { createSurfaceElement, createUiAction } from "../../core/ui/surface";
import { generateDiff, parseUnifiedDiff } from "../../utils/diffUtils";
import { nativeToolPath } from "../../utils/nativeToolPath";
import {
  prepareNativeWriteEditPreview,
  renderPreparedWriteEditPreviews,
} from "./ToolCallPreview";
import { renderSystemSculptToolCard, systemSculptToolArguments as systemSculptArguments } from "./SystemSculptToolCard";
import {
  createToolCard,
  inputFields,
  renderFields,
  renderLinks,
  renderMedia,
  renderPathList,
  renderTerminal,
  renderText,
  toolOutputText,
  type ToolCardField,
  type ToolCardLink,
} from "./ToolCardBlocks";

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
  /** Distinct notes or folders the group counts, so a repeated path counts once. */
  groupItems?: readonly string[];
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
function resolvedPath(part: AgentToolPart, path: string): ReturnType<typeof nativeToolPath> {
  const { workingDirectory, vaultRoot, vaultRootAlias, homeDirectory } = part.native!;
  return nativeToolPath(path, workingDirectory, vaultRoot, vaultRootAlias, homeDirectory);
}
function displayPath(part: AgentToolPart, path: string): string {
  return resolvedPath(part, path).displayPath;
}
/** Spec 3.5 meta: "in vault", or the vault-relative / ~-relative folder. */
function cwdMeta(part: AgentToolPart, cwd: string | undefined): string {
  const display = displayPath(part, cwd ?? (part.native!.vaultRoot === "." ? "." : part.native!.workingDirectory));
  return `in ${display === "Vault root" ? "vault" : display}`;
}
function basename(path: string): string { return path.split(/[\\/]/u).filter(Boolean).pop() ?? path; }
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

/** `mcp__server__tool` reads as its tool, with its server beside it. */
function mcpName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  return match ? { server: match[1].replace(/[_-]+/gu, " "), tool: match[2].replace(/[_-]+/gu, " ") } : null;
}
function duration(ms: unknown): string {
  return typeof ms === "number" && ms > 0 ? ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min` : "a moment";
}

/** Native metadata stays separate from hosted-tool names, policy, and summaries. */
export function nativeToolPresentation(part: AgentToolPart): NativeToolPresentation | null {
  if (!part.native) return null;
  const input = record(part.input);
  const agentName = part.native.agent === "claude" ? "Claude Code" : "Codex";
  const presentation = (verb: string, completed: string, running: string, target: string, icon: string, groupKind: string, options: { path?: string; approval?: string; count?: number; items?: readonly string[]; meta?: string } = {}): NativeToolPresentation => {
    const path = options.path ? resolvedPath(part, options.path) : undefined;
    const title = `${verb} ${target}`;
    const description = realReason(part, path?.displayPath ?? target, title);
    const folder = path?.displayPath.includes("/") ? path.displayPath.slice(0, path.displayPath.lastIndexOf("/")) : undefined;
    const items = options.items ?? (path ? [path.vaultPath ?? path.displayPath] : []);
    return {
      title, completedTitle: `${completed} ${target}`, runningTitle: `${running} ${target}…`,
      approvalTitle: options.approval ?? `${verb.toLowerCase()} ${target}`,
      ...(description ? { description } : {}),
      ...(path ? { path: path.displayPath, ...(path.vaultPath ? { targetPath: path.vaultPath } : {}) } : {}),
      meta: [options.meta ?? folder, description].filter(Boolean).join(" · ") || undefined,
      icon, agentName, groupKind, groupCount: options.count ?? 1,
      ...(items.length ? { groupItems: items } : {}),
    };
  };
  const systemsculpt = systemSculptToolName(part.name);
  if (systemsculpt) {
    const input = systemSculptArguments(part);
    const workflow = text(input.path) ? basename(text(input.path)!).replace(/\.systemsculpt$/iu, "") : text(input.name) ?? "workflow";
    const [verb, completed, running, target, icon] = ({
      generate_image: ["Generate", "Generated", "Generating", typeof input.count === "number" && input.count > 1 ? "images" : "image", "image"],
      generate_video: ["Generate", "Generated", "Generating", "video", "film"],
      studio_list_workflows: ["List", "Listed", "Listing", "Studio workflows", "layout-dashboard"],
      studio_create_workflow: ["Create", "Created", "Creating", workflow, "layout-dashboard"],
      studio_open_workflow: ["Open", "Opened", "Opening", workflow, "layout-dashboard"],
      studio_edit_workflow: ["Edit", "Edited", "Editing", workflow, "layout-dashboard"],
      studio_run_workflow: ["Run", "Ran", "Running", workflow, "play"],
      studio_list_outputs: ["List outputs of", "Listed outputs of", "Listing outputs of", workflow, "layout-dashboard"],
    } as const)[systemsculpt];
    // A refused call (no subscription, no credits) finished normally but did nothing.
    const result = part.state === "succeeded" ? decodeSystemSculptToolOutput(part.output?.data) : null;
    const refused = result?.ok === false;
    // Needing a subscription or credits is an expected gate, not a failure.
    const gate = refused && result?.link?.label === "Subscribe" ? "Needs a subscription" : refused && result?.link?.label === "Buy credits" ? "Needs credits" : null;
    if (gate) return presentation(verb, verb, running, `${target} · ${gate}`, icon, `systemsculpt:${systemsculpt}`);
    return presentation(verb, refused ? `Couldn't ${verb.toLowerCase()}` : completed, running, target, icon, `systemsculpt:${systemsculpt}`);
  }
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
        approval: "run a command", meta: cwdMeta(part, text(input.cwd)),
      });
    }
    case "WebFetch": return presentation("Read", "Read", "Opening", host(text(input.url)), "globe-2", "web", { approval: `fetch ${host(text(input.url))}` });
    case "WebSearch":
    case "webSearch": {
      // Codex reports opening a page and finding in it as web searches; title them as what happened.
      const action = record(input.action);
      const url = text(action.url);
      if (url && action.type === "openPage") return presentation("Open", "Opened", "Opening", host(url), "globe-2", "web-search", { approval: "open a web page" });
      if (url && action.type === "findInPage") return presentation("Find in", "Found in", "Finding in", host(url), "globe-2", "web-search", { approval: "search a web page" });
      const query = text(input.query) ?? text(action.query) ?? strings(action.queries)[0];
      return presentation("Search the web for", "Searched the web for", "Searching the web for", query ? `“${query}”` : "information", "globe-2", "web-search", { approval: "search the web" });
    }
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
      if (changes.length !== 1) {
        const changed = changes.flatMap(change => text(change.path) ?? []).map(path => resolvedPath(part, path));
        return { ...presentation("Change", "Changed", "Changing", changes.length ? `${changes.length} files` : "files", "files", "edit", {
          count: changes.length || 1, meta: changeSize(input),
          items: changed.length === changes.length ? changed.map(path => path.vaultPath ?? path.displayPath) : [],
        }), changeSize: changeSize(input) };
      }
      const [verb, completed, running, icon] = fileAction(changes[0]);
      const source = text(changes[0].path);
      const destination = text(record(changes[0].kind).move_path);
      const name = source ? basename(displayPath(part, source)) : "file";
      const size = changeSize(input);
      const sourcePath = source ? displayPath(part, source) : "";
      const folder = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : undefined;
      return { ...presentation(verb, completed, running, destination ? `${name} → ${displayPath(part, destination)}` : name, icon, verb === "Create" ? "write" : verb === "Delete" ? "trash" : "edit", {
        path: source, meta: [folder, size].filter(Boolean).join(" · ") || undefined,
      }), changeSize: size };
    }
    case "imageGeneration": return presentation("Generate", "Generated", "Generating", "image", "image", "image");
    case "imageView": {
      const image = codexImageLocalPath(input.path);
      // Codex names its generated files by internal id, so those read as "image".
      const name = image && !isCodexGeneratedImagePath(image) ? basename(image) : "image";
      return presentation("View", "Viewed", "Viewing", name, "image", "image-view", image ? { path: image } : {});
    }
    case "permissions": return presentation("Allow", "Allowed", "Requesting", "additional access", "shield-check", "permission", {
      meta: cwdMeta(part, text(input.cwd)),
    });
    case "questions":
    case "requestUserInput":
    case "AskUserQuestion": return presentation("Answer", "Answered", "Asking", "a question", "message-circle-question", "question");
    case "Task":
    case "Agent": return presentation("Run", "Ran", "Running", "an agent", "bot", "agent");
    case "NotebookEdit": {
      const notebook = text(input.notebook_path);
      return presentation("Edit", "Edited", "Editing", notebook ? basename(displayPath(part, notebook)) : "notebook", "file-pen-line", "edit", { path: notebook });
    }
    case "BashOutput": return presentation("Check", "Checked", "Checking", "a running command", "terminal", "command");
    case "KillShell":
    case "KillBash": return presentation("Stop", "Stopped", "Stopping", "a running command", "terminal", "command");
    case "Skill": return presentation("Use", "Used", "Using", `the ${text(input.skill) ?? text(input.command) ?? ""} skill`.replace(/\s+/gu, " "), "sparkles", "skill");
    case "SlashCommand": return presentation("Run", "Ran", "Running", text(input.command) ?? "a command", "terminal", "command");
    case "ToolSearch": return presentation("Find", "Found", "Finding", "tools", "search", "search");
    case "ListMcpResourcesTool": return presentation("List", "Listed", "Listing", "resources", "list-tree", "list");
    case "ReadMcpResourceTool": return presentation("Read", "Read", "Reading", text(input.uri) ?? "a resource", "file-text", "read");
    case "collabAgentToolCall": {
      const tool = text(input.tool);
      return tool === "spawnAgent" ? presentation("Start", "Started", "Starting", "an agent", "bot", "agent")
        : tool === "wait" ? presentation("Wait for", "Waited for", "Waiting for", "an agent", "bot", "agent")
          : tool === "closeAgent" ? presentation("Close", "Closed", "Closing", "an agent", "bot", "agent")
            : presentation("Message", "Messaged", "Messaging", "an agent", "bot", "agent");
    }
    case "sleep": return presentation("Wait", "Waited", "Waiting", duration(input.durationMs), "timer", "wait");
    case "mcpToolCall": return presentation("Use", "Used", "Using", (text(input.tool) ?? part.name).replace(/[_-]+/gu, " "), "plug", `mcp:${part.name}`, { meta: text(input.server) });
    default: {
      const mcp = mcpName(part.name);
      if (mcp) return presentation("Use", "Used", "Using", mcp.tool, "plug", `mcp:${part.name}`, { meta: mcp.server });
      return presentation("Use", "Used", "Using", part.name, "wrench", `unknown:${part.name}`);
    }
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
  // The verb already says the path leaves the vault, so the row doesn't repeat it.
  const writeRow = (value: unknown, display: string): string => {
    const path = typeof value === "string" ? value : record(value).type === "path" ? text(record(value).path) : undefined;
    const target = path ? resolvedPath(part, path) : undefined;
    return !target || target.vaultPath || target.displayPath === "Vault root" ? `Read and change ${display}`
      : `Write outside this vault: ${display.replace(/ \(outside vault\)$/u, "")}`;
  };
  for (const path of strings(files.write)) details.push({ label: "Access", value: writeRow(path, displayPath(part, path)) });
  for (const entry of records(files.entries)) {
    const display = permissionPath(part, entry.path);
    const row = entry.access === "write" ? writeRow(entry.path, display)
      : `${entry.access === "read" ? "Read" : entry.access === "deny" ? "Block access to" : "Access"} ${display}`;
    details.push({ label: "Access", value: row });
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
  if (toolKind === "imageGeneration") add("Prompt", input.revisedPrompt);
  if (["Read", "LS", "Glob", "Grep"].includes(toolKind)) {
    const path = text(input.file_path) ?? text(input.path);
    if (path) details.push({ label: "File or folder", value: displayPath(part, path), path: resolvedPath(part, path).vaultPath ?? undefined });
    add("Search for", input.pattern);
  }
  const network = record(input.networkApprovalContext);
  if (text(network.host)) add("Access", `Connect to ${network.host as string}`);
  if (text(input.grantRoot)) add("Access", `Change files in ${displayPath(part, input.grantRoot as string)}`);
  details.push(...permissionDetails(part, input.permissions));
  const own = systemSculptToolName(part.name);
  if (own) {
    const input = systemSculptArguments(part);
    // What the person is agreeing to: the prompt or workflow, and whether it spends credits.
    add("Prompt", input.prompt);
    const workflow = text(input.path);
    if (workflow) details.push({ label: "Workflow", value: displayPath(part, workflow), path: resolvedPath(part, workflow).vaultPath ?? undefined });
    if (own === "studio_create_workflow") add("Name", input.name);
    if (own === "generate_image" || own === "generate_video") add("Cost", "Uses SystemSculpt credits");
    if (own === "studio_run_workflow") add("Cost", "Hosted steps use SystemSculpt credits");
  }
  return details;
}
function renderOutput(container: HTMLElement, output: unknown): void {
  const content = toolOutputText(output);
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
    container.createEl("p", { cls: "ss-tool-caption", text: "Requested content, not a before-and-after diff." });
    if (typeof input.content === "string") {
      if (input.content) renderOutput(container, input.content);
      else container.createEl("p", { cls: "ss-tool-caption", text: "The requested content is empty." });
    }
    return;
  }
  container.createEl("p", { cls: "ss-tool-caption", text: "Requested text changes only. Original file line numbers are unavailable." });
  const edits = part.name === "MultiEdit" ? records(input.edits) : [input];
  for (const [index, edit] of edits.entries()) {
    if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") continue;
    const body = container.createDiv({ cls: "systemsculpt-inline-diff__body" });
    if (edits.length > 1) body.createEl("p", { cls: "ss-tool-caption", text: `Requested edit ${index + 1}` });
    const context = Math.max(edit.old_string.split("\n").length, edit.new_string.split("\n").length);
    const diff = generateDiff(edit.old_string, edit.new_string, context);
    if (!diff.stats.additions && !diff.stats.deletions) {
      body.createEl("p", { cls: "ss-tool-caption", text: edit.old_string === edit.new_string ? "The requested text is unchanged." : "The request changes the final line break." });
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

function renderFileChanges(container: HTMLElement, part: AgentToolPart, approval: boolean): void {
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

async function renderPlan(app: App, container: HTMLElement, part: AgentToolPart, component?: Component): Promise<void> {
  const plan = text(record(part.input).plan);
  if (!plan) return;
  const body = container.createDiv({ cls: "ss-native-plan-preview" });
  if (component) await MarkdownRenderer.render(app, plan, body, "", component);
  else body.setText(plan);
  if (plan.split("\n").length > 16) {
    body.addClass("is-collapsed");
    const all = createUiAction(container, { label: "Show all", testId: "chat.approval.show-plan", size: "small", tooltip: false });
    all.addClass("ss-tool-more");
    all.onclick = () => { body.removeClass("is-collapsed"); all.remove(); };
  }
}

function renderTodos(container: HTMLElement, part: AgentToolPart): void {
  const input = record(part.input);
  const todos = records(input.todos ?? input.plan);
  if (!todos.length) return;
  const list = container.createEl("ul", { cls: "ss-native-tool-plan" });
  for (const todo of todos) {
    const done = todo.status === "completed";
    const active = todo.status === "in_progress" || todo.status === "inProgress";
    const item = list.createEl("li", { cls: done ? "is-done" : active ? "is-active" : "" });
    const mark = item.createSpan({ cls: "ss-native-tool-plan-mark", attr: { "aria-hidden": "true" } });
    setIcon(mark, done ? "check" : active ? "circle-dot" : "circle");
    item.createSpan({ text: text(todo.content) ?? text(todo.step) ?? "Step" });
    item.setAttribute("aria-label", `${done ? "Done" : active ? "In progress" : "To do"}: ${text(todo.content) ?? text(todo.step) ?? "Step"}`);
  }
}

/** The questions asked. Answers stay out: a secret answer never reaches the conversation. */
function renderQuestions(container: HTMLElement, part: AgentToolPart): void {
  const list = container.createEl("ol", { cls: "ss-tool-questions" });
  for (const question of records(record(part.input).questions)) {
    const prompt = text(question.question) ?? text(question.header);
    if (!prompt) continue;
    const item = list.createEl("li");
    item.createDiv({ cls: "ss-tool-question", text: prompt });
    const options = records(question.options).flatMap(option => text(option.label) ?? []);
    if (options.length) item.createDiv({ cls: "ss-tool-question-options", text: options.join(" · ") });
  }
  if (!list.childElementCount) list.remove();
}

/** `Links: [{"title","url"}]` inside Claude Code's WebSearch result. */
function webSearchLinks(output: string): { links: ToolCardLink[]; rest: string } {
  const match = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/u.exec(output);
  if (!match) return { links: [], rest: output };
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    const links = records(parsed).flatMap(link => {
      const url = text(link.url);
      return url && /^https?:\/\//iu.test(url) ? [{ title: text(link.title) ?? url, url }] : [];
    });
    const rest = output.slice(match.index + match[0].length).replace(/^Web search results for query:.*$/mu, "").trim();
    return { links, rest };
  } catch {
    return { links: [], rest: output };
  }
}

function pathRows(part: AgentToolPart, lines: readonly string[]): { path: string; link?: boolean }[] {
  return lines.flatMap(line => {
    const value = line.trim();
    if (!value || /^Found \d+ files?$/u.test(value) || value.length > 400) return [];
    const resolved = resolvedPath(part, value);
    return [resolved.vaultPath ? { path: resolved.vaultPath } : { path: resolved.displayPath, link: false }];
  });
}

/** Native calls the chat has no specific card for: Claude Code's MCP and subagent tools, Codex's MCP and agent calls. */
function renderGeneric(app: App, card: HTMLElement, part: AgentToolPart): void {
  const input = record(part.input);
  const toolKind = kind(part);
  if (toolKind === "Task" || toolKind === "Agent") {
    const prompt = text(input.prompt)?.replace(/\s+/gu, " ");
    renderFields(app, card, [
      ...inputFields(input, { skip: ["prompt", "description"] }),
      ...(prompt ? [{ label: "Task", value: prompt.length > 280 ? `${prompt.slice(0, 279).trimEnd()}…` : prompt }] : []),
    ]);
  } else if (toolKind === "mcpToolCall" || toolKind === "dynamicToolCall") {
    renderFields(app, card, inputFields(input.arguments));
  } else if (toolKind === "collabAgentToolCall") {
    renderFields(app, card, inputFields(input, { skip: ["tool", "senderThreadId", "receiverThreadIds", "agentsStates"] }));
  } else {
    renderFields(app, card, inputFields(input, { skip: ["description"] }));
  }
  const output = toolOutputText(toolKind === "mcpToolCall" ? input.result ?? part.output?.data : part.output?.data);
  if (output && part.state !== "failed") renderText(card, output);
  else if (output) renderTerminal(card, { output });
}

/** A finished or running native call: one card per kind, with the same blocks every tool uses. */
async function renderResolvedNative(app: App, card: HTMLElement, part: AgentToolPart, component?: Component): Promise<void> {
  if (renderSystemSculptToolCard(app, card, part)) return;
  const input = record(part.input);
  const toolKind = kind(part);
  const output = toolOutputText(part.output?.data);
  switch (toolKind) {
    case "Bash":
    case "commandExecution":
      if (input.kind === "writeStdin") renderFields(app, card, inputFields(input, { skip: ["kind"] }));
      else renderTerminal(card, { command: command(input), output: output || text(input.aggregatedOutput) });
      return;
    case "BashOutput":
      renderTerminal(card, { output });
      return;
    case "Read":
    case "LS":
    case "Glob":
    case "Grep": {
      const path = text(input.file_path) ?? text(input.path);
      // The title already names the pattern; the card adds where it looked.
      const fields: ToolCardField[] = [];
      if (path && toolKind !== "Read") {
        const resolved = resolvedPath(part, path);
        fields.push({ label: "In", value: resolved.displayPath, ...(resolved.vaultPath ? { path: resolved.vaultPath } : {}) });
      }
      renderFields(app, card, fields);
      if (toolKind === "Read" && path) {
        const resolved = resolvedPath(part, path);
        const lines = output ? output.replace(/\n+$/u, "").split("\n").length : 0;
        renderPathList(app, card, [{ path: resolved.vaultPath ?? resolved.displayPath, link: Boolean(resolved.vaultPath), ...(lines ? { note: `${lines} ${lines === 1 ? "line" : "lines"}` } : {}) }]);
      } else if (toolKind === "LS") {
        renderTerminal(card, { output });
      } else if (output) {
        // Grep and Glob list one path per line; content matches keep their own lines.
        const lines = output.trim().split("\n");
        const looksLikePaths = lines.every(line => !line.includes(":") || /^[A-Za-z]:[\\/]/u.test(line) || line.startsWith("Found "));
        if (looksLikePaths) renderPathList(app, card, pathRows(part, lines));
        else renderTerminal(card, { output });
      }
      return;
    }
    case "WebSearch":
    case "webSearch": {
      const action = record(input.action);
      const queries = strings(action.queries).length ? strings(action.queries) : [text(input.query) ?? text(action.query)].filter((value): value is string => Boolean(value));
      // One query is already the title; several are listed.
      const fields: ToolCardField[] = queries.length > 1 ? [{ label: "Searches", value: queries.join("\n") }] : [];
      const url = text(action.url);
      if (url) fields.push({ label: "Page", value: url, url });
      if (text(action.pattern)) fields.push({ label: "Find", value: text(action.pattern)! });
      renderFields(app, card, fields);
      if (output) {
        const { links, rest } = webSearchLinks(output);
        renderLinks(card, links);
        if (rest) renderText(card, rest, 4);
      }
      return;
    }
    case "WebFetch": {
      const url = text(input.url);
      renderFields(app, card, [
        ...(url ? [{ label: "Address", value: url, url }] : []),
        ...(text(input.prompt) ? [{ label: "Look for", value: text(input.prompt)! }] : []),
      ]);
      if (output) renderText(card, output, 6);
      return;
    }
    case "imageGeneration":
    case "imageView": {
      // Codex's own image tools: the saved vault copy, like every generated image.
      const image = codexImageMedia(part);
      if (image) renderMedia(app, card, [image.media]);
      if (toolKind === "imageGeneration" && text(input.revisedPrompt)) renderFields(app, card, [{ label: "Prompt", value: text(input.revisedPrompt)! }]);
      return;
    }
    case "TodoWrite":
    case "plan":
      renderTodos(card, part);
      return;
    case "ExitPlanMode":
      await renderPlan(app, card, part, component);
      return;
    case "questions":
    case "requestUserInput":
    case "AskUserQuestion":
      renderQuestions(card, part);
      return;
    case "fileChange":
      renderFileChanges(card, part, false);
      return;
    case "permissions":
      renderFields(app, card, permissionDetails(part, input.permissions).map(detail => ({ label: detail.label, value: detail.value })));
      return;
    case "Edit":
    case "MultiEdit":
    case "Write":
      if (part.native?.agent === "claude") renderRequestedWriteEdit(card, part);
      return;
    default:
      renderGeneric(app, card, part);
  }
}

/** Renders only the preview. Approval controls and raw Details belong to the caller. */
export async function renderNativeToolPreview(app: App, host: HTMLElement, part: AgentToolPart, component?: Component): Promise<boolean> {
  if (!part.native) return false;
  delete host.dataset.changeSize;
  const container = createSurfaceElement(host.ownerDocument, "div");
  container.className = "ss-native-tool-preview";
  const approval = part.state === "approval-required";
  if (!approval) {
    const card = createToolCard(container, `native:${kind(part)}`);
    await renderResolvedNative(app, card, part, component);
    if (!card.childElementCount) card.remove();
  } else {
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
    const preview = await prepareNativeWriteEditPreview(app, part);
    if (preview) {
      renderPreparedWriteEditPreviews(container, [preview], { approval: true });
      if (preview.diff.stats.additions || preview.diff.stats.deletions) {
        host.dataset.changeSize = `+${preview.diff.stats.additions} −${preview.diff.stats.deletions}`;
      }
    }
    if (kind(part) === "fileChange") renderFileChanges(container, part, true);
    if (kind(part) === "ExitPlanMode") await renderPlan(app, container, part, component);
    if (["TodoWrite", "plan"].includes(kind(part))) renderTodos(container, part);
    if (["AskUserQuestion", "requestUserInput", "questions"].includes(kind(part))) renderQuestions(container, part);
    if (!container.childElementCount) {
      const card = createToolCard(container, `native:${kind(part)}`);
      renderGeneric(app, card, part);
    }
  }
  if (!container.childElementCount) return false;
  host.querySelector(":scope > .ss-native-tool-preview")?.remove();
  host.appendChild(container);
  return true;
}
