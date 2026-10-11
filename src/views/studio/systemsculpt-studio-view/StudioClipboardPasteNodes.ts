import type {
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import { estimateStudioFillTextMeasure, studioFillTextBoxAt } from "../../../studio/StudioFillText";
import {
  STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
  STUDIO_TEXT_NODE_FILL_LAYOUT,
  STUDIO_TEXT_NODE_LAYOUT_KEY,
} from "../../../studio/StudioNodeGeometry";

const LABEL_MAX_LINES = 6;
const LABEL_MAX_LINE_LENGTH = 48;
const LABEL_FONT_PX = 24;
const MARKDOWN_BLOCK = /^ {0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/m;
// Nothing is laid out yet, so the box allows a generous width for each character.
const estimateWidth = estimateStudioFillTextMeasure(0.6);

/**
 * A few short lines are a label: they paste as text that fills its box. A
 * passage needs to wrap, and Markdown needs rendering, so both paste as a
 * Markdown text card. Returns the label as it will be stored, or null.
 */
function readPastedLabel(text: string): string | null {
  const label = text.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  const lines = label.split("\n");
  const fits = label.length > 0
    && lines.length <= LABEL_MAX_LINES
    && lines.every((line) => line.length <= LABEL_MAX_LINE_LENGTH)
    && !MARKDOWN_BLOCK.test(label);
  return fits ? label : null;
}

export function buildPastedTextNode(options: {
  textNodeDefinition: StudioNodeDefinition;
  text: string;
  position: { x: number; y: number };
  nextNodeId: () => string;
  prettifyNodeKind: (kind: string) => string;
  cloneConfigDefaults: (definition: StudioNodeDefinition) => Record<string, unknown>;
  normalizeNodePosition: (position: { x: number; y: number }) => { x: number; y: number };
}): StudioNodeInstance {
  const {
    textNodeDefinition,
    text,
    position,
    nextNodeId,
    prettifyNodeKind,
    cloneConfigDefaults,
    normalizeNodePosition,
  } = options;
  const label = readPastedLabel(text);
  if (label !== null) {
    const box = studioFillTextBoxAt(estimateWidth, { text: label, style: "plain" }, LABEL_FONT_PX);
    return {
      id: nextNodeId(),
      kind: textNodeDefinition.kind,
      version: textNodeDefinition.version,
      title: prettifyNodeKind(textNodeDefinition.kind),
      position: normalizeNodePosition(position),
      size: { width: Math.ceil(box.width), height: Math.ceil(box.height) },
      config: {
        ...cloneConfigDefaults(textNodeDefinition),
        [STUDIO_TEXT_NODE_LAYOUT_KEY]: STUDIO_TEXT_NODE_FILL_LAYOUT,
        value: label,
      },
      continueOnError: false,
      disabled: false,
    };
  }
  return {
    id: nextNodeId(),
    kind: textNodeDefinition.kind,
    version: textNodeDefinition.version,
    title: prettifyNodeKind(textNodeDefinition.kind),
    position: normalizeNodePosition(position),
    // Paste-sizing: width + content only. Text-node height is intrinsic —
    // the card reflows to the pasted content, so no height is persisted.
    size: {
      width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
    },
    config: {
      ...cloneConfigDefaults(textNodeDefinition),
      value: text,
    },
    continueOnError: false,
    disabled: false,
  };
}

export function buildMediaIngestNode(options: {
  mediaDefinition: StudioNodeDefinition;
  sourcePath: string;
  anchor: { x: number; y: number };
  index: number;
  nextNodeId: () => string;
  normalizeNodePosition: (position: { x: number; y: number }) => { x: number; y: number };
  prettifyNodeKind: (kind: string) => string;
  cloneConfigDefaults: (definition: StudioNodeDefinition) => Record<string, unknown>;
}): StudioNodeInstance {
  const {
    mediaDefinition,
    sourcePath,
    anchor,
    index,
    nextNodeId,
    normalizeNodePosition,
    prettifyNodeKind,
    cloneConfigDefaults,
  } = options;
  return {
    id: nextNodeId(),
    kind: mediaDefinition.kind,
    version: mediaDefinition.version,
    title: prettifyNodeKind(mediaDefinition.kind),
    position: normalizeNodePosition({
      x: anchor.x + (index % 5) * 38,
      y: anchor.y + Math.floor(index / 5) * 38,
    }),
    config: {
      ...cloneConfigDefaults(mediaDefinition),
      sourcePath,
    },
    continueOnError: false,
    disabled: false,
  };
}

export async function materializePastedMediaNodes(options: {
  mediaFiles: File[];
  mediaDefinition: StudioNodeDefinition;
  anchor: { x: number; y: number };
  projectPath: string;
  nextNodeId: () => string;
  normalizeNodePosition: (position: { x: number; y: number }) => { x: number; y: number };
  normalizeMimeType: (rawMimeType: string) => string;
  storeAsset: (projectPath: string, bytes: ArrayBuffer, mimeType: string) => Promise<{ path: string }>;
  prettifyNodeKind: (kind: string) => string;
  cloneConfigDefaults: (definition: StudioNodeDefinition) => Record<string, unknown>;
}): Promise<StudioNodeInstance[]> {
  const {
    mediaFiles,
    mediaDefinition,
    anchor,
    projectPath,
    nextNodeId,
    normalizeNodePosition,
    normalizeMimeType,
    storeAsset,
    prettifyNodeKind,
    cloneConfigDefaults,
  } = options;

  const output: StudioNodeInstance[] = [];
  for (let index = 0; index < mediaFiles.length; index += 1) {
    const mediaFile = mediaFiles[index];
    const mimeType = normalizeMimeType(mediaFile.type);
    const bytes = await mediaFile.arrayBuffer();
    const asset = await storeAsset(projectPath, bytes, mimeType);
    output.push(
      buildMediaIngestNode({
        mediaDefinition,
        sourcePath: asset.path,
        anchor,
        index,
        nextNodeId,
        normalizeNodePosition,
        prettifyNodeKind,
        cloneConfigDefaults,
      })
    );
  }

  return output;
}
