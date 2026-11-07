/**
 * SystemSculpt tools every chat agent can call: hosted image and video
 * generation (subscription features, billed as credits by the hosted media
 * APIs) and Studio workflow management in this vault. One catalog serves every
 * execution backend; each backend only changes how the definitions reach the
 * agent and how a call comes back.
 */

export const SYSTEMSCULPT_TOOL_NAMES = [
  "generate_image",
  "generate_video",
  "studio_list_workflows",
  "studio_create_workflow",
  "studio_open_workflow",
  "studio_edit_workflow",
  "studio_run_workflow",
  "studio_list_outputs",
] as const;

export type SystemSculptToolName = typeof SYSTEMSCULPT_TOOL_NAMES[number];

export type SystemSculptToolDefinition = Readonly<{
  name: SystemSculptToolName;
  title: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  /** Reads only; changes no vault file and spends no credits. */
  readOnly: boolean;
}>;

export type SystemSculptMedia = Readonly<{
  kind: "image" | "video";
  /** Vault-relative path of the saved file. */
  path: string;
  mimeType?: string;
}>;

/** What a call returns to the agent and what Chat renders from the saved tool output. */
export type SystemSculptToolResult = Readonly<{
  ok: boolean;
  message: string;
  media?: readonly SystemSculptMedia[];
  /** One first-party next step, e.g. Subscribe when the account has no subscription. */
  link?: Readonly<{ label: string; url: string }>;
  data?: unknown;
}>;

/** The call bridge each execution backend uses. */
export type SystemSculptToolset = Readonly<{
  definitions: readonly SystemSculptToolDefinition[];
  call: (name: string, args: unknown, signal: AbortSignal) => Promise<SystemSculptToolResult>;
}>;

/** Claude Code names a bridged tool `mcp__<server>__<tool>`; this is the server part. */
export const SYSTEMSCULPT_TOOL_SERVER = "systemsculpt";

const string = (description: string) => ({ type: "string", description });
const vaultPaths = (description: string, maxItems: number) => ({ type: "array", items: { type: "string" }, maxItems, description });
const workflowPath = string("Vault path of the Studio workflow (.systemsculpt file), e.g. \"SystemSculpt/Studio/Poster.systemsculpt\".");

