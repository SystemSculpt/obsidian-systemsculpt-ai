import type { StudioNodeInstance } from "../../../studio/types";

export type StudioNodeDetailMode = "expanded" | "collapsed";
export type StudioCollapsedDetailSection = "textEditor" | "systemPrompt" | "outputPreview" | "fieldHelp";

export const STUDIO_NODE_DETAIL_DEFAULT_MODE: StudioNodeDetailMode = "expanded";
export const STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY = "__studioCollapsedVisibility";

const INLINE_TEXT_NODE_KINDS = new Set<string>([
  "studio.note",
  "studio.text",
  "studio.text_generation",
  "studio.transcription",
]);

const SECTION_LABELS: Record<StudioCollapsedDetailSection, { shortLabel: string; summary: string }> = {
  textEditor: {
    shortLabel: "Text",
    summary: "Inline text/transcript body",
  },
  systemPrompt: {
    shortLabel: "Prompt",
    summary: "System prompt field",
  },
  outputPreview: {
    shortLabel: "Output",
    summary: "Latest output preview surfaces",
  },
  fieldHelp: {
    shortLabel: "Help",
    summary: "Field descriptions/help copy",
  },
};

const DEFAULT_COLLAPSED_SECTION_VISIBILITY: Record<StudioCollapsedDetailSection, boolean> = {
  textEditor: false,
  systemPrompt: false,
  outputPreview: false,
  fieldHelp: false,
};

const ALL_COLLAPSED_DETAIL_SECTIONS: StudioCollapsedDetailSection[] = [
  "textEditor",
  "systemPrompt",
  "outputPreview",
  "fieldHelp",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNodeKind(kind: string): string {
  return String(kind || "").trim();
}

export function normalizeStudioNodeDetailMode(value: unknown): StudioNodeDetailMode {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "collapsed" ? "collapsed" : STUDIO_NODE_DETAIL_DEFAULT_MODE;
}

export function listStudioCollapsedDetailSections(): StudioCollapsedDetailSection[] {
  return ALL_COLLAPSED_DETAIL_SECTIONS.slice();
}

export function resolveStudioCollapsedSectionLabel(
  section: StudioCollapsedDetailSection
): { shortLabel: string; summary: string } {
  return SECTION_LABELS[section];
}

export function resolveStudioCollapsedSectionDefaultVisibility(
  section: StudioCollapsedDetailSection
): boolean {
  return DEFAULT_COLLAPSED_SECTION_VISIBILITY[section];
}

export function isStudioCollapsedSectionApplicableToNode(
  node: Pick<StudioNodeInstance, "kind">,
  section: StudioCollapsedDetailSection
): boolean {
  const kind = normalizeNodeKind(node.kind);
  if (kind === "studio.label") {
    return false;
  }
  if (section === "systemPrompt") {
    return kind === "studio.text_generation";
  }
  if (section === "textEditor") {
    return INLINE_TEXT_NODE_KINDS.has(kind);
  }
  return true;
}

export function readStudioNodeCollapsedVisibilityOverrides(
  node: Pick<StudioNodeInstance, "config">
): Partial<Record<StudioCollapsedDetailSection, boolean>> {
  const config = node.config as Record<string, unknown>;
  const raw = config[STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY];
  if (!isRecord(raw)) {
    return {};
  }
  const parsed: Partial<Record<StudioCollapsedDetailSection, boolean>> = {};
  for (const section of ALL_COLLAPSED_DETAIL_SECTIONS) {
    if (typeof raw[section] === "boolean") {
      parsed[section] = raw[section] as boolean;
    }
  }
  return parsed;
}

export function readStudioCollapsedSectionVisibilityOverride(
  node: Pick<StudioNodeInstance, "config">,
  section: StudioCollapsedDetailSection
): boolean | undefined {
  const overrides = readStudioNodeCollapsedVisibilityOverrides(node);
  return overrides[section];
}

export function resolveStudioNodeDetailSectionVisibility(options: {
  node: Pick<StudioNodeInstance, "kind" | "config">;
  mode: StudioNodeDetailMode;
  section: StudioCollapsedDetailSection;
}): boolean {
  const { node, mode, section } = options;
  if (mode !== "collapsed") {
    return true;
  }
  const override = readStudioCollapsedSectionVisibilityOverride(node, section);
  if (typeof override === "boolean") {
    return override;
  }
  return resolveStudioCollapsedSectionDefaultVisibility(section);
}

export function writeStudioCollapsedSectionVisibilityOverride(options: {
  node: Pick<StudioNodeInstance, "config">;
  section: StudioCollapsedDetailSection;
  visibleInCollapsed: boolean;
}): boolean {
  const { node, section, visibleInCollapsed } = options;
  const config = node.config as Record<string, unknown>;
  const currentRaw = config[STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY];
  const previousOverrides = isRecord(currentRaw)
    ? (currentRaw as Record<string, unknown>)
    : {};
  const nextOverrides: Record<string, unknown> = { ...previousOverrides };
  const defaultVisibility = resolveStudioCollapsedSectionDefaultVisibility(section);
  if (visibleInCollapsed === defaultVisibility) {
    delete nextOverrides[section];
  } else {
    nextOverrides[section] = visibleInCollapsed;
  }

  const normalized: Record<string, boolean> = {};
  for (const candidate of ALL_COLLAPSED_DETAIL_SECTIONS) {
    if (typeof nextOverrides[candidate] === "boolean") {
      normalized[candidate] = nextOverrides[candidate] as boolean;
    }
  }

  const hadConfig = isRecord(currentRaw);
  const beforeSerialized = hadConfig ? JSON.stringify(currentRaw) : "";
  if (Object.keys(normalized).length === 0) {
    if (!hadConfig) {
      return false;
    }
    delete config[STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY];
    return true;
  }

  const afterSerialized = JSON.stringify(normalized);
  if (beforeSerialized === afterSerialized) {
    return false;
  }
  config[STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY] = normalized;
  return true;
}
