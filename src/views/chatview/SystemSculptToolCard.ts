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
  renderMedia,
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

  if (result?.media?.length) renderMedia(app, card, result.media);

  const fields: ToolCardField[] = [];
  const prompt = text(args.prompt);
  if (prompt) fields.push({ label: "Prompt", value: prompt });
  const workflow = text(args.path) ?? text(data.path);
  if (workflow && name.startsWith("studio_")) fields.push({ label: "Workflow", value: workflowName(workflow), path: workflow });
  if (name === "studio_create_workflow" && !workflow && text(args.name)) fields.push({ label: "Name", value: text(args.name)! });
  if (name === "studio_edit_workflow" && Array.isArray(args.edits)) {
    // Each change in words: what happened to which node or connection, and which setting.
    const changes = args.edits.flatMap((edit: unknown) => {
      if (!edit || typeof edit !== "object") return [];
      const { kind, entityId, path, remove, value } = edit as Record<string, unknown>;
      if (typeof entityId !== "string" || !entityId.trim()) return [];
      const verb = remove === true || kind === "delete" ? "Remove" : kind === "create" ? "Add" : kind === "restore" ? "Restore" : "Set";
      const entity = entityId.replace(/^(node|edge|group):/u, "");
      const setting = Array.isArray(path) ? path.filter((part): part is string => typeof part === "string").join(".") : "";
      const shown = verb === "Set" || verb === "Add" ? studioValue(value) : "";
      return [`${verb} ${entity}${setting && verb === "Set" ? ` · ${setting}` : ""}${shown ? `: ${shown}` : ""}`];
    });
    const shown = changes.slice(0, 8);
    if (changes.length > shown.length) shown.push(`${changes.length - shown.length} more`);
    fields.push({ label: "Changes", value: shown.length ? shown.join("\n") : `${args.edits.length} ${args.edits.length === 1 ? "edit" : "edits"}` });
  }
  const references = Array.isArray(args.reference_images) ? args.reference_images.filter((value): value is string => typeof value === "string") : [];
  // A reference reads by its name, as the saved files do ("lighthouse at dusk"); the link opens the file.
  for (const reference of references) fields.push({ label: "Reference", value: mediaDisplayName(reference), path: reference });
  for (const [key, label] of [["first_frame", "First frame"], ["last_frame", "Last frame"]] as const) {
    const frame = text(args[key]);
    if (frame) fields.push({ label, value: mediaDisplayName(frame), path: frame });
  }
  renderFields(app, card, fields);

  if (name === "studio_list_workflows" && Array.isArray(data.workflows)) {
    const rows = data.workflows.map(record).flatMap(entry => text(entry.path) ? [{ path: text(entry.path)!, text: workflowName(text(entry.path)!) }] : []);
    renderPathList(app, card, rows);
  }
  if (name === "studio_list_outputs" && Array.isArray(data.nodes)) {
    const files = data.nodes.map(record).flatMap(node => Array.isArray(node.files) ? node.files.map(record) : []);
    renderPathList(app, card, files.flatMap(file => text(file.path) ? [{ path: text(file.path)!, text: mediaDisplayName(text(file.path)!) }] : []));
  }

  if (result && !result.ok) {
    const message = personFacingMessage(result) || "SystemSculpt couldn't finish this.";
    renderNotice(card, result.link
      ? { tone: "warning", text: message, action: result.link }
      : { tone: "danger", text: message });
  } else if (result && (name === "studio_run_workflow" && !result.media?.length
    || name === "studio_list_workflows" && !Array.isArray(data.workflows)
    || name === "studio_list_outputs" && !Array.isArray(data.nodes))) {
    // Only outcomes the fields above don't already say ("Run completed.", "No Studio workflows yet.").
    const message = personFacingMessage(result);
    if (message) card.createDiv({ cls: "ss-tool-result", text: message });
  }
  if (!card.childElementCount && card !== host) card.remove();
  return true;
}

/** The requested value of a Studio edit, short enough for one line. */
function studioValue(value: unknown): string {
  const clip = (line: string) => line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  if (typeof value === "string") return value.trim() ? `“${clip(value.trim().replace(/\s+/gu, " "))}”` : "empty";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  // A new node or connection: its title and kind say what it is.
  const { title, kind, from, to } = value as Record<string, unknown>;
  if (typeof from === "string" && typeof to === "string") return `${from} to ${to}`;
  const name = typeof title === "string" && title.trim() ? title.trim() : "";
  const type = typeof kind === "string" ? kind.replace(/_/gu, " ") : "";
  return clip([name, type && name ? `(${type})` : type].filter(Boolean).join(" "));
}