export const SYSTEMSCULPT_TOOLS: readonly SystemSculptToolDefinition[] = Object.freeze([
  {
    name: "generate_image",
    title: "Generate image",
    readOnly: false,
    description: "Generate images with SystemSculpt (a SystemSculpt subscription feature, billed in credits) and save them to the vault. The images show inline in this chat. Returns their vault paths. Use reference_images to edit or restyle existing vault images.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: string("What to draw, in plain words: subject, style, composition, text to render."),
        aspect_ratio: string("Optional, e.g. \"1:1\", \"16:9\", \"9:16\", \"4:3\"."),
        count: { type: "integer", minimum: 1, maximum: 4, description: "How many images, 1-4. Default 1." },
        quality: string("Optional model quality, e.g. \"high\"."),
        background: string("Optional, e.g. \"transparent\" for a cut-out PNG."),
        model: string("Optional SystemSculpt image model ID. Omit for the default."),
        reference_images: vaultPaths("Optional vault paths of PNG, JPEG or WebP images to edit or use as references.", 4),
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_video",
    title: "Generate video",
    readOnly: false,
    description: "Generate a short video with SystemSculpt (a SystemSculpt subscription feature, billed in credits) and save it to the vault. The video shows inline in this chat. Takes a few minutes. Returns its vault path.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: string("The shot: subject, motion, camera, style, sound."),
        duration_seconds: { type: "integer", minimum: 1, maximum: 60, description: "Optional length; snapped to what the model supports." },
        aspect_ratio: string("Optional, e.g. \"16:9\" or \"9:16\"."),
        resolution: string("Optional, e.g. \"720p\" or \"1080p\"."),
        generate_audio: { type: "boolean", description: "Optional; models that support sound add it." },
        model: string("Optional SystemSculpt video model ID. Omit for the default."),
        first_frame: string("Optional vault path of an image to start from."),
        last_frame: string("Optional vault path of an image to end on."),
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_list_workflows",
    title: "List Studio workflows",
    readOnly: true,
    description: "List the SystemSculpt Studio workflows (.systemsculpt files) in this vault, with the path of the reference that documents the canvas format and node kinds.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "studio_create_workflow",
    title: "Create Studio workflow",
    readOnly: false,
    description: "Create an empty SystemSculpt Studio workflow in the vault. Returns its path and revision; add nodes with studio_edit_workflow.",
    inputSchema: {
      type: "object",
      properties: {
        name: string("Workflow name, e.g. \"Product poster\"."),
        path: string("Optional vault path ending in .systemsculpt. Omit to use the Studio folder."),
        show: { type: "boolean", description: "Open it in Studio for the person. Default true." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_open_workflow",
    title: "Open Studio workflow",
    readOnly: true,
    description: "Read a Studio workflow: its canvas JSON, entity IDs and current revision for studio_edit_workflow. Set show to also open it in Studio for the person.",
    inputSchema: {
      type: "object",
      properties: { path: workflowPath, show: { type: "boolean", description: "Open it in Studio for the person. Default false." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_edit_workflow",
    title: "Edit Studio workflow",
    readOnly: false,
    description: "Apply a batch of edits to a Studio workflow, based on the revision from studio_open_workflow. Each edit is kind set, create, delete or restore with an entityId, an optional path (string array) inside that entity, a value, and remove to clear a field. Changes made since that revision merge by field; a conflicting batch is rejected, so read again. Returns the new revision.",
    inputSchema: {
      type: "object",
      properties: {
        path: workflowPath,
        revision: string("Revision returned by studio_open_workflow or the previous edit."),
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set", "create", "delete", "restore"] },
              entityId: { type: "string" },
              path: { type: "array", items: { type: "string" } },
              value: {},
              remove: { type: "boolean" },
            },
            required: ["kind", "entityId"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "revision", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_run_workflow",
    title: "Run Studio workflow",
    readOnly: false,
    description: "Run a Studio workflow, or one node and what it needs, and wait for the result. Hosted nodes bill credits. Generated images and videos show inline in this chat. Returns the run status and each node's outputs.",
    inputSchema: {
      type: "object",
      properties: { path: workflowPath, node_id: string("Optional node ID to run with only its upstream nodes.") },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_list_outputs",
    title: "List Studio outputs",
    readOnly: true,
    description: "List a Studio workflow's latest node outputs and saved files (vault paths), plus its recent runs.",
    inputSchema: {
      type: "object",
      properties: { path: workflowPath },
      required: ["path"],
      additionalProperties: false,
    },
  },
] satisfies SystemSculptToolDefinition[]);

const NAMES: ReadonlySet<string> = new Set(SYSTEMSCULPT_TOOL_NAMES);
const BRIDGED_PREFIX = `mcp__${SYSTEMSCULPT_TOOL_SERVER}__`;

/** The catalog name behind a native tool name, or null for any other tool. */
export function systemSculptToolName(nativeName: unknown): SystemSculptToolName | null {
  if (typeof nativeName !== "string") return null;
  const name = nativeName.startsWith(BRIDGED_PREFIX) ? nativeName.slice(BRIDGED_PREFIX.length) : nativeName;
  return NAMES.has(name) ? name as SystemSculptToolName : null;
}

const MARKER = "systemsculpt_tool";

/** The text an agent receives. The marker lets Chat find media in a saved tool output. */
export function encodeSystemSculptToolResult(result: SystemSculptToolResult): string {
  return JSON.stringify({ [MARKER]: 1, ...result });
}

function decodeText(text: string): SystemSculptToolResult | null {
  if (!text.includes(MARKER)) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || value[MARKER] !== 1 || typeof value.message !== "string") return null;
    const media = Array.isArray(value.media) ? value.media.flatMap((item): SystemSculptMedia[] => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      if ((entry.kind !== "image" && entry.kind !== "video") || typeof entry.path !== "string" || !entry.path.trim()) return [];
      return [{ kind: entry.kind, path: entry.path, ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}) }];
    }) : [];
    const link = value.link && typeof value.link === "object" ? value.link as Record<string, unknown> : null;
    const safeLink = link && typeof link.label === "string" && link.label.length <= 40 && typeof link.url === "string"
      && /^https:\/\/(www\.)?systemsculpt\.com\//.test(link.url) ? { label: link.label, url: link.url } : undefined;
    return { ok: value.ok === true, message: value.message, ...(media.length ? { media } : {}), ...(safeLink ? { link: safeLink } : {}) };
  } catch {
    return null;
  }
}

/**
 * Finds the result inside a tool output as each backend saves it: the text
 * itself, Claude Code's content blocks, Codex's content items, or a hosted
 * result object.
 */
export function decodeSystemSculptToolOutput(output: unknown, depth = 0): SystemSculptToolResult | null {
  if (depth > 3 || output == null) return null;
  if (typeof output === "string") return decodeText(output);
  if (Array.isArray(output)) {
    for (const item of output) {
      const decoded = decodeSystemSculptToolOutput(item, depth + 1);
      if (decoded) return decoded;
    }
    return null;
  }
  if (typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  if (record[MARKER] === 1) return decodeText(JSON.stringify(record));
  for (const key of ["text", "content", "contentItems", "data", "result"]) {
    const decoded = decodeSystemSculptToolOutput(record[key], depth + 1);
    if (decoded) return decoded;
  }
  return null;
}
