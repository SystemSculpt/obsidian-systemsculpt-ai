import type { App } from "obsidian";
import type { AgentToolPart } from "../../chat/ChatConversation";
import {
  decodeSystemSculptToolOutput,
  systemSculptToolName,
  type SystemSculptToolResult,
} from "../../tools/systemsculpt/SystemSculptTools";
import {
  createToolCard,
  renderFields,
  renderNotice,
  mediaDisplayName,
  renderPathList,
  type ToolCardField,
} from "./ToolCardBlocks";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A Codex dynamic call stores its whole item; the tool's own arguments sit inside it. */
export function systemSculptToolArguments(part: AgentToolPart): RecordValue {
  const input = record(part.input);
  return input.type === "dynamicToolCall" ? { ...input, ...record(input.arguments) } : input;
}

/**
 * What the person reads from a result message: the agent-only guidance after
 * it ("The chat already shows ...") and a link the card shows as its action stay out.
 */
export function personFacingMessage(result: SystemSculptToolResult): string {
  let message = result.message;
  if (result.link) message = message.split(`${result.link.label}:`)[0];
  return message.split(/\s*The chat already shows\b/u)[0].trim();
}

function workflowName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.systemsculpt$/iu, "");
}

/** The structured result data a SystemSculpt tool returned, when the saved output still has it. */
function resultData(output: unknown): RecordValue {
  const candidates = [output, ...(Array.isArray(output) ? output : []).map(item => record(item).text)];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? (() => { try { return JSON.parse(candidate) as unknown; } catch { return null; } })() : candidate;
    const data = record(record(value).data);
    if (Object.keys(data).length) return data;
  }
  return {};
}

const ROW_NAMES_WORKFLOW: ReadonlySet<string> = new Set([
  "studio_create_workflow", "studio_open_workflow", "studio_edit_workflow", "studio_run_workflow", "studio_list_outputs",
]);

/**
 * One card for generate_image, generate_video and the Studio tools, whichever
 * agent called them: thumbnails that open the vault file, the prompt or
 * workflow, and one calm line when the call stopped at a gate or failed.
 */
export function renderSystemSculptToolCard(app: App, host: HTMLElement, part: AgentToolPart): boolean {
  const name = systemSculptToolName(part.name);
  if (!name) return false;
  const args = systemSculptToolArguments(part);
  const finished = part.state === "succeeded" || part.state === "failed";
  const result = finished ? decodeSystemSculptToolOutput(part.output?.data) : null;
  const data = result ? resultData(part.output?.data) : {};
  const card = host.classList.contains("ss-tool-card") ? host : createToolCard(host, `systemsculpt:${name}`);
  card.dataset.card = `systemsculpt:${name}`;


  // The workflow first, then what was asked, then what came of it: one grid, one rhythm.
  const fields: ToolCardField[] = [];
  const workflow = text(args.path) ?? text(data.path);
  // A row that names its workflow ("Ran Poster workflow") links it there; its card doesn't say it again.
  if (workflow && name.startsWith("studio_") && !(ROW_NAMES_WORKFLOW.has(name) && text(args.path))) {
    fields.push({ label: "Workflow", value: workflowName(workflow), path: workflow });
  }
  if (name === "studio_create_workflow" && !workflow && text(args.name)) fields.push({ label: "Name", value: text(args.name)! });
  const prompt = text(args.prompt);
  if (prompt) fields.push({ label: "Prompt", value: prompt });
  if (name === "studio_edit_workflow" && Array.isArray(args.edits)) {
    // Each change as a result, in words, one per line.
    const changes = args.edits.flatMap((edit: unknown) => studioChange(edit) ?? []);
    const shown = changes.slice(0, 8);
    if (changes.length > shown.length) shown.push(`${changes.length - shown.length} more`);
    if (shown.length) fields.push({ label: "Changes", value: "", list: shown.map(change => ({ path: change, link: false })) });
    else fields.push({ label: "Changes", value: `${args.edits.length} ${args.edits.length === 1 ? "change" : "changes"}` });
  }
  const references = Array.isArray(args.reference_images) ? args.reference_images.filter((value): value is string => typeof value === "string") : [];
  // A reference reads by its name, as the saved files do ("lighthouse at dusk"); the link opens the file.
  for (const reference of references) fields.push({ label: "Reference", value: mediaDisplayName(reference), path: reference });
  for (const [key, label] of [["first_frame", "First frame"], ["last_frame", "Last frame"]] as const) {
    const frame = text(args[key]);
    if (frame) fields.push({ label, value: mediaDisplayName(frame), path: frame });
  }
  const outputs = name === "studio_list_outputs" && Array.isArray(data.nodes)
    ? data.nodes.map(record).flatMap(node => Array.isArray(node.files) ? node.files.map(record) : [])
      .flatMap(file => text(file.path) ? [{ path: text(file.path)!, text: mediaDisplayName(text(file.path)!) }] : [])
    : [];
  const workflows = name === "studio_list_workflows" && Array.isArray(data.workflows)
    ? data.workflows.map(record).flatMap(entry => text(entry.path) ? [{ path: text(entry.path)!, text: workflowName(text(entry.path)!) }] : [])
    : [];
  // Only outcomes nothing else here says ("Run completed.", "No Studio workflows yet.").
  const outcome = result?.ok && (name === "studio_run_workflow" && !result.media?.length
    || name === "studio_list_workflows" && !workflows.length
    || name === "studio_list_outputs" && !outputs.length) ? personFacingMessage(result) : "";
  // A result beside other fields gets its label, so it never reads as one.
  if (outcome && fields.length) fields.push({ label: "Result", value: outcome });
  renderFields(app, card, fields);
  if (outcome && !fields.length) card.createDiv({ cls: "ss-tool-result", text: outcome });
  // A list's results stand bare at the text edge, workflows and outputs alike: the row says what they are.
  renderPathList(app, card, workflows);
  renderPathList(app, card, outputs);

  if (result && !result.ok) {
    const message = personFacingMessage(result) || "SystemSculpt couldn't finish this.";
    // A plan or credits stop, in the words systemSculptGateNeed reads (saved chats keep the older words).
    const gate = ["See plans", "Subscribe", "Add credits", "Buy credits"].includes(result.link?.label ?? "");
    const notice = renderNotice(card, result.link
      ? { tone: gate ? "gate" : "warning", text: message, action: result.link }
      : { tone: "danger", text: message });
    // A failed picture or video says why on its own tile in the reply; the card then doesn't repeat it.
    if (!result.link) notice.setAttribute("data-media-failure", part.callId);
  }
  if (!card.childElementCount && card !== host) card.remove();
  return true;
}

