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

export async function materializePastedMediaNodes(options: {
  imageFiles: File[];
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
    imageFiles,
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
  for (let index = 0; index < imageFiles.length; index += 1) {
    const imageFile = imageFiles[index];
    const mimeType = normalizeMimeType(imageFile.type);
    const bytes = await imageFile.arrayBuffer();
    const asset = await storeAsset(projectPath, bytes, mimeType);
    output.push({
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
        sourcePath: asset.path,
      },
      continueOnError: false,
      disabled: false,
    });
  }

  return output;
}
