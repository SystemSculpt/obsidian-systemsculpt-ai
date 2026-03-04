import type { StudioJsonValue, StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import { formatNodeConfigPreview, prettifyNodeKind } from "../StudioViewHelpers";
import {
  coerceNotePreviewText,
  coercePromptBundleText,
  readFirstTextValue,
  wrapPromptBundleFence,
} from "./StudioPromptBundleUtils";

export type StudioPromptBundleSource = {
  content: string;
  contentLanguage: string;
  sourceLabel: string;
  vaultPath: string;
};

export async function resolvePromptBundleNodeSource(options: {
  node: StudioNodeInstance;
  runtimePath: StudioJsonValue | undefined;
  runtimeText: unknown;
  configuredNotePath: string;
  readConfiguredNoteText: (path: string) => Promise<{ text: string; path: string } | null>;
}): Promise<StudioPromptBundleSource> {
  const { node, runtimePath, runtimeText, configuredNotePath, readConfiguredNoteText } = options;
  if (node.kind === "studio.note") {
    const noteText = coerceNotePreviewText(runtimeText, runtimePath);
    const resolvedPath = readFirstTextValue(runtimePath);
    if (noteText) {
      return {
        content: noteText,
        contentLanguage: "markdown",
        sourceLabel: "live note preview",
        vaultPath: resolvedPath,
      };
    }

    if (configuredNotePath) {
      const configuredNote = await readConfiguredNoteText(configuredNotePath);
      if (configuredNote?.text) {
        return {
          content: configuredNote.text,
          contentLanguage: "markdown",
          sourceLabel: "vault note",
          vaultPath: configuredNote.path,
        };
      }
    }

    return {
      content: "(Note preview is empty. Run or refresh note links.)",
      contentLanguage: "markdown",
      sourceLabel: "note preview",
      vaultPath: configuredNotePath,
    };
  }

  const runtimeTextValue = typeof runtimeText === "string" ? runtimeText.trim() : "";
  if (runtimeTextValue) {
    return {
      content: runtimeTextValue,
      contentLanguage: "text",
      sourceLabel: "latest node output",
      vaultPath: "",
    };
  }

  const configValueText = coercePromptBundleText((node.config as Record<string, unknown>).value);
  if (configValueText) {
    return {
      content: configValueText,
      contentLanguage: "text",
      sourceLabel: "node config value",
      vaultPath: "",
    };
  }

  const configPreview = formatNodeConfigPreview(node).trim();
  return {
    content: configPreview || "(No text content available for this source node yet.)",
    contentLanguage: "text",
    sourceLabel: "node config preview",
    vaultPath: "",
  };
}

export async function composeTextGenerationPromptBundle(options: {
  project: StudioProjectV1;
  targetNodeId: string;
  resolveSource: (node: StudioNodeInstance) => Promise<StudioPromptBundleSource>;
  generatedAt: Date;
}): Promise<
  | {
      ok: true;
      sourceCount: number;
      markdown: string;
    }
  | {
      ok: false;
      reason: "target_not_text_generation";
    }
> {
  const { project, targetNodeId, resolveSource, generatedAt } = options;
  const targetNode = project.graph.nodes.find((node) => node.id === targetNodeId);
  if (!targetNode || targetNode.kind !== "studio.text_generation") {
    return {
      ok: false,
      reason: "target_not_text_generation",
    };
  }

  const sourceNodeById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
  const promptEdges = project.graph.edges.filter(
    (edge) => edge.toNodeId === targetNodeId && edge.toPortId === "prompt"
  );
  const seenSourceIds = new Set<string>();
  const sourceSections: string[] = [];

  for (const edge of promptEdges) {
    const sourceNodeId = String(edge.fromNodeId || "").trim();
    if (!sourceNodeId || seenSourceIds.has(sourceNodeId)) {
      continue;
    }
    seenSourceIds.add(sourceNodeId);
    const sourceNode = sourceNodeById.get(sourceNodeId);
    if (!sourceNode) {
      continue;
    }

    const sourceIndex = sourceSections.length + 1;
    const sourceKind = sourceNode.kind === "studio.note" ? "Note" : prettifyNodeKind(sourceNode.kind);
    const sourceTitle = String(sourceNode.title || sourceKind).trim() || sourceKind;
    const source = await resolveSource(sourceNode);
    const sectionLines: string[] = [
      `### Source ${sourceIndex}: ${sourceKind} - ${sourceTitle}`,
      `- Node ID: \`${sourceNode.id}\``,
      `- Kind: \`${sourceNode.kind}\``,
      `- Content Source: ${source.sourceLabel}`,
    ];
    if (source.vaultPath) {
      sectionLines.push(`- Vault Path: \`${source.vaultPath}\``);
    }
    sectionLines.push("", wrapPromptBundleFence(source.contentLanguage, source.content), "");
    sourceSections.push(sectionLines.join("\n"));
  }

  const systemPrompt = String(targetNode.config.systemPrompt || "").trim();
  const bundleLines: string[] = [
    "# Studio Text Generation Handoff",
    "",
    `Generated: ${generatedAt.toISOString()}`,
    `Target Node: ${String(targetNode.title || targetNode.kind).trim() || targetNode.kind}`,
    `Target Node ID: \`${targetNode.id}\``,
    "",
    "## Attached Prompt Sources",
    "",
  ];
  if (sourceSections.length === 0) {
    bundleLines.push("_No prompt-linked source nodes found._", "");
  } else {
    bundleLines.push(...sourceSections);
  }
  bundleLines.push(
    "## System Prompt",
    "",
    wrapPromptBundleFence("text", systemPrompt || "(System prompt is empty.)"),
    ""
  );

  return {
    ok: true,
    sourceCount: sourceSections.length,
    markdown: bundleLines.join("\n"),
  };
}
