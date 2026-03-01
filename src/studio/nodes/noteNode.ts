import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import {
  deriveStudioNoteTitleFromPath,
  readEnabledStudioNoteItems,
  type StudioNoteConfigItem,
} from "../StudioNoteConfig";

async function readNoteEntry(
  entry: StudioNoteConfigItem,
  context: Parameters<StudioNodeDefinition["execute"]>[0]
): Promise<{ text: string; path: string; title: string }> {
  const vaultPath = entry.path.trim();
  if (!vaultPath) {
    throw new Error("Note entry has no path.");
  }
  if (!vaultPath.toLowerCase().endsWith(".md")) {
    throw new Error(`Note node only supports markdown files. Received "${vaultPath}".`);
  }
  context.services.assertFilesystemPath(vaultPath);
  const text = await context.services.readVaultText(vaultPath);
  const title = deriveStudioNoteTitleFromPath(vaultPath) || vaultPath;
  return { text, path: vaultPath, title };
}

export const noteNode: StudioNodeDefinition = {
  kind: "studio.note",
  version: "1.0.0",
  capabilityClass: "local_io",
  cachePolicy: "never",
  inputPorts: [],
  outputPorts: [
    { id: "text", type: "text" },
    { id: "path", type: "text" },
    { id: "title", type: "text" },
  ],
  configDefaults: {
    notes: { items: [] },
  },
  configSchema: {
    fields: [
      {
        key: "notes",
        label: "Notes",
        type: "note_selector",
        required: true,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const enabledItems = readEnabledStudioNoteItems(context.node.config);
    if (enabledItems.length === 0) {
      throw new Error(`Note node "${context.node.id}" has no enabled notes.`);
    }

    const results = await Promise.all(
      enabledItems.map((entry) => readNoteEntry(entry, context))
    );

    if (results.length === 1) {
      return {
        outputs: {
          text: results[0].text,
          path: results[0].path,
          title: results[0].title,
        },
      };
    }

    return {
      outputs: {
        text: results.map((r) => r.text) as unknown as StudioJsonValue,
        path: results.map((r) => r.path) as unknown as StudioJsonValue,
        title: results.map((r) => r.title) as unknown as StudioJsonValue,
      },
    };
  },
};
