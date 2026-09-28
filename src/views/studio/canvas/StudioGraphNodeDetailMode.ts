import type { StudioNodeInstance } from "../../../studio/types";

export type StudioNodeDetailMode = "expanded" | "collapsed";
export type StudioCollapsedDetailSection = "textEditor" | "systemPrompt" | "outputPreview" | "fieldHelp";

export const STUDIO_NODE_DETAIL_DEFAULT_MODE: StudioNodeDetailMode = "expanded";
export const STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY = "__studioCollapsedVisibility";

const ALL_COLLAPSED_DETAIL_SECTIONS: StudioCollapsedDetailSection[] = [
  "textEditor",
  "systemPrompt",
  "outputPreview",
  "fieldHelp",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeStudioNodeDetailMode(value: unknown): StudioNodeDetailMode {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "collapsed" ? "collapsed" : STUDIO_NODE_DETAIL_DEFAULT_MODE;
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
      parsed[section] = raw[section];
    }
  }
  return parsed;
}

function readStudioCollapsedSectionVisibilityOverride(
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
  return false;
}