/** "Poster image", "Prompt": a Studio node as the person reads it, never its node:/edge: id. */
function studioNodeName(id: string): string {
  const words = id.replace(/^(?:node|edge|group):/u, "").replace(/[_-]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "A step";
}

/**
 * One Studio edit as its result, in words: "Prompt set to “A lighthouse at dusk”",
 * "Added Poster image", "Connected Prompt to Img". No field paths, ids or node kinds.
 */
function studioChange(edit: unknown): string | null {
  if (!edit || typeof edit !== "object") return null;
  const { kind, entityId, path, remove, value } = edit as Record<string, unknown>;
  if (typeof entityId !== "string" || !entityId.trim()) return null;
  const clip = (line: string) => line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  const connection = entityId.startsWith("edge:");
  const node = studioNodeName(entityId);
  const details = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (remove === true || kind === "delete") return connection ? "Removed a connection" : `Removed ${node}`;
  if (kind === "restore") return connection ? "Restored a connection" : `Restored ${node}`;
  if (kind === "create") {
    if (typeof details.from === "string" && typeof details.to === "string") return `Connected ${studioNodeName(details.from)} to ${studioNodeName(details.to)}`;
    const title = typeof details.title === "string" && details.title.trim() ? clip(details.title.trim()) : "";
    const type = typeof details.kind === "string" ? details.kind.replace(/_/gu, " ") : "";
    return `Added ${title || (type ? `${type} step` : connection ? "a connection" : node)}`;
  }
  // The setting by its own name ("model"); a node's main value is just the node ("Prompt").
  const setting = (Array.isArray(path) ? path.filter((part): part is string => typeof part === "string") : [])
    .filter(part => part !== "config").pop();
  const subject = setting && setting !== "value" ? `${node} ${setting.replace(/[_-]+/gu, " ")}` : node;
  if (typeof value === "string") return value.trim() ? `${subject} set to “${clip(value.trim().replace(/\s+/gu, " "))}”` : `${subject} cleared`;
  if (typeof value === "number" || typeof value === "boolean") return `${subject} set to ${String(value)}`;
  return `Changed ${subject}`;
}
