import type {
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";

export function buildPastedTextNode(options: {
  textDefinition: StudioNodeDefinition;
  text: string;
  position: { x: number; y: number };
  nextNodeId: () => string;
  prettifyNodeKind: (kind: string) => string;
  cloneConfigDefaults: (definition: StudioNodeDefinition) => Record<string, unknown>;
  normalizeNodePosition: (position: { x: number; y: number }) => { x: number; y: number };
}): StudioNodeInstance {
  const {
    textDefinition,
    text,
    position,
    nextNodeId,
    prettifyNodeKind,
    cloneConfigDefaults,
    normalizeNodePosition,
  } = options;
  return {
    id: nextNodeId(),
    kind: textDefinition.kind,
    version: textDefinition.version,
    title: prettifyNodeKind(textDefinition.kind),
    position: normalizeNodePosition(position),
    config: {
      ...cloneConfigDefaults(textDefinition),
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
