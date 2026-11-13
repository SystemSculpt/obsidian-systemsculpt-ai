import { decodeSystemSculptToolOutput, systemSculptToolName } from "../../tools/systemsculpt/SystemSculptTools";
import { bridgedToolName } from "../../utils/toolPolicy";
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
  changeCounts,
  createToolCard,
  inputFields,
  renderFields,
  renderFileContent,
  renderLinks,
  mediaDisplayName,
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
  /** "2 results": how many results a web search lists. */
  resultCount?: string;
  path?: string;
  targetPath?: string;
  icon: string;
  agentName: string;
  groupKind: string;
  groupCount: number;
  /** Distinct notes or folders the group counts, so a repeated path counts once. */
  groupItems?: readonly string[];
  /** The words in the title that name what the call acted on: a note, a query, a command. */
  target?: LabelTarget;
  /** A call stopped at the plan or credits gate: what it would have made, and what it needs. */
  gate?: Readonly<{ subject: string; need: string }>;
}>;

/** The words a tool label sets apart; a shell command reads in the code font. */
export type LabelTarget = Readonly<{ text: string; command?: true }>;

/** A Markdown note is named as Obsidian names it, without ".md"; other files keep their extension. */
export function noteDisplayName(name: string): string {
  return /.\.md$/iu.test(name) ? name.slice(0, -3) : name;
}

/** A tool server's tool as people read it ("weather forecast"); a tool already named for its server isn't repeated. */
/** What a gated SystemSculpt call needs, from its link's words; saved chats keep the older words. */
export function systemSculptGateNeed(label: string | undefined): string | null {
  return label === "See plans" || label === "Subscribe" ? "Needs a plan"
    : label === "Add credits" || label === "Buy credits" ? "Needs credits" : null;
}

