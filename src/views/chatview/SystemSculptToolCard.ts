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
    fields.push({ label: "Changes", value: `${args.edits.length} ${args.edits.length === 1 ? "edit" : "edits"}` });
  }
  const references = Array.isArray(args.reference_images) ? args.reference_images.filter((value): value is string => typeof value === "string") : [];
  for (const reference of references) fields.push({ label: "Reference", value: reference.split("/").pop() ?? reference, path: reference });
  for (const [key, label] of [["first_frame", "First frame"], ["last_frame", "Last frame"]] as const) {
    const frame = text(args[key]);
    if (frame) fields.push({ label, value: frame.split("/").pop() ?? frame, path: frame });
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