function serverToolName(server: string | undefined, tool: string): string {
  const name = tool.replace(/[_-]+/gu, " ").trim();
  // Claude names its connectors "claude_ai_<Service>"; the service is the server people know.
  const owner = server?.replace(/[_-]+/gu, " ").replace(/^claude ai /iu, "").trim();
  return owner && !name.toLowerCase().startsWith(owner.toLowerCase()) ? `${owner} ${name}` : name;
}

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
  return changeCountText(diffs.reduce((sum, diff) => sum + diff.additions, 0), diffs.reduce((sum, diff) => sum + diff.deletions, 0));
}
/** A change's lines as an edit row counts them: "+3 −2", "+3" or "−2"; a zero says nothing. */
function changeCountText(added: number, removed: number): string | undefined {
  return [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ") || undefined;
}
/**
 * What requested edits add and remove, counted from the same diff their card draws. `before` and
 * `after` name each edit's text fields (Claude Code's old_string/new_string, a vault edit's oldText/newText).
 */
export function editChangeSize(edits: readonly Record<string, unknown>[], before: string, after: string): string | undefined {
  let added = 0, removed = 0;
  for (const edit of edits) {
    const old = edit[before], next = edit[after];
    if (typeof old !== "string" || typeof next !== "string") continue;
    const { stats } = generateDiff(old, next, 0);
    added += stats.additions;
    removed += stats.deletions;
  }
  return changeCountText(added, removed);
}
/** "+4": a write adds every line its card draws. */
export function writeChangeSize(content: unknown): string | undefined {
  return typeof content === "string" ? changeCountText(content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0, 0) : undefined;
}
function realReason(part: AgentToolPart, target: string, title: string): string | undefined {
  const input = record(part.input);
  const candidates = [text(input.description), text(input.reason), text(part.native?.description)];
  const targets = [target, basename(target), text(input.file_path), text(input.path)].filter((value): value is string => Boolean(value));
  const repeated = [title, ...targets.flatMap(value => [value, `${part.name} ${value}`, `${title.split(" ")[0]} ${value}`])];
  return candidates.find(candidate => candidate && !repeated.some(value => candidate.toLowerCase() === value.toLowerCase()));
}

function duration(ms: unknown): string {
  return typeof ms === "number" && ms > 0 ? ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min` : "a moment";
}

/** Native metadata stays separate from hosted-tool names, policy, and summaries. */
export function nativeToolPresentation(part: AgentToolPart): NativeToolPresentation | null {
  if (!part.native) return null;
  const input = record(part.input);
  const agentName = part.native.agent === "claude" ? "Claude Code" : "Codex";
  // shown: the target as the row names it (a note without ".md"); an approval keeps the file name its card links.
  // mark: the words in the title that name the target, set apart when the row is drawn.
  const presentation = (verb: string, completed: string, running: string, target: string, icon: string, groupKind: string, options: { path?: string; approval?: string; count?: number; items?: readonly string[]; meta?: string; shown?: string; mark?: LabelTarget } = {}): NativeToolPresentation => {
    const path = options.path ? resolvedPath(part, options.path) : undefined;
    const approving = part.state === "approval-required" && options.shown !== undefined;
    const shown = approving ? target : options.shown ?? target;
    const title = `${verb} ${shown}`;
    const description = realReason(part, path?.displayPath ?? target, title);
    const folder = path?.displayPath.includes("/") ? path.displayPath.slice(0, path.displayPath.lastIndexOf("/")) : undefined;
    const items = options.items ?? (path ? [path.vaultPath ?? path.displayPath] : []);
    return {
      // The spinner says it is running; a trailing "…" would read as a cut target.
      title, completedTitle: `${completed} ${shown}`, runningTitle: `${running} ${shown}`,
      approvalTitle: options.approval ?? `${verb.toLowerCase()} ${target}`,
      ...(options.mark && !approving ? { target: options.mark } : {}),
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
    const named = text(input.path) ? studioWorkflowName(text(input.path)!) : text(input.name);
    const workflow = named ? `${named} workflow` : "workflow";
    const [verb, completed, running, target, icon] = ({
      generate_image: [...(editsImages(input) ? ["Edit", "Edited", "Editing"] : ["Generate", "Generated", "Generating"]), imageCountTarget(part, input), "image"],
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
    // Needing a plan or credits is an expected gate, not a failure.
    const gate = refused ? systemSculptGateNeed(result?.link?.label) : null;
    if (gate) return { ...presentation(verb, verb, running, `${target} · ${gate}`, icon, `systemsculpt:${systemsculpt}`), gate: { subject: target, need: gate.replace(/^Needs /u, "") } };
    return presentation(verb, refused ? `Couldn't ${verb.toLowerCase()}` : completed, running, target, icon, `systemsculpt:${systemsculpt}`);
  }
  const rawPath = text(input.file_path) ?? text(input.path);
  const path = rawPath ? displayPath(part, rawPath) : undefined;
  const target = path ? basename(path) : "file";
  const note = path ? { shown: noteDisplayName(target), mark: { text: noteDisplayName(target) } } : {};
  switch (kind(part)) {
    // Counted from the change the card draws: "+1 −1", or "+4" for a write of four lines.
    case "Edit":
    case "MultiEdit": return {
      ...presentation("Edit", "Edited", "Editing", target, "file-pen-line", "edit", { path: rawPath, ...note }),
      changeSize: editChangeSize(part.name === "MultiEdit" ? records(input.edits) : [input], "old_string", "new_string"),
    };
    case "Write": return { ...presentation("Create", "Created", "Creating", target, "file-plus-2", "write", { path: rawPath, ...note }), changeSize: writeChangeSize(input.content) };
    case "Read": return presentation("Read", "Read", "Reading", target, "file-text", "read", { path: rawPath, ...note });
    // "Listed the Notes folder": a folder named like a note count ("read 2 notes") still reads as a folder.
    case "LS": return path && path !== "Vault root"
      ? presentation("List", "Listed", "Listing", `the ${path} folder`, "list-tree", "list", { path: rawPath, mark: { text: path } })
      : presentation("List", "Listed", "Listing", "the vault", "list-tree", "list", { path: rawPath });
    case "Bash":
    case "commandExecution": {
      if (input.kind === "writeStdin") return presentation("Send input to", "Sent input to", "Sending input to", "a running command", "terminal", "command");
      const cmd = command(input)?.replace(/\s+/gu, " ").trim() ?? "command";
      const shown = cmd.length > 40 ? `${cmd.slice(0, 39)}…` : cmd;
      return presentation("Run", "Ran", "Running", shown, "terminal", "command", {
        approval: "run a command", meta: cwdMeta(part, text(input.cwd)), ...(command(input) ? { mark: { text: shown, command: true } } : {}),
      });
    }
    case "WebFetch": return presentation("Read", "Read", "Opening", host(text(input.url)), "globe-2", "web", { approval: `fetch ${host(text(input.url))}`, mark: { text: host(text(input.url)) } });
    case "WebSearch":
    case "webSearch": {
      // Codex reports opening a page and finding in it as web searches; title them as what happened.
      const action = record(input.action);
      const url = text(action.url);
      if (url && action.type === "openPage") return presentation("Open", "Opened", "Opening", host(url), "globe-2", "web", { approval: "open a web page", mark: { text: host(url) } });
      if (url && action.type === "findInPage") return presentation("Find in", "Found in", "Finding in", host(url), "globe-2", "web", { approval: "search a web page", mark: { text: host(url) } });
      // Codex can run several queries in one call: the row names the first and counts the rest, and each
      // query counts as one search in the turn's summary ("Searched the web 4 times").
      const queries = webSearchQueries(input);
      const query = queries[0];
      const more = queries.length > 1 ? ` and ${queries.length - 1}\u00a0more` : "";
      // A count only for results the card lists (20 at most): Claude Code's links. Codex lists none.
      const results = part.state === "succeeded" ? Math.min(webSearchLinks(toolOutputText(part.output?.data)).links.length, 20) : 0;
      return {
        ...presentation("Search the web for", "Searched the web for", "Searching the web for", query ? `“${query}”${more}` : "information", "globe-2", "web-search", {
          approval: "search the web", count: Math.max(queries.length, 1), ...(query ? { mark: { text: `“${query}”` } } : {}),
        }),
        ...(results ? { resultCount: `${results} result${results === 1 ? "" : "s"}` } : {}),
      };
    }
    case "Grep": return presentation("Search", "Searched", "Searching", `“${text(input.pattern) ?? "text"}”`, "search", "search", text(input.pattern) ? { mark: { text: `“${text(input.pattern)}”` } } : {});
    // A name pattern finds files: a search of names, not of text ("Searched for 2 patterns") nor a folder listing.
    // Its pattern is code ("**/*.md"), set as code like a command, never read as Markdown.
    case "Glob": return presentation("Find", "Found", "Finding", `files matching ${text(input.pattern) ?? "a pattern"}`, "file-search", "find", text(input.pattern) ? { mark: { text: text(input.pattern)!, command: true } } : {});
    case "TodoWrite":
    case "plan": {
      const todos = records(input.todos ?? input.plan);
      const done = todos.filter(todo => todo.status === "completed").length;
      return { ...presentation("Update", "Updated", "Updating", "plan", "list-checks", "plan"), runningTitle: "Planning", meta: todos.length ? `${done} of ${todos.length} done` : undefined };
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
      const shown = source ? noteDisplayName(name) : name;
      return { ...presentation(verb, completed, running, destination ? `${name} → ${displayPath(part, destination)}` : name, icon, verb === "Create" ? "write" : verb === "Delete" ? "trash" : "edit", {
        path: source, meta: [folder, size].filter(Boolean).join(" · ") || undefined,
        shown: destination ? `${shown} → ${noteDisplayName(displayPath(part, destination))}` : shown,
        ...(source ? { mark: { text: shown } } : {}),
      }), changeSize: size };
    }
    case "imageGeneration": return presentation("Generate", "Generated", "Generating", "image", "image", "image");
    case "imageView": {
      const image = codexImageLocalPath(input.path);
      // Codex names its generated files by internal id, so those read as "image".
      const name = image && !isCodexGeneratedImagePath(image) ? mediaDisplayName(image) : "image";
      return presentation("View", "Viewed", "Viewing", name, "image", "image-view", image ? { path: image, mark: { text: name } } : {});
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
      return presentation("Edit", "Edited", "Editing", notebook ? basename(displayPath(part, notebook)) : "notebook", "file-pen-line", "edit", notebook ? { path: notebook, mark: { text: basename(displayPath(part, notebook)) } } : {});
    }
    case "BashOutput": return presentation("Check", "Checked", "Checking", "a running command", "terminal", "command");
    case "KillShell":
    case "KillBash": return presentation("Stop", "Stopped", "Stopping", "a running command", "terminal", "command");
    case "Skill": return presentation("Use", "Used", "Using", `the ${text(input.skill) ?? text(input.command) ?? ""} skill`.replace(/\s+/gu, " "), "sparkles", "skill");
    case "SlashCommand": return presentation("Run", "Ran", "Running", text(input.command) ?? "a command", "terminal", "command", text(input.command) ? { mark: { text: text(input.command)!, command: true } } : {});
    case "ToolSearch": return presentation("Find", "Found", "Finding", "tools", "search", "tools");
    case "ListMcpResourcesTool": return presentation("List", "Listed", "Listing", "resources", "list-tree", "list");
    case "ReadMcpResourceTool": return presentation("Read", "Read", "Reading", text(input.uri) ?? "a resource", "file-text", "read", text(input.uri) ? { mark: { text: text(input.uri)! } } : {});
    case "collabAgentToolCall": {
      const tool = text(input.tool);
      return tool === "spawnAgent" ? presentation("Start", "Started", "Starting", "an agent", "bot", "agent")
        : tool === "wait" ? presentation("Wait for", "Waited for", "Waiting for", "an agent", "bot", "agent")
          : tool === "closeAgent" ? presentation("Close", "Closed", "Closing", "an agent", "bot", "agent")
            : presentation("Message", "Messaged", "Messaging", "an agent", "bot", "agent");
    }
    case "sleep": return presentation("Wait", "Waited", "Waiting", duration(input.durationMs), "timer", "wait");
    // A server's tool is named with its server ("Used weather forecast"), and the same tool from Claude
    // Code or Codex is one group, so the summary can count its calls.
    case "mcpToolCall": {
      const name = serverToolName(text(input.server), text(input.tool) ?? part.name);
      return presentation("Use", "Used", "Using", name, "plug", `mcp:${name}`, { meta: text(input.server), mark: { text: name } });
    }
    default: {
      const mcp = bridgedToolName(part.name);
      const name = mcp ? serverToolName(mcp.server, mcp.tool) : part.name;
      if (mcp) return presentation("Use", "Used", "Using", name, "plug", `mcp:${name}`, { meta: mcp.server, mark: { text: name } });
      return presentation("Use", "Used", "Using", part.name, "wrench", `unknown:${part.name}`, { mark: { text: part.name } });
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
/** What the agent wrote or changed, in the one box every edit card uses; the row already names the note. */
function renderRequestedWriteEdit(container: HTMLElement, part: AgentToolPart): void {
  const input = record(part.input);
  if (part.name === "Write") {
    if (typeof input.content === "string") renderFileContent(container, input.content, undefined, true);
    return;
  }
  const edits = part.name === "MultiEdit" ? records(input.edits) : [input];
  for (const [index, edit] of edits.entries()) {
    if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") continue;
    const body = container.createDiv({ cls: "systemsculpt-inline-diff__body ss-tool-edit" });
    if (edits.length > 1) body.createEl("p", { cls: "ss-tool-caption", text: `Edit ${index + 1}` });
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
    // Each file is named once: by its row, or by its summary when one change holds several files.
    if (changes.length > 1) section.createEl("summary", { text: `${verb} ${fileName}${destination ? ` → ${displayPath(part, destination)}` : ""}${diff ? ` · ${changeCounts(diff.stats)}` : ""}` });
    const body = section.createDiv({ cls: "systemsculpt-inline-diff__body" });
    if (diff && (diff.stats.additions || diff.stats.deletions)) {
      new DiffViewer({ container: body, diffResult: diff, fileName, maxContextLines: 3, hideHeader: true, ...(approval ? { maxVisibleLines: 12 } : {}) }).render();
    } else {
      body.createDiv({ cls: "systemsculpt-diff-no-changes-notice", text: "A line-by-line preview is not available. Review Details for the requested file change." });
      if (patch) body.createEl("pre").createEl("code", { text: patch });
    }
  }
  if (!changes.length) diffContainer.createDiv({ cls: "systemsculpt-diff-no-changes-notice", text: "The requested file changes are not available yet. Review Details before approving." });
}

async function renderPlan(app: App, container: HTMLElement, part: AgentToolPart, component?: Component): Promise<void> {
  // The card's title already says "plan": a first heading that only says "Plan" would say it twice.
  const plan = text(record(part.input).plan)?.replace(/^\s*#{1,6}[ \t]+plan[ \t]*\r?\n(?:[ \t]*\r?\n)*/iu, "");
  if (!plan) return;
  const body = container.createDiv({ cls: "ss-native-plan-preview" });
  if (component) await MarkdownRenderer.render(app, plan, body, "", component);
  else body.setText(plan);
  // Steps numbered 10 and up take a wider gutter, so every step's words start at one edge; the plan's
  // other top-level lists take it too, so its notes start where its steps do.
  const wide = Array.from(body.querySelectorAll("ol")).filter(list => list.start + list.children.length - 1 >= 10);
  for (const list of wide) list.addClass("has-wide-numbers");
  if (wide.some(list => !list.parentElement?.closest("li"))) body.addClass("has-wide-numbers");
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

/** A web search's queries, as its card lists them: Codex can run several in one call. */
function webSearchQueries(input: Record<string, unknown>): string[] {
  const action = record(input.action);
  const queries = strings(action.queries).filter(query => query.trim());
  const query = text(input.query) ?? text(action.query);
  return queries.length ? queries : query ? [query] : [];
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
      else renderTerminal(card, { command: command(input), output: output || text(input.aggregatedOutput), pending: ["input-ready", "approved", "running"].includes(part.state) });
      return;
    case "BashOutput":
      renderTerminal(card, { output });
      return;
    case "Read":
    case "LS":
    case "Glob":
    case "Grep": {
      const path = text(input.file_path) ?? text(input.path);
      // The title names the pattern or folder; the card adds where a search looked only when that narrows it.
      const scope = path && (toolKind === "Glob" || toolKind === "Grep") ? resolvedPath(part, path) : null;
      const fields: ToolCardField[] = scope && scope.displayPath !== "Vault root"
        ? [{ label: "In", value: scope.displayPath, ...(scope.vaultPath ? { path: scope.vaultPath } : {}) }]
        : [];
      if (toolKind === "Read" && path) {
        // The row names and links the note; its card says how much was read, never the note again, in
        // the same muted line a SystemSculpt read uses. A failed read's output is its error, not lines.
        const lines = output && part.state === "succeeded" ? output.replace(/\n+$/u, "").split("\n").length : 0;
        if (lines) card.createEl("p", { cls: "ss-tool-caption", text: `${lines} ${lines === 1 ? "line" : "lines"}` });
      } else if (toolKind === "LS") {
        renderTerminal(card, { output });
      } else if (output) {
        // Grep and Glob list one path per line; content matches keep their own lines.
        const lines = output.trim().split("\n");
        const looksLikePaths = lines.every(line => !line.includes(":") || /^[A-Za-z]:[\\/]/u.test(line) || line.startsWith("Found "));
        const rows = looksLikePaths ? pathRows(part, lines) : [];
        // Found files sit in the value column beside their scope, never under it where they'd read as labels.
        if (rows.length && fields.length) fields.push({ label: "Found", value: "", list: rows });
        renderFields(app, card, fields);
        if (!looksLikePaths) renderTerminal(card, { output });
        else if (rows.length && fields.length === 0) renderPathList(app, card, rows);
      } else renderFields(app, card, fields);
      return;
    }
    case "WebSearch":
    case "webSearch": {
      const action = record(input.action);
      const queries = webSearchQueries(input);
      // "Query", as every web search card says it; several are listed one per line.
      const fields: ToolCardField[] = queries.length > 1
        ? [{ label: "Queries", value: "", list: queries.map(query => ({ path: query, link: false })) }]
        : queries.length ? [{ label: "Query", value: queries[0] }] : [];
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
      renderFields(app, card, toolKind === "imageGeneration" && text(input.revisedPrompt) ? [{ label: "Prompt", value: text(input.revisedPrompt)! }] : []);
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
    // A pending question's card asks it, with its options; a preview would say it all again.
    if (["AskUserQuestion", "requestUserInput", "questions"].includes(kind(part))) return false;
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
        host.dataset.changeSize = changeCounts(preview.diff.stats);
      }
    }
    if (kind(part) === "fileChange") renderFileChanges(container, part, true);
    if (kind(part) === "ExitPlanMode") await renderPlan(app, container, part, component);
    if (["TodoWrite", "plan"].includes(kind(part))) renderTodos(container, part);
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

/** A Studio workflow's name from its vault path ("Poster" from "…/Poster.systemsculpt"). */
export function studioWorkflowName(path: string): string {
  return (path.split(/[\\/]/u).pop() ?? path).replace(/\.systemsculpt$/iu, "");
}

/** An image call with reference images edits them; the chat says so. */
export function editsImages(input: Record<string, unknown>): boolean {
  return Array.isArray(input.reference_images) && input.reference_images.some(path => typeof path === "string" && path.trim() !== "");
}

/** "image", or "3 images": what a batch saved once it finished, else what it asked for. */
export function imageCountTarget(part: AgentToolPart, input: Record<string, unknown>): string {
  const saved = part.state === "succeeded" ? decodeSystemSculptToolOutput(part.output?.data)?.media?.length : undefined;
  const count = saved || (typeof input.count === "number" ? input.count : 1);
  return count > 1 ? `${count} images` : "image";
}
